import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { X, Loader2, AlertTriangle } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import { LoupePreview, LoupeSlot, useLoupeStore } from '../../../store/useLoupeStore';
import { useSettingsStore } from '../../../store/useSettingsStore';
import {
  getClientPointFromNormalizedObjectFit,
  getImageTargetGeometry,
  getNormalizedPointFromObjectFit,
  pointsDiffer,
  rectsDiffer,
} from '../../../utils/imageCoordinateUtils';
import {
  LOUPE_TIP_SIZE,
  chooseLoupeSlotForTip,
  chooseNextAvailableLoupeSlot,
  clampPointToRect,
  getLoupeWindowRect,
  getLoupePositionForTip,
  getLoupeSafeBounds,
  getLoupeSlotForOverdrag,
  getLoupeTipCorner,
  RectLike,
} from '../../../utils/loupePlacement';
import { loadLoupeTile } from '../../../utils/loupeTileLoader';
import { getLoupeTileImageStyle, isLoupeTileUsable } from '../../../utils/loupeTile';
import { normalizeLoupeRenderArea } from '../../../utils/loupeRenderArea';

const MIN_LOUPE_ZOOM = 0.5;
const MAX_LOUPE_ZOOM = 4;
const LOUPE_ZOOM_STEP = 1.25;
const LOUPE_RENDER_DEBOUNCE_MS = 180;
const LOUPE_ZOOM_INDICATOR_HIDE_DELAY_MS = 900;
const LOUPE_TIP_VIEWBOX_SIZE = 24;
const LOUPE_TIP_SVG_SIZE = 22;
const LOUPE_TIP_OVERHANG = LOUPE_TIP_SIZE;
const LOUPE_SLOT_SWITCH_DURATION_MS = 70;
const LOUPE_SLOT_SWITCH_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';

function formatZoom(zoom: number) {
  return `${Math.round(zoom * 100)}%`;
}

function getNextLoupeZoom(currentZoom: number, direction: 1 | -1) {
  const rawNextZoom = currentZoom * (direction > 0 ? LOUPE_ZOOM_STEP : 1 / LOUPE_ZOOM_STEP);
  if ((currentZoom < 1 && rawNextZoom > 1) || (currentZoom > 1 && rawNextZoom < 1)) return 1;
  return Math.max(MIN_LOUPE_ZOOM, Math.min(MAX_LOUPE_ZOOM, rawNextZoom));
}

function getLoupeSourceSizeForZoom(viewportHeight: number, zoom: number) {
  return Math.max(1, viewportHeight) / Math.max(MIN_LOUPE_ZOOM, zoom);
}

function getTipSvgStyle(slot: LoupeSlot): React.CSSProperties {
  const shared: React.CSSProperties = {
    width: LOUPE_TIP_SVG_SIZE,
    height: LOUPE_TIP_SVG_SIZE,
    zIndex: 0,
  };

  switch (getLoupeTipCorner(slot)) {
    case 'bottom-right':
      return { ...shared, right: -LOUPE_TIP_OVERHANG + 1, bottom: -LOUPE_TIP_OVERHANG + 1 };
    case 'bottom-left':
      return { ...shared, left: -LOUPE_TIP_OVERHANG + 1, bottom: -LOUPE_TIP_OVERHANG + 1 };
    case 'top-right':
      return { ...shared, right: -LOUPE_TIP_OVERHANG + 1, top: -LOUPE_TIP_OVERHANG + 1 };
    case 'top-left':
    default:
      return { ...shared, left: -LOUPE_TIP_OVERHANG + 1, top: -LOUPE_TIP_OVERHANG + 1 };
  }
}

function getTipSvgTransform(slot: LoupeSlot) {
  switch (getLoupeTipCorner(slot)) {
    case 'top-right':
      return `translate(${LOUPE_TIP_VIEWBOX_SIZE} 0) scale(-1 1)`;
    case 'bottom-left':
      return `translate(0 ${LOUPE_TIP_VIEWBOX_SIZE}) scale(1 -1)`;
    case 'bottom-right':
      return `translate(${LOUPE_TIP_VIEWBOX_SIZE} ${LOUPE_TIP_VIEWBOX_SIZE}) scale(-1 -1)`;
    case 'top-left':
    default:
      return undefined;
  }
}

function LoupeCornerTip({ slot, id }: { slot: LoupeSlot; id: string }) {
  const gradientId = `loupe-tip-fill-${slot}-${id.replace(/[^a-zA-Z0-9_-]/g, '')}`;

  return (
    <svg
      aria-hidden="true"
      className="absolute pointer-events-none overflow-visible"
      height={LOUPE_TIP_SVG_SIZE}
      style={getTipSvgStyle(slot)}
      viewBox={`0 0 ${LOUPE_TIP_VIEWBOX_SIZE} ${LOUPE_TIP_VIEWBOX_SIZE}`}
      width={LOUPE_TIP_SVG_SIZE}
    >
      <defs>
        <linearGradient id={gradientId} x1="2" x2="22" y1="2" y2="22">
          <stop offset="0" stopColor="var(--app-card-active)" />
          <stop offset="0.42" stopColor="var(--app-surface)" />
          <stop offset="1" stopColor="var(--app-bg-primary)" />
        </linearGradient>
      </defs>
      <g transform={getTipSvgTransform(slot)}>
        <path
          d="M0.45 0.45 C7.2 6.55 13.7 10.75 23.25 12.05 C19.2 15.05 15.05 19.2 12.05 23.25 C10.75 13.7 6.55 7.2 0.45 0.45 Z"
          fill={`url(#${gradientId})`}
        />
        <path
          d="M23.25 12.05 C13.7 10.75 7.2 6.55 0.45 0.45 C6.55 7.2 10.75 13.7 12.05 23.25"
          fill="none"
          stroke="var(--app-text-primary)"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeOpacity="0.65"
          strokeWidth="1.42"
          vectorEffect="non-scaling-stroke"
        />
        <path
          d="M3.25 2.75 C8.7 7.0 14.6 10.15 21.0 11.65"
          fill="none"
          stroke="var(--app-text-primary)"
          strokeLinecap="round"
          strokeOpacity="0.18"
          strokeWidth="0.42"
          vectorEffect="non-scaling-stroke"
        />
      </g>
    </svg>
  );
}

const DRAG_START_THRESHOLD_PX = 1;

function findLoupeTargetRects(loupe: LoupePreview) {
  const roots = document.querySelectorAll<HTMLElement>('[data-rapidraw-loupe-path]');
  const root = Array.from(roots).find((item) => item.dataset.rapidrawLoupePath === loupe.path);
  if (!root) return null;

  const imageArea = root.querySelector<HTMLElement>('[data-rapidraw-loupe-image-area="true"]') || root;
  return getImageTargetGeometry(root, imageArea, loupe.objectFit, loupe.imageAspectRatio);
}

function syncOpenLoupesToLibraryTargets(draggingLoupeIds: ReadonlySet<string>) {
  const { loupes, updateLoupe } = useLoupeStore.getState();
  const bounds = getLoupeSafeBounds();
  loupes.forEach((loupe) => {
    if (draggingLoupeIds.has(loupe.id)) return;
    const target = findLoupeTargetRects(loupe);
    if (!target) return;

    const tipPoint = getClientPointFromNormalizedObjectFit(
      loupe.focalPoint,
      target.imageRect,
      loupe.imageAspectRatio,
      loupe.objectFit,
    );
    const slot = chooseLoupeSlotForTip(loupe.slot, tipPoint, loupe.size, bounds);
    const position = getLoupePositionForTip(slot, tipPoint, loupe.size);

    if (
      !rectsDiffer(loupe.targetImageRect, target.imageRect) &&
      !rectsDiffer(loupe.targetItemRect, target.itemRect) &&
      loupe.slot === slot &&
      !pointsDiffer(loupe.tipPoint, tipPoint) &&
      !pointsDiffer(loupe.position, position)
    ) {
      return;
    }

    updateLoupe(loupe.id, {
      slot,
      position,
      tipPoint,
      targetImageRect: target.imageRect,
      targetItemRect: target.itemRect,
    });
  });
}

function getLoupePatchForTip(loupe: LoupePreview, rawTipPoint: { x: number; y: number }): Partial<LoupePreview> {
  const tipPoint = clampPointToRect(rawTipPoint, loupe.targetImageRect);
  const position = getLoupePositionForTip(loupe.slot, tipPoint, loupe.size);
  const focalPoint = getNormalizedPointFromObjectFit(
    { clientX: tipPoint.x, clientY: tipPoint.y },
    loupe.targetImageRect,
    loupe.imageAspectRatio,
    loupe.objectFit,
  );
  const renderArea = normalizeLoupeRenderArea(useSettingsStore.getState().appSettings?.loupeRenderArea);
  const isTileStale = !isLoupeTileUsable({ ...loupe, focalPoint }, renderArea);

  return {
    position,
    tipPoint,
    focalPoint,
    isTileStale,
  };
}

function LoupeWindow({
  bounds,
  isDragging,
  loupe,
  onDraggingLoupeIdsChange,
}: {
  bounds: RectLike;
  isDragging: boolean;
  loupe: LoupePreview;
  onDraggingLoupeIdsChange(ids: string[]): void;
}) {
  const { t } = useTranslation();
  const { closeLoupe, raiseLoupe, updateLoupe, updateLoupes } = useLoupeStore(
    useShallow((state) => ({
      closeLoupe: state.closeLoupe,
      raiseLoupe: state.raiseLoupe,
      updateLoupe: state.updateLoupe,
      updateLoupes: state.updateLoupes,
    })),
  );
  const animatedBodyRef = useRef<HTMLDivElement | null>(null);
  const previousPlacementRef = useRef({ slot: loupe.slot, position: { ...loupe.position } });
  const slotAnimationRef = useRef<Animation | null>(null);
  const dragStateRef = useRef<{
    startX: number;
    startY: number;
    baseTipPoint: { x: number; y: number };
    isGroupDrag: boolean;
    hasMoved: boolean;
    groupBases: Array<{
      id: string;
      tipPoint: { x: number; y: number };
    }>;
  } | null>(null);
  const renderTimerRef = useRef<number | null>(null);
  const zoomIndicatorTimerRef = useRef<number | null>(null);
  const [visibleZoom, setVisibleZoom] = useState<number | null>(null);

  useLayoutEffect(() => {
    const previous = previousPlacementRef.current;
    previousPlacementRef.current = { slot: loupe.slot, position: { ...loupe.position } };

    if (previous.slot === loupe.slot || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const element = animatedBodyRef.current;
    if (!element) return;

    const offsetX = previous.position.x - loupe.position.x;
    const offsetY = previous.position.y - loupe.position.y;
    if (Math.abs(offsetX) < 0.5 && Math.abs(offsetY) < 0.5) return;

    slotAnimationRef.current?.cancel();
    const animation = element.animate(
      [{ transform: `translate(${offsetX}px, ${offsetY}px)` }, { transform: 'translate(0, 0)' }],
      {
        duration: LOUPE_SLOT_SWITCH_DURATION_MS,
        easing: LOUPE_SLOT_SWITCH_EASING,
      },
    );
    slotAnimationRef.current = animation;
    animation.addEventListener(
      'finish',
      () => {
        if (slotAnimationRef.current === animation) slotAnimationRef.current = null;
      },
      { once: true },
    );
  }, [loupe.position, loupe.slot]);

  const cancelScheduledRender = useCallback(() => {
    if (renderTimerRef.current === null) return;
    window.clearTimeout(renderTimerRef.current);
    renderTimerRef.current = null;
  }, []);

  const scheduleRender = useCallback(
    (loupeIds: string[] = [loupe.id]) => {
      cancelScheduledRender();
      const uniqueIds = Array.from(new Set(loupeIds));
      renderTimerRef.current = window.setTimeout(() => {
        renderTimerRef.current = null;
        uniqueIds.forEach((id) => loadLoupeTile(id));
      }, LOUPE_RENDER_DEBOUNCE_MS);
    },
    [cancelScheduledRender, loupe.id],
  );

  const getDraggedLoupePatch = useCallback(
    (
      currentLoupe: LoupePreview,
      rawTipPoint: { x: number; y: number },
      allLoupes: LoupePreview[],
    ): Partial<LoupePreview> => {
      const currentPatch = getLoupePatchForTip(currentLoupe, rawTipPoint);
      const tipPoint = currentPatch.tipPoint || currentLoupe.tipPoint;
      const currentPosition =
        currentPatch.position || getLoupePositionForTip(currentLoupe.slot, tipPoint, currentLoupe.size);
      const avoidRects = allLoupes
        .filter((item) => item.id !== currentLoupe.id)
        .map((item) => getLoupeWindowRect(item.position, item.size));
      const nextSlot = getLoupeSlotForOverdrag(
        currentLoupe.slot,
        currentPosition,
        currentLoupe.size,
        bounds,
        avoidRects,
      );

      if (!nextSlot) return currentPatch;

      const nextPatch = getLoupePatchForTip({ ...currentLoupe, slot: nextSlot }, tipPoint);
      return { slot: nextSlot, ...nextPatch };
    },
    [bounds],
  );

  useEffect(
    () => () => {
      if (renderTimerRef.current) window.clearTimeout(renderTimerRef.current);
      if (zoomIndicatorTimerRef.current) window.clearTimeout(zoomIndicatorTimerRef.current);
      slotAnimationRef.current?.cancel();
    },
    [],
  );

  const beginDrag = useCallback(
    (event: React.PointerEvent) => {
      if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return;
      raiseLoupe(loupe.id);
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);

      const isGroupDrag = event.ctrlKey || event.metaKey;
      dragStateRef.current = {
        startX: event.clientX,
        startY: event.clientY,
        baseTipPoint: { ...loupe.tipPoint },
        isGroupDrag,
        hasMoved: false,
        groupBases: isGroupDrag
          ? useLoupeStore.getState().loupes.map((item) => ({
              id: item.id,
              tipPoint: { ...item.tipPoint },
            }))
          : [],
      };
    },
    [loupe.id, loupe.tipPoint.x, loupe.tipPoint.y, raiseLoupe],
  );

  const drag = useCallback(
    (event: React.PointerEvent) => {
      const dragState = dragStateRef.current;
      if (!dragState) return;

      const deltaX = event.clientX - dragState.startX;
      const deltaY = event.clientY - dragState.startY;
      const hasMovedEnough = Math.max(Math.abs(deltaX), Math.abs(deltaY)) >= DRAG_START_THRESHOLD_PX;

      if (!hasMovedEnough && !dragState.hasMoved) return;
      if (hasMovedEnough && !dragState.hasMoved) {
        onDraggingLoupeIdsChange(dragState.isGroupDrag ? dragState.groupBases.map((base) => base.id) : [loupe.id]);
      }
      dragState.hasMoved = dragState.hasMoved || hasMovedEnough;

      if (dragState.isGroupDrag) {
        const workingLoupes = new Map(useLoupeStore.getState().loupes.map((item) => [item.id, item]));
        const updates: Array<{ id: string; patch: Partial<LoupePreview> }> = [];
        dragState.groupBases.forEach((base) => {
          const currentLoupe = workingLoupes.get(base.id);
          if (!currentLoupe) return;
          const rawTipPoint = {
            x: base.tipPoint.x + deltaX,
            y: base.tipPoint.y + deltaY,
          };
          const patch = getDraggedLoupePatch(currentLoupe, rawTipPoint, Array.from(workingLoupes.values()));
          updates.push({ id: base.id, patch });
          workingLoupes.set(base.id, { ...currentLoupe, ...patch });
        });
        updateLoupes(updates);
        return;
      }

      const rawTipPoint = {
        x: dragState.baseTipPoint.x + deltaX,
        y: dragState.baseTipPoint.y + deltaY,
      };
      const currentLoupes = useLoupeStore.getState().loupes;
      const currentLoupe = currentLoupes.find((item) => item.id === loupe.id);
      if (!currentLoupe) return;

      updateLoupe(currentLoupe.id, getDraggedLoupePatch(currentLoupe, rawTipPoint, currentLoupes));
    },
    [getDraggedLoupePatch, loupe.id, onDraggingLoupeIdsChange, updateLoupe, updateLoupes],
  );

  const endDrag = useCallback(
    (event: React.PointerEvent) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      const dragState = dragStateRef.current;
      if (dragState?.hasMoved) {
        const currentLoupes = new Map(useLoupeStore.getState().loupes.map((item) => [item.id, item]));
        const movedIds = dragState.isGroupDrag
          ? dragState.groupBases
              .filter((base) => {
                const current = currentLoupes.get(base.id);
                return current?.isTileStale && pointsDiffer(base.tipPoint, current.tipPoint);
              })
              .map((base) => base.id)
          : (() => {
              const current = currentLoupes.get(loupe.id);
              return current?.isTileStale && pointsDiffer(dragState.baseTipPoint, current.tipPoint) ? [loupe.id] : [];
            })();

        if (movedIds.length > 0) {
          updateLoupes(movedIds.map((id) => ({ id, patch: { isLoading: true, error: null } })));
          scheduleRender(movedIds);
        }
      }
      dragStateRef.current = null;
      onDraggingLoupeIdsChange([]);
    },
    [loupe.id, onDraggingLoupeIdsChange, scheduleRender, updateLoupes],
  );

  const handleWheel = useCallback(
    (event: React.WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();

      const direction: 1 | -1 = event.deltaY < 0 ? 1 : -1;
      const nextZoom = getNextLoupeZoom(loupe.zoom, direction);
      const nextSourceSize = getLoupeSourceSizeForZoom(loupe.size.height, nextZoom);
      const renderArea = normalizeLoupeRenderArea(useSettingsStore.getState().appSettings?.loupeRenderArea);
      const isTileStale = !isLoupeTileUsable({ ...loupe, sourceSize: nextSourceSize }, renderArea);

      setVisibleZoom(nextZoom);
      if (zoomIndicatorTimerRef.current) window.clearTimeout(zoomIndicatorTimerRef.current);
      zoomIndicatorTimerRef.current = window.setTimeout(() => {
        zoomIndicatorTimerRef.current = null;
        setVisibleZoom(null);
      }, LOUPE_ZOOM_INDICATOR_HIDE_DELAY_MS);

      updateLoupe(loupe.id, {
        zoom: nextZoom,
        sourceSize: nextSourceSize,
        isTileStale,
        isLoading: isTileStale,
        error: null,
      });

      if (isTileStale) scheduleRender();
      else cancelScheduledRender();
    },
    [cancelScheduledRender, loupe, scheduleRender, updateLoupe],
  );
  const handleContextMenu = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();

      const { loupes } = useLoupeStore.getState();
      const current = loupes.find((item) => item.id === loupe.id);
      if (!current) return;

      const avoidRects = event.shiftKey
        ? []
        : loupes.filter((item) => item.id !== current.id).map((item) => getLoupeWindowRect(item.position, item.size));
      const nextSlot = chooseNextAvailableLoupeSlot(current.slot, current.tipPoint, current.size, bounds, avoidRects);
      if (!nextSlot) return;

      updateLoupe(current.id, {
        slot: nextSlot,
        position: getLoupePositionForTip(nextSlot, current.tipPoint, current.size),
      });
      raiseLoupe(current.id);
    },
    [bounds, loupe.id, raiseLoupe, updateLoupe],
  );

  const imageUrl = loupe.tile?.url || loupe.thumbnailUrl;
  const viewport = { width: loupe.size.width, height: loupe.size.height };
  const tileImageStyle = loupe.tile
    ? getLoupeTileImageStyle(loupe.tile, loupe.focalPoint, loupe.sourceSize, viewport)
    : undefined;
  const showReleaseToRender = isDragging && !!loupe.tile && loupe.isTileStale && !loupe.isLoading && !loupe.error;

  return (
    <div
      className="absolute isolate text-text-primary select-none overflow-visible"
      style={{
        left: loupe.position.x - bounds.x,
        top: loupe.position.y - bounds.y,
        width: loupe.size.width,
        height: loupe.size.height,
      }}
      onContextMenu={handleContextMenu}
      onPointerDownCapture={(event) => {
        if ((event.target as HTMLElement).closest('[data-loupe-close="true"]')) return;

        if (event.button === 1) {
          event.preventDefault();
          event.stopPropagation();
          const current = useLoupeStore.getState().loupes.find((item) => item.id === loupe.id);
          updateLoupe(loupe.id, { showGuide: !(current?.showGuide ?? loupe.showGuide) });
          raiseLoupe(loupe.id);
          return;
        }

        raiseLoupe(loupe.id);
      }}
      onAuxClick={(event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        event.stopPropagation();
      }}
      onWheel={handleWheel}
    >
      <LoupeCornerTip id={loupe.id} slot={loupe.slot} />

      <div
        ref={animatedBodyRef}
        className="relative z-10 h-full w-full rounded-2xl ring-2 ring-border-color bg-surface overflow-hidden cursor-grab active:cursor-grabbing"
        onPointerDown={beginDrag}
        onPointerMove={drag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div className="relative z-20 h-full w-full rounded-2xl bg-black flex items-center justify-center overflow-hidden">
          {imageUrl ? (
            <img
              src={imageUrl}
              alt={loupe.fileName}
              draggable={false}
              className={clsx(
                'select-none transition-opacity duration-150',
                loupe.tile ? 'opacity-100' : 'w-full h-full object-cover opacity-55 blur-sm scale-[2.15]',
              )}
              style={
                loupe.tile
                  ? tileImageStyle
                  : {
                      objectPosition: `${loupe.focalPoint.x * 100}% ${loupe.focalPoint.y * 100}%`,
                      transformOrigin: `${loupe.focalPoint.x * 100}% ${loupe.focalPoint.y * 100}%`,
                    }
              }
            />
          ) : (
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(255,255,255,0.10),rgba(0,0,0,0.65))]" />
          )}

          <button
            type="button"
            aria-label={t('ui.loupe.close')}
            data-loupe-close="true"
            className="absolute right-1 top-1 z-40 h-6 w-6 rounded-full flex items-center justify-center bg-bg-primary/20 border border-border-color/20 text-text-secondary/40 opacity-40 hover:opacity-100 hover:text-text-primary hover:bg-card-active hover:border-border-color transition-[opacity,color,background-color,border-color] cursor-pointer"
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              closeLoupe(loupe.id);
            }}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
          >
            <X size={14} />
          </button>

          {visibleZoom !== null && (
            <div className="absolute left-1 top-1 z-40 rounded-full bg-bg-primary/80 border border-border-color px-2 py-1 text-[11px] font-semibold text-text-primary shadow-sm pointer-events-none">
              {formatZoom(visibleZoom)}
            </div>
          )}
          {loupe.showGuide && (
            <>
              <div className="absolute left-1/2 top-1/2 w-7 h-px -translate-x-1/2 -translate-y-1/2 bg-white/55 pointer-events-none shadow-[0_0_4px_rgba(0,0,0,0.75)]" />
              <div className="absolute left-1/2 top-1/2 h-7 w-px -translate-x-1/2 -translate-y-1/2 bg-white/55 pointer-events-none shadow-[0_0_4px_rgba(0,0,0,0.75)]" />
            </>
          )}

          {showReleaseToRender && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/25 backdrop-blur-[1px] pointer-events-none">
              <div className="rounded-full bg-black/55 px-3 py-1.5 text-xs font-medium text-white/85 border border-white/10">
                {t('ui.loupe.releaseToRenderArea')}
              </div>
            </div>
          )}

          {loupe.isLoading && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/25 backdrop-blur-[1px]">
              <div className="flex items-center gap-2 rounded-full bg-black/55 px-3 py-1.5 text-xs font-medium text-white/85 border border-white/10">
                <Loader2 size={14} className="animate-spin" />
                {t('ui.loupe.renderingRawCrop')}
              </div>
            </div>
          )}

          {loupe.error && (
            <div className="absolute inset-x-3 bottom-3 flex items-start gap-2 rounded-xl bg-red-950/85 border border-red-400/25 px-3 py-2 text-xs text-red-100 shadow-lg">
              <AlertTriangle size={14} className="shrink-0 mt-0.5" />
              <span className="line-clamp-3">{loupe.error}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function LoupeOverlay({ visiblePaths }: { visiblePaths: string[] }) {
  const loupes = useLoupeStore((state) => state.loupes);
  const [bounds, setBounds] = useState<RectLike>(() => getLoupeSafeBounds());
  const [draggingLoupeIds, setDraggingLoupeIds] = useState<Set<string>>(() => new Set());
  const draggingLoupeIdsRef = useRef<ReadonlySet<string>>(draggingLoupeIds);
  const visibleLoupes = loupes.filter((loupe) => visiblePaths.includes(loupe.path));
  const hasOpenLoupes = visibleLoupes.length > 0;
  const handleDraggingLoupeIdsChange = useCallback((ids: string[]) => {
    const nextIds = new Set(ids);
    draggingLoupeIdsRef.current = nextIds;
    setDraggingLoupeIds(nextIds);
  }, []);

  useEffect(() => {
    if (!hasOpenLoupes) return;

    let animationFrame = 0;
    let observer: ResizeObserver | null = null;
    let mutationObserver: MutationObserver | null = null;

    const updateBoundsAndTargets = () => {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(() => {
        setBounds(getLoupeSafeBounds());
        syncOpenLoupesToLibraryTargets(draggingLoupeIdsRef.current);
      });
    };

    updateBoundsAndTargets();
    window.addEventListener('resize', updateBoundsAndTargets);

    const safeElement = document.querySelector<HTMLElement>('[data-rapidraw-loupe-bounds="true"]');
    if (safeElement && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(updateBoundsAndTargets);
      observer.observe(safeElement);
    }
    if (safeElement && typeof MutationObserver !== 'undefined') {
      mutationObserver = new MutationObserver((mutations) => {
        const hasExternalMutation = mutations.some((mutation) => {
          const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
          return !target?.closest('[data-rapidraw-loupe-overlay="true"]');
        });
        if (hasExternalMutation) updateBoundsAndTargets();
      });
      mutationObserver.observe(safeElement, {
        attributes: true,
        childList: true,
        subtree: true,
      });
    }

    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener('resize', updateBoundsAndTargets);
      observer?.disconnect();
      mutationObserver?.disconnect();
    };
  }, [hasOpenLoupes]);

  if (!hasOpenLoupes || bounds.width <= 0 || bounds.height <= 0) return null;

  return (
    <div data-rapidraw-loupe-overlay="true" className="absolute inset-0 pointer-events-none z-[5] overflow-hidden">
      <div className="absolute inset-0 pointer-events-none">
        {visibleLoupes.map((loupe) => (
          <div key={loupe.id} className="pointer-events-auto">
            <LoupeWindow
              bounds={bounds}
              isDragging={draggingLoupeIds.has(loupe.id)}
              loupe={loupe}
              onDraggingLoupeIdsChange={handleDraggingLoupeIdsChange}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
