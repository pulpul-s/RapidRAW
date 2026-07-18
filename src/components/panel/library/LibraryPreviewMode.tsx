import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { List, useListCallbackRef, type RowComponentProps } from 'react-window';
import {
  Album as AlbumIcon,
  ChevronLeft,
  ChevronRight,
  Folder,
  Image as ImageIcon,
  SlidersHorizontal,
  Star,
} from 'lucide-react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import {
  ExifOverlay,
  ImageFile,
  Invokes,
  LibraryPreviewDetailsMode,
  LibraryPreviewThumbnailStyle,
  Orientation,
  ThumbnailAspectRatio,
} from '../../ui/AppProperties';
import Resizer from '../../ui/Resizer';
import Text from '../../ui/Text';
import { TextColors, TextVariants, TextWeights } from '../../../types/typography';
import { useLibraryStore } from '../../../store/useLibraryStore';
import { useLoupeStore } from '../../../store/useLoupeStore';
import { useSettingsStore } from '../../../store/useSettingsStore';
import { useProcessStore } from '../../../store/useProcessStore';
import {
  clampLibraryPreviewPageSize,
  LIBRARY_PREVIEW_MAX_PAGE_SIZE,
  LIBRARY_PREVIEW_MIN_PAGE_SIZE,
  useUIStore,
} from '../../../store/useUIStore';
import {
  getClientPointFromNormalizedObjectFit,
  getImageTargetGeometry,
  isClientPointInRect,
  pointsDiffer,
  rectsDiffer,
} from '../../../utils/imageCoordinateUtils';
import { chooseLoupeSlotForTip, getLoupePositionForTip, getLoupeSafeBounds } from '../../../utils/loupePlacement';
import {
  computePreviewComparisonLayout,
  computePreviewFixedCellLayout,
  hasMixedPreviewAspectRatios,
} from '../../../utils/previewComparisonLayout';
import { Color, getColorLabelForTags } from '../../../utils/adjustments';
import {
  LIBRARY_PREVIEW_REVEAL_THUMBNAIL_EVENT,
  type LibraryPreviewRevealThumbnailDetail,
} from '../../../utils/libraryPreviewEvents';
import { openPreviewLoupe } from '../../../utils/previewLoupeActions';
import { loadLoupeTile } from '../../../utils/loupeTileLoader';
import { Thumbnail } from './LibraryItems';
import LoupeOverlay from './LoupeOverlay';

const MIN_RIGHT_PANEL_WIDTH = 220;
const MAX_RIGHT_PANEL_WIDTH = 760;
const MIN_METADATA_HEIGHT = 112;
const MIN_THUMBNAIL_AREA_HEIGHT = 96;
const PREVIEW_GAP = 12;
const PREVIEW_THUMBNAIL_GAP = 8;
const PREVIEW_THUMBNAIL_PADDING = 12;
const PREVIEW_THUMBNAIL_FILENAME_LINE_HEIGHT = 16;
const PREVIEW_THUMBNAIL_FILENAME_PADDING = 6;
const PREVIEW_THUMBNAIL_FILENAME_FONT_SIZE = 10;
const PREVIEW_THUMBNAIL_FILENAME_MAX_LINES = 4;
const PREVIEW_THUMBNAIL_FILENAME_HORIZONTAL_PADDING = 4;
const PREVIEW_THUMBNAIL_SAFE_INSET = 2;
const PREVIEW_THUMBNAIL_LIST_ROW_HEIGHT = 64;
const PREVIEW_THUMBNAIL_LIST_IMAGE_SIZE = 52;
const PREVIEW_THUMBNAIL_LIST_HORIZONTAL_PADDING = 6;
const MIXED_PREVIEW_CELL_ASPECT_RATIO = 3 / 2;
function getBaseName(path: string) {
  return path.split(/[\\/]/).pop()?.split('?vc=')[0] || path;
}

function formatPreviewListModifiedDate(modified: number) {
  const date = new Date(modified > 1e11 ? modified : modified * 1000);
  if (Number.isNaN(date.getTime())) return '';

  return `${date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

let previewListMeasurementContext: CanvasRenderingContext2D | null = null;

function getFittingPreviewListDetails(details: string[], maxWidth: number, fontFamily: string) {
  if (details.length === 0 || maxWidth <= 0) return '';

  previewListMeasurementContext ||= document.createElement('canvas').getContext('2d');
  if (!previewListMeasurementContext) return details[0] || '';
  previewListMeasurementContext.font = `400 10px ${fontFamily}`;

  for (let count = details.length; count > 0; count -= 1) {
    const text = details.slice(0, count).join(' · ');
    if (previewListMeasurementContext.measureText(text).width <= maxWidth) return text;
  }

  return '';
}

function usePreviewHoverTarget({
  path,
  thumbnailUrl,
  rootRef,
  imageAreaRef,
}: {
  path: string;
  thumbnailUrl: string | null;
  rootRef: React.RefObject<HTMLDivElement | null>;
  imageAreaRef: React.RefObject<HTMLDivElement | null>;
}) {
  const setLibrary = useLibraryStore((state) => state.setLibrary);
  const latestPointerRef = useRef<{ clientX: number; clientY: number } | null>(null);
  const pointerFrameRef = useRef<number | null>(null);

  const clearHoverTarget = useCallback(() => {
    if (pointerFrameRef.current !== null) {
      window.cancelAnimationFrame(pointerFrameRef.current);
      pointerFrameRef.current = null;
    }
    latestPointerRef.current = null;

    if (useLibraryStore.getState().hoverTarget?.path === path) {
      setLibrary({ hoverTarget: null });
    }
  }, [path, setLibrary]);

  const flushHoverTarget = useCallback(() => {
    pointerFrameRef.current = null;
    const pointer = latestPointerRef.current;
    const root = rootRef.current;
    if (!pointer || !root) return;

    const imageArea = imageAreaRef.current || root;
    const { imageAspectRatio, imageRect, itemRect } = getImageTargetGeometry(
      root,
      imageArea,
      ThumbnailAspectRatio.Contain,
    );

    if (!isClientPointInRect(pointer, imageRect)) {
      if (useLibraryStore.getState().hoverTarget?.path === path) {
        setLibrary({ hoverTarget: null });
      }
      return;
    }

    setLibrary({
      hoverTarget: {
        path,
        fileName: getBaseName(path),
        itemRect,
        imageRect,
        pointer,
        imageAspectRatio,
        objectFit: 'contain',
        thumbnailUrl,
      },
    });
  }, [imageAreaRef, path, rootRef, setLibrary, thumbnailUrl]);

  const updateHoverTarget = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      latestPointerRef.current = { clientX: event.clientX, clientY: event.clientY };

      if (event.type === 'pointerenter') {
        if (pointerFrameRef.current !== null) {
          window.cancelAnimationFrame(pointerFrameRef.current);
          pointerFrameRef.current = null;
        }
        flushHoverTarget();
        return;
      }

      if (pointerFrameRef.current === null) {
        pointerFrameRef.current = window.requestAnimationFrame(flushHoverTarget);
      }
    },
    [flushHoverTarget],
  );

  useEffect(
    () => () => {
      if (pointerFrameRef.current !== null) window.cancelAnimationFrame(pointerFrameRef.current);
    },
    [flushHoverTarget],
  );

  return { updateHoverTarget, clearHoverTarget };
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function formatExifTag(value: string) {
  if (!value) return '';
  return value.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2');
}

function useShallowStableArray<T>(items: T[]) {
  const stableRef = useRef(items);
  if (stableRef.current.length !== items.length || stableRef.current.some((item, index) => item !== items[index])) {
    stableRef.current = items;
  }
  return stableRef.current;
}

const prunePathRecord = <T,>(record: Record<string, T>, activePaths: Set<string>) => {
  const paths = Object.keys(record);
  const entries = paths.filter((path) => activePaths.has(path)).map((path) => [path, record[path]] as const);
  return entries.length === paths.length ? record : Object.fromEntries(entries);
};

const getFilenameLineCount = (context: CanvasRenderingContext2D, filename: string, availableWidth: number) => {
  let lineCount = 1;
  let currentLine = '';

  for (const character of filename) {
    const nextLine = currentLine + character;
    if (!currentLine || context.measureText(nextLine).width <= availableWidth) {
      currentLine = nextLine;
      continue;
    }

    lineCount += 1;
    if (lineCount >= PREVIEW_THUMBNAIL_FILENAME_MAX_LINES) {
      return PREVIEW_THUMBNAIL_FILENAME_MAX_LINES;
    }

    currentLine = character;
  }

  return lineCount;
};

const CENTER_PREVIEW_MIN_THUMBNAIL_EDGE = 640;
const CENTER_PREVIEW_RENDER_BUCKETS = [720, 1080, 1440, 1920, 2560, 3200, 4096, 5120];
const CENTER_PREVIEW_RENDER_DEBOUNCE_MS = 320;
const CENTER_PREVIEW_RENDER_INDICATOR_DELAY_MS = 120;
const CENTER_PREVIEW_MAX_DEVICE_PIXEL_RATIO = 1.5;
const CENTER_PREVIEW_THUMBNAIL_SUFFICIENCY = 0.92;

type CenterPreviewEntry = {
  key: string;
  url: string;
};

type CenterPreviewRenderJob = {
  bucket: number;
  key: string;
  path: string;
  priority: number;
};

type LibraryPreviewResponse = {
  previewPath: string;
};

const hashString = (value: string) => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

const getThumbnailSignature = (thumbnailUrl?: string) =>
  thumbnailUrl ? `${thumbnailUrl.length}:${hashString(thumbnailUrl)}` : 'no-thumbnail';

const getPreviewRenderKeyPrefix = (image: ImageFile, thumbnailUrl?: string) =>
  `${image.path}|${image.modified}|${image.is_edited ? 1 : 0}|${getThumbnailSignature(thumbnailUrl)}`;

const getPreviewRenderKey = (image: ImageFile, bucket: number, thumbnailUrl?: string) =>
  `${getPreviewRenderKeyPrefix(image, thumbnailUrl)}|${bucket}`;

const getExifDimensions = (image: ImageFile) => {
  const exif = image.exif || {};
  const width =
    parseExifNumber(exif.ExifImageWidth) || parseExifNumber(exif.PixelXDimension) || parseExifNumber(exif.ImageWidth);
  const height =
    parseExifNumber(exif.ExifImageHeight) ||
    parseExifNumber(exif.PixelYDimension) ||
    parseExifNumber(exif.ImageHeight) ||
    parseExifNumber(exif.ImageLength);
  return width && height ? { width, height } : null;
};

const getImageExifMaxEdge = (image: ImageFile) => {
  const dimensions = getExifDimensions(image);
  return dimensions ? Math.max(dimensions.width, dimensions.height) : null;
};

const choosePreviewRenderBucket = (requiredEdge: number, sourceMaxEdge: number | null) => {
  const requested =
    CENTER_PREVIEW_RENDER_BUCKETS.find((bucket) => bucket >= requiredEdge) ||
    CENTER_PREVIEW_RENDER_BUCKETS[CENTER_PREVIEW_RENDER_BUCKETS.length - 1];
  return Math.max(256, sourceMaxEdge ? Math.min(requested, sourceMaxEdge) : requested);
};

const preloadImageUrl = (url: string) =>
  new Promise<void>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('Failed to decode center preview image'));
    image.src = url;
  });

const parseExifNumber = (value: string | undefined) => {
  if (!value) return null;
  const match = String(value).match(/\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const getExifAspectRatio = (image: ImageFile) => {
  const dimensions = getExifDimensions(image);
  return dimensions ? dimensions.width / dimensions.height : null;
};

type PreviewMouseEvent = React.MouseEvent<HTMLElement>;
type PreviewContextMenuOptions = { forceSingleSelection?: boolean; preserveSelection?: boolean };

interface PreviewImageInteractionHandlers {
  onContextMenu(event: PreviewMouseEvent, path: string, options?: PreviewContextMenuOptions): void;
  onImageClick(path: string, event: PreviewMouseEvent): void;
  onImageDoubleClick(path: string): void;
}

function getPreviewImageInteractionHandlers(path: string, handlers: PreviewImageInteractionHandlers) {
  return {
    onClick: (event: PreviewMouseEvent) => {
      event.stopPropagation();
      handlers.onImageClick(path, event);
    },
    onContextMenu: (event: PreviewMouseEvent) => handlers.onContextMenu(event, path),
    onDoubleClick: () => handlers.onImageDoubleClick(path),
  };
}

type PreviewTileLayout = {
  aspectRatio: number;
  contentHeight: number;
  contentWidth: number;
  height: number;
  isFixedCell?: boolean;
  width: number;
  x: number;
  y: number;
};

const getCenterPreviewRequiredEdge = (layout: PreviewTileLayout, devicePixelRatio: number) =>
  Math.max(layout.contentWidth || layout.width, layout.contentHeight || layout.height) * devicePixelRatio;

const getCenterPreviewRenderRequirement = ({
  devicePixelRatio,
  image,
  layout,
  thumbnailMaxEdge,
  thumbnailUrl,
}: {
  devicePixelRatio: number;
  image: ImageFile;
  layout: PreviewTileLayout | undefined;
  thumbnailMaxEdge: number;
  thumbnailUrl: string | undefined;
}) => {
  if (!layout || !thumbnailUrl || thumbnailMaxEdge <= 0) return null;

  const requiredEdge = getCenterPreviewRequiredEdge(layout, devicePixelRatio);
  if (thumbnailMaxEdge >= requiredEdge * CENTER_PREVIEW_THUMBNAIL_SUFFICIENCY) return null;

  const bucket = choosePreviewRenderBucket(requiredEdge, getImageExifMaxEdge(image));
  if (bucket <= thumbnailMaxEdge * 1.08) return null;

  return {
    area: layout.width * layout.height,
    bucket,
    key: getPreviewRenderKey(image, bucket, thumbnailUrl),
  };
};
interface LibraryPreviewModeProps extends PreviewImageInteractionHandlers {
  activePath: string | null;
  imageList: ImageFile[];
  imageRatings: Record<string, number>;
  multiSelectedPaths: string[];
  onEmptyAreaContextMenu(event: PreviewMouseEvent): void;
  onRequestThumbnails?(paths: string[]): void;
}

function startPointerResize(
  cleanupRef: { current: (() => void) | null },
  onPointerMove: (event: PointerEvent) => void,
  onFinish: () => void,
) {
  cleanupRef.current?.();

  const finish = () => {
    onFinish();
    cleanup();
  };
  const cleanup = () => {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', finish);
    window.removeEventListener('pointercancel', finish);
    if (cleanupRef.current === cleanup) cleanupRef.current = null;
  };

  cleanupRef.current = cleanup;
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', finish);
  window.addEventListener('pointercancel', finish);
}

function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const updateSize = () => {
      const rect = element.getBoundingClientRect();
      setSize((prev) =>
        prev.width === rect.width && prev.height === rect.height ? prev : { width: rect.width, height: rect.height },
      );
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return { ref, size };
}

interface PreviewImageLayer {
  id: string;
  opacity: number;
  url: string;
}

function PreviewCrossfadeImage({
  alt,
  className,
  decoding,
  draggable,
  loading,
  onLoad,
  url,
}: {
  alt: string;
  className: string;
  decoding?: 'async' | 'auto' | 'sync';
  draggable?: boolean;
  loading?: 'eager' | 'lazy';
  onLoad?(event: React.SyntheticEvent<HTMLImageElement>, url: string): void;
  url: string;
}) {
  const [layers, setLayers] = useState<PreviewImageLayer[]>(() => [{ id: url, opacity: 1, url }]);

  useEffect(() => {
    setLayers((prev) => {
      if (prev.some((layer) => layer.id === url)) return prev;
      return [...prev, { id: url, opacity: 0, url }];
    });
  }, [url]);

  useEffect(() => {
    const layerToFadeIn = layers.find((layer) => layer.opacity === 0);
    if (!layerToFadeIn) return;

    const frame = requestAnimationFrame(() => {
      setLayers((prev) => prev.map((layer) => (layer.id === layerToFadeIn.id ? { ...layer, opacity: 1 } : layer)));
    });
    return () => cancelAnimationFrame(frame);
  }, [layers]);

  const handleTransitionEnd = useCallback((finishedId: string) => {
    setLayers((prev) => {
      const finishedIndex = prev.findIndex((layer) => layer.id === finishedId);
      if (finishedIndex < 0 || prev.length <= 1) return prev;
      return prev.slice(finishedIndex);
    });
  }, []);

  return (
    <div className="absolute inset-0">
      {layers.map((layer) => (
        <div
          key={layer.id}
          className="absolute inset-0"
          style={{ opacity: layer.opacity, transition: 'opacity 300ms ease-in-out' }}
          onTransitionEnd={() => handleTransitionEnd(layer.id)}
        >
          <img
            alt={alt}
            className={className}
            decoding={decoding}
            draggable={draggable}
            loading={loading}
            src={layer.url}
            onLoad={(event) => onLoad?.(event, layer.url)}
          />
        </div>
      ))}
    </div>
  );
}

function PreviewStatusBadges({
  className = 'bg-black/35',
  colorLabel,
  isEdited,
  isVirtualCopy = false,
  outerClassName,
  rating,
}: {
  className?: string;
  colorLabel?: Color;
  isEdited: boolean;
  isVirtualCopy?: boolean;
  outerClassName?: string;
  rating?: number;
}) {
  const hasRating = !!rating && rating > 0;
  if (!isVirtualCopy && !isEdited && !colorLabel && !hasRating) return null;

  const badges = (
    <div
      className={clsx(
        'flex h-5 items-center justify-center gap-1.5 rounded-full px-1.5 text-white shadow-md pointer-events-none',
        className,
      )}
    >
      {isVirtualCopy && (
        <Text variant={TextVariants.small} color={TextColors.white} weight={TextWeights.bold} className="shrink-0">
          VC
        </Text>
      )}
      {isEdited && <SlidersHorizontal size={12} className="shrink-0" />}
      {colorLabel && <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: colorLabel.color }} />}
      {hasRating && (
        <div className="flex items-center gap-0.5 shrink-0">
          <Text variant={TextVariants.small} color={TextColors.white}>
            {rating}
          </Text>
          <Star size={12} className="fill-white" />
        </div>
      )}
    </div>
  );

  return outerClassName ? <div className={outerClassName}>{badges}</div> : badges;
}

function usePreviewLoupeReanchor({
  imageAreaRef,
  imagePath,
  layout,
  rootRef,
}: {
  imageAreaRef: React.RefObject<HTMLDivElement | null>;
  imagePath: string;
  layout: PreviewTileLayout;
  rootRef: React.RefObject<HTMLDivElement | null>;
}) {
  useLayoutEffect(() => {
    const root = rootRef.current;
    const imageArea = imageAreaRef.current;
    if (!root || !imageArea) return;

    const { itemRect: targetItemRect, imageRect: targetImageRect } = getImageTargetGeometry(
      root,
      imageArea,
      ThumbnailAspectRatio.Contain,
      layout.aspectRatio,
    );
    if (
      targetItemRect.width <= 0 ||
      targetItemRect.height <= 0 ||
      targetImageRect.width <= 0 ||
      targetImageRect.height <= 0
    ) {
      return;
    }

    const { loupes, updateLoupe } = useLoupeStore.getState();
    const bounds = getLoupeSafeBounds();
    loupes
      .filter((loupe) => loupe.path === imagePath)
      .forEach((loupe) => {
        const tipPoint = getClientPointFromNormalizedObjectFit(
          loupe.focalPoint,
          targetImageRect,
          loupe.imageAspectRatio,
          loupe.objectFit,
        );
        const slot = chooseLoupeSlotForTip(loupe.slot, tipPoint, loupe.size, bounds);
        const position = getLoupePositionForTip(slot, tipPoint, loupe.size);

        if (
          !rectsDiffer(loupe.targetImageRect, targetImageRect) &&
          !rectsDiffer(loupe.targetItemRect, targetItemRect) &&
          loupe.slot === slot &&
          !pointsDiffer(loupe.tipPoint, tipPoint) &&
          !pointsDiffer(loupe.position, position)
        ) {
          return;
        }

        updateLoupe(loupe.id, {
          slot,
          targetItemRect,
          targetImageRect,
          tipPoint,
          position,
        });
      });
  }, [imageAreaRef, imagePath, layout.aspectRatio, layout.height, layout.width, layout.x, layout.y, rootRef]);
}

type PreviewImageTileProps = PreviewImageInteractionHandlers & {
  image: ImageFile;
  detailsMode: LibraryPreviewDetailsMode;
  highResPreviewUrl: string | null;
  isActive: boolean;
  isPreviewRendering: boolean;
  layout: PreviewTileLayout;
  onImageAspectRatio(path: string, aspectRatio: number): void;
  onThumbnailLoad(path: string, maxEdge: number): void;
  thumbnailUrl: string | null;
};

function PreviewImageTile({
  detailsMode,
  image,
  isActive,
  highResPreviewUrl,
  isPreviewRendering,
  layout,
  onContextMenu,
  onImageClick,
  onImageDoubleClick,
  onImageAspectRatio,
  onThumbnailLoad,
  thumbnailUrl,
}: PreviewImageTileProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const imageAreaRef = useRef<HTMLDivElement>(null);
  const displayEditIcon = useSettingsStore((s) => s.appSettings?.displayEditIcon ?? true);
  const baseName = getBaseName(image.path);
  const rating = useLibraryStore((state) => state.imageRatings[image.path] || 0);
  const colorLabel = getColorLabelForTags(image.tags);
  const isEdited = !!image.is_edited && displayEditIcon;
  const displayUrl = highResPreviewUrl || thumbnailUrl;
  const showDetailsAlways = detailsMode === LibraryPreviewDetailsMode.Always;
  const showDetailsOnHover = detailsMode === LibraryPreviewDetailsMode.Hover;
  const placeholderIconSize = clamp(Math.min(layout.width, layout.height) * 0.4, 8, 36);
  const imageInteractionHandlers = getPreviewImageInteractionHandlers(image.path, {
    onContextMenu,
    onImageClick,
    onImageDoubleClick,
  });
  const { updateHoverTarget, clearHoverTarget } = usePreviewHoverTarget({
    path: image.path,
    thumbnailUrl,
    rootRef,
    imageAreaRef,
  });

  usePreviewLoupeReanchor({ imageAreaRef, imagePath: image.path, layout, rootRef });

  return (
    <div
      ref={rootRef}
      data-rapidraw-loupe-path={image.path}
      data-rapidraw-preview-image-path={image.path}
      className={clsx(
        'absolute group rounded-md bg-surface overflow-hidden cursor-pointer shadow-md transition-shadow',
        isActive
          ? 'ring-2 ring-accent'
          : 'ring-1 ring-border-color/40 hover:ring-2 hover:ring-hover-color hover:ring-offset-1 hover:ring-offset-bg-primary',
      )}
      style={{ left: layout.x, top: layout.y, width: layout.width, height: layout.height }}
      {...imageInteractionHandlers}
      onAuxClick={(event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        event.stopPropagation();

        const root = rootRef.current;
        const imageArea = imageAreaRef.current;
        if (!root || !imageArea) return;
        const { imageRect } = getImageTargetGeometry(root, imageArea, ThumbnailAspectRatio.Contain, layout.aspectRatio);
        if (!isClientPointInRect(event, imageRect)) return;

        openPreviewLoupe(image.path);
      }}
      onPointerEnter={updateHoverTarget}
      onPointerMove={updateHoverTarget}
      onPointerLeave={clearHoverTarget}
    >
      <div
        ref={imageAreaRef}
        data-rapidraw-loupe-image-area="true"
        className={clsx('relative w-full h-full', layout.isFixedCell ? 'bg-surface' : 'bg-bg-primary')}
      >
        {displayUrl ? (
          <PreviewCrossfadeImage
            alt={baseName}
            className="w-full h-full object-contain select-none"
            draggable={false}
            url={displayUrl}
            onLoad={(event, loadedUrl) => {
              const img = event.currentTarget;
              if (img.naturalWidth > 0 && img.naturalHeight > 0) {
                onImageAspectRatio(image.path, img.naturalWidth / img.naturalHeight);
                if (thumbnailUrl && loadedUrl === thumbnailUrl) {
                  onThumbnailLoad(image.path, Math.max(img.naturalWidth, img.naturalHeight));
                }
              }
            }}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-text-secondary/70 animate-pulse">
            <ImageIcon size={placeholderIconSize} />
          </div>
        )}
        {isPreviewRendering && (
          <div className="absolute top-2 right-2 h-3 w-3 rounded-full border border-white/60 border-t-transparent animate-spin opacity-70 pointer-events-none" />
        )}
        {showDetailsOnHover && (
          <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-linear-to-t from-black/70 to-transparent px-2 py-2 pointer-events-none [clip-path:inset(100%_0_0)] transition-[clip-path] duration-150 ease-out group-hover:[clip-path:inset(0_0_0)]">
            <span className="truncate text-xs font-medium text-white drop-shadow" title={baseName}>
              {baseName}
            </span>
            <PreviewStatusBadges
              colorLabel={colorLabel}
              isEdited={isEdited}
              isVirtualCopy={!!image.is_virtual_copy}
              outerClassName="shrink-0"
              rating={rating}
            />
          </div>
        )}
        {showDetailsAlways && (
          <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 px-2 py-2 pointer-events-none">
            <span
              className="h-5 min-w-0 max-w-full truncate rounded-full bg-black/35 px-1.5 text-xs font-medium leading-5 text-white shadow-md"
              title={baseName}
            >
              {baseName}
            </span>
            <PreviewStatusBadges
              colorLabel={colorLabel}
              isEdited={isEdited}
              isVirtualCopy={!!image.is_virtual_copy}
              outerClassName="shrink-0"
              rating={rating}
            />
          </div>
        )}
      </div>
    </div>
  );
}

const MemoizedPreviewImageTile = React.memo(PreviewImageTile);

function SelectionPreviewCanvas({
  previewActivePath,
  libraryActivePath,
  onContextMenu,
  onEmptyAreaContextMenu,
  onImageDoubleClick,
  onRequestThumbnails,
  selectedImages,
}: {
  previewActivePath: string | null;
  libraryActivePath: string | null;
  onContextMenu(
    event: PreviewMouseEvent,
    path: string,
    options?: { forceSingleSelection?: boolean; preserveSelection?: boolean },
  ): void;
  onEmptyAreaContextMenu(event: PreviewMouseEvent): void;
  onImageDoubleClick(path: string): void;
  onRequestThumbnails?(paths: string[]): void;
  selectedImages: ImageFile[];
}) {
  const { t } = useTranslation();
  const { ref, size } = useElementSize<HTMLDivElement>();
  const { previewDetailsMode, storedPageIndex, storedPageSize, setUI } = useUIStore(
    useShallow((state) => ({
      previewDetailsMode: state.libraryPreviewDetailsMode,
      storedPageIndex: state.libraryPreviewPageIndex,
      storedPageSize: state.libraryPreviewPageSize,
      setUI: state.setUI,
    })),
  );
  const [isPageSizeMenuOpen, setIsPageSizeMenuOpen] = useState(false);
  const [pageSizeDraft, setPageSizeDraft] = useState(storedPageSize);
  const pageSizeDraftRef = useRef(storedPageSize);
  const pageSizeMenuRef = useRef<HTMLDivElement>(null);
  const pageSize = isPageSizeMenuOpen ? pageSizeDraft : storedPageSize;
  const pageAnchorPathRef = useRef<string | null>(null);
  const previousSelectionKeyRef = useRef<string | null>(null);
  const previousPageSizeRef = useRef(pageSize);
  const fullSelectedPathCandidates = useMemo(() => selectedImages.map((image) => image.path), [selectedImages]);
  const fullSelectedPaths = useShallowStableArray(fullSelectedPathCandidates);
  const fullSelectedPathsKey = useMemo(() => fullSelectedPaths.join('\u0000'), [fullSelectedPaths]);
  const previousSelectionKey = previousSelectionKeyRef.current;
  const selectionChanged = previousSelectionKey !== null && previousSelectionKey !== fullSelectedPathsKey;
  const pageSizeChanged = previousPageSizeRef.current !== pageSize;
  const anchorPath = pageAnchorPathRef.current;
  const anchorIndex =
    (selectionChanged || pageSizeChanged) && anchorPath
      ? selectedImages.findIndex((image) => image.path === anchorPath)
      : -1;
  const entryActiveIndex =
    previousSelectionKey === null && libraryActivePath
      ? selectedImages.findIndex((image) => image.path === libraryActivePath)
      : -1;
  const previewActiveIndex =
    ((previousSelectionKey === null && entryActiveIndex < 0) ||
      ((selectionChanged || pageSizeChanged) && !anchorPath)) &&
    previewActivePath
      ? selectedImages.findIndex((image) => image.path === previewActivePath)
      : -1;
  const targetIndex = entryActiveIndex >= 0 ? entryActiveIndex : anchorIndex >= 0 ? anchorIndex : previewActiveIndex;
  const pageCount = Math.max(1, Math.ceil(selectedImages.length / pageSize));
  const currentPage = targetIndex >= 0 ? Math.floor(targetIndex / pageSize) : clamp(storedPageIndex, 0, pageCount - 1);
  const pageStart = currentPage * pageSize;
  const pageImageCandidates = useMemo(
    () => selectedImages.slice(pageStart, pageStart + pageSize),
    [pageSize, pageStart, selectedImages],
  );
  const pageImages = useShallowStableArray(pageImageCandidates);
  const pagePaths = useMemo(() => pageImages.map((image) => image.path), [pageImages]);
  const pagePathsKey = pagePaths.join('\u0000');
  const showPaginationControl = selectedImages.length > 0 && (selectedImages.length > pageSize || isPageSizeMenuOpen);
  const thumbnails = useProcessStore(
    useShallow((state) => {
      const next: Record<string, string | undefined> = {};
      pagePaths.forEach((path) => {
        next[path] = state.thumbnails[path];
      });
      return next;
    }),
  );
  const [aspectRatios, setAspectRatios] = useState<Record<string, number>>({});
  const [thumbnailMaxEdges, setThumbnailMaxEdges] = useState<Record<string, number>>({});
  const [highResPreviews, setHighResPreviews] = useState<Record<string, CenterPreviewEntry>>({});
  const highResPreviewsRef = useRef<Record<string, CenterPreviewEntry>>({});
  const [renderingPaths, setRenderingPaths] = useState<Record<string, boolean>>({});
  const openPathsRef = useRef<Set<string>>(new Set());
  const requiredPreviewKeysRef = useRef<Map<string, string>>(new Map());
  const renderQueueRef = useRef<CenterPreviewRenderJob[]>([]);
  const runningRenderRef = useRef<CenterPreviewRenderJob | null>(null);
  const renderIndicatorTimersRef = useRef<Map<string, number>>(new Map());
  const renderPlanTimeoutRef = useRef<number | null>(null);
  const previousThumbnailsRef = useRef<Record<string, string | undefined>>({});
  const isDisposedRef = useRef(false);

  const commitPageSizeDraft = useCallback(() => {
    const nextPageSize = clampLibraryPreviewPageSize(pageSizeDraftRef.current);
    if (nextPageSize !== storedPageSize) {
      setUI({ libraryPreviewPageSize: nextPageSize });
    }
  }, [setUI, storedPageSize]);

  useEffect(() => {
    if (!isPageSizeMenuOpen) {
      pageSizeDraftRef.current = storedPageSize;
      setPageSizeDraft(storedPageSize);
    }
  }, [isPageSizeMenuOpen, storedPageSize]);

  useEffect(() => {
    if (!isPageSizeMenuOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (pageSizeMenuRef.current?.contains(event.target as Node)) return;
      commitPageSizeDraft();
      setIsPageSizeMenuOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      commitPageSizeDraft();
      setIsPageSizeMenuOpen(false);
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [commitPageSizeDraft, isPageSizeMenuOpen]);

  useEffect(() => {
    if (previewActivePath && pagePaths.includes(previewActivePath)) {
      pageAnchorPathRef.current = previewActivePath;
    }
  }, [pagePathsKey, previewActivePath]);

  useEffect(() => {
    const previousSelectionKey = previousSelectionKeyRef.current;
    const isInitialSelection = previousSelectionKey === null;
    const didSelectionChange = previousSelectionKey !== null && previousSelectionKey !== fullSelectedPathsKey;
    previousSelectionKeyRef.current = fullSelectedPathsKey;
    previousPageSizeRef.current = pageSize;

    if (selectedImages.length === 0) {
      pageAnchorPathRef.current = null;
      if (storedPageIndex !== 0) setUI({ libraryPreviewPageIndex: 0 });
      return;
    }

    const currentAnchorPath = pageAnchorPathRef.current;
    const anchorStillSelected = currentAnchorPath ? fullSelectedPaths.includes(currentAnchorPath) : false;
    const entryPath =
      isInitialSelection && libraryActivePath && fullSelectedPaths.includes(libraryActivePath)
        ? libraryActivePath
        : isInitialSelection && previewActivePath && fullSelectedPaths.includes(previewActivePath)
          ? previewActivePath
          : null;

    if (isInitialSelection) {
      pageAnchorPathRef.current = entryPath || pageImages[0]?.path || null;
    } else if (didSelectionChange && !anchorStillSelected) {
      const activeFallbackPath =
        !currentAnchorPath && previewActivePath && fullSelectedPaths.includes(previewActivePath)
          ? previewActivePath
          : null;
      pageAnchorPathRef.current = activeFallbackPath || pageImages[0]?.path || null;
    }

    const shouldAdoptLibraryActivePath =
      isInitialSelection &&
      !!libraryActivePath &&
      fullSelectedPaths.includes(libraryActivePath) &&
      previewActivePath !== libraryActivePath;

    if (storedPageIndex !== currentPage || shouldAdoptLibraryActivePath) {
      setUI({
        ...(storedPageIndex !== currentPage ? { libraryPreviewPageIndex: currentPage } : {}),
        ...(shouldAdoptLibraryActivePath ? { libraryPreviewActivePath: libraryActivePath } : {}),
      });
    }
  }, [
    currentPage,
    fullSelectedPaths,
    fullSelectedPathsKey,
    libraryActivePath,
    pageImages,
    pageSize,
    previewActivePath,
    selectedImages.length,
    setUI,
    storedPageIndex,
  ]);

  const clearRenderIndicator = useCallback((path: string) => {
    const timer = renderIndicatorTimersRef.current.get(path);
    if (timer) window.clearTimeout(timer);
    renderIndicatorTimersRef.current.delete(path);
    setRenderingPaths((prev) => {
      if (!prev[path]) return prev;
      const next = { ...prev };
      delete next[path];
      return next;
    });
  }, []);

  const scheduleRenderIndicator = useCallback((path: string) => {
    if (isDisposedRef.current || renderIndicatorTimersRef.current.has(path)) return;

    const timer = window.setTimeout(() => {
      if (!isDisposedRef.current && openPathsRef.current.has(path)) {
        setRenderingPaths((prev) => (prev[path] ? prev : { ...prev, [path]: true }));
      }
      renderIndicatorTimersRef.current.delete(path);
    }, CENTER_PREVIEW_RENDER_INDICATOR_DELAY_MS);
    renderIndicatorTimersRef.current.set(path, timer);
  }, []);

  const processPreviewRenderQueue = useCallback(() => {
    if (isDisposedRef.current || runningRenderRef.current) return;

    const nextJob = renderQueueRef.current.shift();
    if (!nextJob) return;

    const isJobCurrent = () =>
      !isDisposedRef.current &&
      openPathsRef.current.has(nextJob.path) &&
      requiredPreviewKeysRef.current.get(nextJob.path) === nextJob.key;

    if (!isJobCurrent()) {
      window.setTimeout(processPreviewRenderQueue, 0);
      return;
    }

    const current = highResPreviewsRef.current[nextJob.path];
    if (current?.key === nextJob.key) {
      clearRenderIndicator(nextJob.path);
      window.setTimeout(processPreviewRenderQueue, 0);
      return;
    }

    runningRenderRef.current = nextJob;
    scheduleRenderIndicator(nextJob.path);

    invoke<LibraryPreviewResponse>(Invokes.GenerateLibraryPreviewForPath, {
      path: nextJob.path,
      maxEdge: nextJob.bucket,
    })
      .then(async (response) => {
        if (!isJobCurrent()) return;

        const url = convertFileSrc(response.previewPath);
        await preloadImageUrl(url);
        if (!isJobCurrent()) return;

        const entry: CenterPreviewEntry = { key: nextJob.key, url };
        setHighResPreviews((prev) => {
          const next = { ...prev, [nextJob.path]: entry };
          highResPreviewsRef.current = next;
          return next;
        });
      })
      .catch((error) => console.error('Failed to render center preview:', error))
      .finally(() => {
        runningRenderRef.current = null;
        if (isDisposedRef.current) return;
        clearRenderIndicator(nextJob.path);
        processPreviewRenderQueue();
      });
  }, [clearRenderIndicator, scheduleRenderIndicator]);

  const enqueuePreviewRenderJobs = useCallback(
    (jobs: CenterPreviewRenderJob[]) => {
      if (isDisposedRef.current) return;

      renderQueueRef.current = renderQueueRef.current.filter(
        (job) => openPathsRef.current.has(job.path) && requiredPreviewKeysRef.current.get(job.path) === job.key,
      );

      jobs.forEach((job) => {
        if (highResPreviewsRef.current[job.path]?.key === job.key) {
          clearRenderIndicator(job.path);
          return;
        }
        if (runningRenderRef.current?.key === job.key) {
          scheduleRenderIndicator(job.path);
          return;
        }
        if (renderQueueRef.current.some((queuedJob) => queuedJob.key === job.key)) {
          scheduleRenderIndicator(job.path);
          return;
        }
        renderQueueRef.current.push(job);
        scheduleRenderIndicator(job.path);
      });

      renderQueueRef.current.sort((a, b) => a.priority - b.priority);
      processPreviewRenderQueue();
    },
    [clearRenderIndicator, processPreviewRenderQueue, scheduleRenderIndicator],
  );

  useEffect(() => {
    const missing = pagePaths.filter((path) => !thumbnails[path]);
    if (missing.length > 0) onRequestThumbnails?.(missing);
  }, [onRequestThumbnails, pagePaths, pagePathsKey, thumbnails]);

  useEffect(() => {
    const previousThumbnails = previousThumbnailsRef.current;

    useLoupeStore.getState().loupes.forEach((loupe) => {
      const previousUrl = previousThumbnails[loupe.path];
      const nextUrl = thumbnails[loupe.path];
      if (previousUrl && nextUrl && previousUrl !== nextUrl) {
        void loadLoupeTile(loupe.id);
      }
    });

    previousThumbnailsRef.current = thumbnails;
  }, [thumbnails]);

  useEffect(() => {
    isDisposedRef.current = false;

    return () => {
      isDisposedRef.current = true;
      if (renderPlanTimeoutRef.current) {
        window.clearTimeout(renderPlanTimeoutRef.current);
        renderPlanTimeoutRef.current = null;
      }
      renderIndicatorTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      renderIndicatorTimersRef.current.clear();
      openPathsRef.current.clear();
      requiredPreviewKeysRef.current.clear();
      renderQueueRef.current = [];
    };
  }, []);

  useEffect(() => {
    const pagePathSet = new Set(pagePaths);
    openPathsRef.current = pagePathSet;
    renderQueueRef.current = renderQueueRef.current.filter((job) => pagePathSet.has(job.path));
    setAspectRatios((prev) => prunePathRecord(prev, pagePathSet));
    setThumbnailMaxEdges((prev) => prunePathRecord(prev, pagePathSet));
    setHighResPreviews((prev) => {
      const next = prunePathRecord(prev, pagePathSet);
      highResPreviewsRef.current = next;
      return next;
    });
    setRenderingPaths((prev) => prunePathRecord(prev, pagePathSet));
  }, [pagePaths, pagePathsKey]);

  useEffect(() => {
    const pagePathSet = new Set(pagePaths);
    const fullSelectedPathSet = new Set(fullSelectedPaths);
    const loupeStore = useLoupeStore.getState();
    const uiState = useUIStore.getState();
    const isLeavingPreviewTemporarily =
      uiState.quickPreviewMode || uiState.libraryPreviewRestoreSelectionPaths.length > 0;
    if (!isLeavingPreviewTemporarily) {
      loupeStore.loupes.forEach((loupe) => {
        if (!fullSelectedPathSet.has(loupe.path)) loupeStore.closeLoupe(loupe.id);
      });
    }

    const { hoverTarget, setLibrary } = useLibraryStore.getState();
    if (hoverTarget && !pagePathSet.has(hoverTarget.path)) {
      setLibrary({ hoverTarget: null });
    }

    if (previewActivePath && !fullSelectedPathSet.has(previewActivePath)) {
      setUI({ libraryPreviewActivePath: null });
    }
  }, [fullSelectedPaths, fullSelectedPathsKey, pagePaths, pagePathsKey, previewActivePath, setUI]);

  const handleImageAspectRatio = useCallback((path: string, aspectRatio: number) => {
    if (!Number.isFinite(aspectRatio) || aspectRatio <= 0) return;
    setAspectRatios((prev) =>
      Math.abs((prev[path] || 0) - aspectRatio) < 0.001 ? prev : { ...prev, [path]: aspectRatio },
    );
  }, []);

  const handlePreviewImageClick = useCallback(
    (path: string, event: PreviewMouseEvent) => {
      event.stopPropagation();
      pageAnchorPathRef.current = path;

      const { libraryActivePath, multiSelectedPaths, setLibrary } = useLibraryStore.getState();
      const isCtrlPressed = event.ctrlKey || event.metaKey;

      if (event.altKey) {
        setLibrary({ multiSelectedPaths: [path], libraryActivePath: path, selectionAnchorPath: path });
        setUI({ libraryPreviewActivePath: path });
        return;
      }

      if (isCtrlPressed) {
        const nextSelection = multiSelectedPaths.filter((selectedPath) => selectedPath !== path);
        const nextActivePath =
          libraryActivePath && nextSelection.includes(libraryActivePath)
            ? libraryActivePath
            : nextSelection[nextSelection.length - 1] || null;

        setLibrary({
          multiSelectedPaths: nextSelection,
          libraryActivePath: nextActivePath,
          selectionAnchorPath: nextActivePath,
        });
        if (previewActivePath === path) setUI({ libraryPreviewActivePath: null });
        return;
      }

      setLibrary({ libraryActivePath: path, selectionAnchorPath: path });
      setUI({ libraryPreviewActivePath: path });
    },
    [previewActivePath, setUI],
  );

  const handlePreviewImageContextMenu = useCallback(
    (event: PreviewMouseEvent, path: string) => {
      if (event.shiftKey) {
        onContextMenu(event, path, { forceSingleSelection: true, preserveSelection: true });
        return;
      }

      onContextMenu(event, path);
    },
    [onContextMenu],
  );

  const handlePageChange = useCallback(
    (nextPage: number) => {
      const clampedPage = clamp(nextPage, 0, pageCount - 1);
      if (clampedPage === currentPage) return;

      useLoupeStore.getState().closeAllLoupes();

      const activeIndex = previewActivePath
        ? selectedImages.findIndex((image) => image.path === previewActivePath)
        : -1;
      const activeOffset = activeIndex >= 0 ? activeIndex % pageSize : -1;
      const nextActiveIndex =
        activeOffset >= 0 ? Math.min(clampedPage * pageSize + activeOffset, selectedImages.length - 1) : -1;
      const nextActivePath = nextActiveIndex >= 0 ? selectedImages[nextActiveIndex]?.path || null : null;

      pageAnchorPathRef.current = nextActivePath || selectedImages[clampedPage * pageSize]?.path || null;
      if (nextActivePath) {
        useLibraryStore.getState().setLibrary({
          libraryActivePath: nextActivePath,
          selectionAnchorPath: nextActivePath,
        });
      }
      setUI({
        libraryPreviewPageIndex: clampedPage,
        ...(nextActivePath ? { libraryPreviewActivePath: nextActivePath } : {}),
      });
    },
    [currentPage, pageCount, pageSize, previewActivePath, selectedImages, setUI],
  );

  const layouts = useMemo(() => {
    const availableWidth = Math.max(0, size.width - PREVIEW_GAP * 2);
    const availableHeight = Math.max(0, size.height - PREVIEW_GAP * 2 - (showPaginationControl ? 40 : 0));
    const images = pageImages.map((image) => ({
      path: image.path,
      aspectRatio: aspectRatios[image.path] || getExifAspectRatio(image) || 3 / 2,
    }));
    const useFixedCells = hasMixedPreviewAspectRatios(images);
    const tiles = useFixedCells
      ? computePreviewFixedCellLayout({
          images,
          containerWidth: availableWidth,
          containerHeight: availableHeight,
          gap: PREVIEW_GAP,
          cellAspectRatio: MIXED_PREVIEW_CELL_ASPECT_RATIO,
        })
      : computePreviewComparisonLayout({
          images,
          containerWidth: availableWidth,
          containerHeight: availableHeight,
          gap: PREVIEW_GAP,
        });

    return new Map(tiles.map((tile) => [tile.path, { ...tile, x: tile.x + PREVIEW_GAP, y: tile.y + PREVIEW_GAP }]));
  }, [aspectRatios, pageImages, showPaginationControl, size.height, size.width]);

  const handleThumbnailLoad = useCallback((path: string, maxEdge: number) => {
    setThumbnailMaxEdges((prev) => (prev[path] === maxEdge ? prev : { ...prev, [path]: maxEdge }));
  }, []);

  useEffect(() => {
    if (renderPlanTimeoutRef.current) {
      window.clearTimeout(renderPlanTimeoutRef.current);
      renderPlanTimeoutRef.current = null;
    }

    const devicePixelRatio = Math.min(
      typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1,
      CENTER_PREVIEW_MAX_DEVICE_PIXEL_RATIO,
    );

    const canUseThumbnailFloor =
      pageImages.length > 0 &&
      pageImages.every((image) => {
        const layout = layouts.get(image.path);
        return !!layout && getCenterPreviewRequiredEdge(layout, devicePixelRatio) <= CENTER_PREVIEW_MIN_THUMBNAIL_EDGE;
      });

    if (canUseThumbnailFloor) {
      requiredPreviewKeysRef.current = new Map();
      renderQueueRef.current = [];
      pageImages.forEach((image) => clearRenderIndicator(image.path));
      return;
    }

    const getRenderRequirement = (image: ImageFile) =>
      getCenterPreviewRenderRequirement({
        devicePixelRatio,
        image,
        layout: layouts.get(image.path),
        thumbnailMaxEdge: thumbnailMaxEdges[image.path] || 0,
        thumbnailUrl: thumbnails[image.path],
      });

    pageImages.forEach((image) => {
      const requirement = getRenderRequirement(image);

      if (!requirement) {
        clearRenderIndicator(image.path);
        return;
      }

      if (highResPreviewsRef.current[image.path]?.key === requirement.key) {
        clearRenderIndicator(image.path);
        return;
      }

      scheduleRenderIndicator(image.path);
    });

    renderPlanTimeoutRef.current = window.setTimeout(() => {
      const jobs: CenterPreviewRenderJob[] = [];
      const nextRequiredKeys = new Map<string, string>();

      pageImages.forEach((image) => {
        const requirement = getRenderRequirement(image);

        if (!requirement) {
          clearRenderIndicator(image.path);
          return;
        }

        nextRequiredKeys.set(image.path, requirement.key);

        if (highResPreviewsRef.current[image.path]?.key === requirement.key) {
          clearRenderIndicator(image.path);
          return;
        }

        const priority =
          image.path === previewActivePath ? -2 : pageImages.length === 1 ? -1 : -requirement.area / 1_000_000;
        jobs.push({ bucket: requirement.bucket, key: requirement.key, path: image.path, priority });
      });

      requiredPreviewKeysRef.current = nextRequiredKeys;
      const selectedImageByPath = new Map(pageImages.map((image) => [image.path, image]));
      setHighResPreviews((prev) => {
        let changed = false;
        const next: Record<string, CenterPreviewEntry> = {};

        Object.entries(prev).forEach(([path, entry]) => {
          const image = selectedImageByPath.get(path);
          if (image && entry.key.startsWith(getPreviewRenderKeyPrefix(image, thumbnails[path]))) {
            next[path] = entry;
          } else {
            changed = true;
          }
        });

        const result = changed ? next : prev;
        highResPreviewsRef.current = result;
        return result;
      });

      enqueuePreviewRenderJobs(jobs);
      renderPlanTimeoutRef.current = null;
    }, CENTER_PREVIEW_RENDER_DEBOUNCE_MS);

    return () => {
      if (renderPlanTimeoutRef.current) {
        window.clearTimeout(renderPlanTimeoutRef.current);
        renderPlanTimeoutRef.current = null;
      }
    };
  }, [
    clearRenderIndicator,
    enqueuePreviewRenderJobs,
    layouts,
    pageImages,
    pagePathsKey,
    previewActivePath,
    scheduleRenderIndicator,
    thumbnailMaxEdges,
    thumbnails,
  ]);

  useLayoutEffect(() => {
    const { hoverTarget, setLibrary } = useLibraryStore.getState();
    if (!hoverTarget) return;

    if (!pagePaths.includes(hoverTarget.path)) {
      setLibrary({ hoverTarget: null });
      return;
    }

    const pointer = hoverTarget.pointer;
    if (!pointer) return;

    const target = document.elementFromPoint(pointer.clientX, pointer.clientY);
    const previewTile = target?.closest('[data-rapidraw-preview-image-path]') as HTMLElement | null;
    if (previewTile?.dataset.rapidrawPreviewImagePath !== hoverTarget.path) {
      setLibrary({ hoverTarget: null });
    }
  }, [layouts, pagePaths, pagePathsKey]);

  return (
    <div
      ref={ref}
      data-rapidraw-loupe-bounds="true"
      className="relative flex-1 min-w-0 h-full overflow-hidden rounded-br-lg bg-bg-primary/60"
      onClick={(event) => {
        if (event.target === event.currentTarget) setUI({ libraryPreviewActivePath: null });
      }}
      onContextMenu={(event) => {
        if (event.target === event.currentTarget) onEmptyAreaContextMenu(event);
      }}
      onPointerMove={(event) => {
        if (event.target === event.currentTarget) {
          const { hoverTarget, setLibrary } = useLibraryStore.getState();
          if (hoverTarget) setLibrary({ hoverTarget: null });
        }
      }}
      onPointerLeave={() => {
        const { hoverTarget, setLibrary } = useLibraryStore.getState();
        if (hoverTarget) setLibrary({ hoverTarget: null });
      }}
    >
      {selectedImages.length === 0 ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center">
          <ImageIcon size={42} className="text-text-secondary" />
          <Text color={TextColors.secondary}>{t('library.preview.noSelection')}</Text>
        </div>
      ) : (
        pageImages.map((image) => {
          const layout = layouts.get(image.path);
          if (!layout) return null;
          return (
            <MemoizedPreviewImageTile
              key={image.path}
              detailsMode={previewDetailsMode}
              image={image}
              highResPreviewUrl={
                highResPreviews[image.path]?.key.startsWith(getPreviewRenderKeyPrefix(image, thumbnails[image.path]))
                  ? highResPreviews[image.path].url
                  : null
              }
              isActive={previewActivePath === image.path}
              isPreviewRendering={!!renderingPaths[image.path]}
              layout={layout}
              onContextMenu={handlePreviewImageContextMenu}
              onImageClick={handlePreviewImageClick}
              onImageDoubleClick={onImageDoubleClick}
              onImageAspectRatio={handleImageAspectRatio}
              onThumbnailLoad={handleThumbnailLoad}
              thumbnailUrl={thumbnails[image.path] || null}
            />
          );
        })
      )}
      {showPaginationControl && (
        <div className="absolute bottom-2 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-md border border-border-color/50 bg-surface/95 px-1 py-1 shadow-md">
          <button
            type="button"
            aria-label={t('library.preview.previousPage')}
            className="flex h-6 w-6 items-center justify-center rounded text-text-secondary transition-colors hover:bg-card-active hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent"
            disabled={currentPage === 0}
            onClick={() => handlePageChange(currentPage - 1)}
          >
            <ChevronLeft size={14} />
          </button>
          <div ref={pageSizeMenuRef} className="relative">
            <button
              type="button"
              aria-expanded={isPageSizeMenuOpen}
              aria-haspopup="dialog"
              className="min-w-24 rounded px-1 py-1 text-center text-xs text-text-secondary tabular-nums transition-colors hover:bg-card-active hover:text-text-primary"
              onClick={() => {
                if (isPageSizeMenuOpen) {
                  commitPageSizeDraft();
                } else {
                  pageSizeDraftRef.current = storedPageSize;
                  setPageSizeDraft(storedPageSize);
                }
                setIsPageSizeMenuOpen((open) => !open);
              }}
            >
              {pageStart + 1}–{Math.min(pageStart + pageSize, selectedImages.length)} / {selectedImages.length}
            </button>
            {isPageSizeMenuOpen && (
              <div
                role="dialog"
                aria-label={t('library.preview.imagesPerPage')}
                className="absolute bottom-full left-1/2 z-20 mb-2 w-56 -translate-x-1/2 rounded-md border border-border-color/50 bg-surface/95 p-3 shadow-lg backdrop-blur-sm"
              >
                <div className="mb-2 flex items-center justify-between gap-3 text-xs">
                  <span className="font-medium text-text-secondary">{t('library.preview.imagesPerPage')}</span>
                  <span className="tabular-nums text-text-primary">{pageSize}</span>
                </div>
                <div className="relative h-5">
                  <div className="pointer-events-none absolute left-0 top-1/2 h-1.5 w-full -translate-y-1/2 rounded-full bg-card-active" />
                  <input
                    aria-label={t('library.preview.imagesPerPage')}
                    className="slider-input absolute left-0 top-1/2 z-10 h-1.5 w-full -translate-y-1/2 cursor-pointer appearance-none bg-transparent p-0"
                    max={LIBRARY_PREVIEW_MAX_PAGE_SIZE}
                    min={LIBRARY_PREVIEW_MIN_PAGE_SIZE}
                    onBlur={commitPageSizeDraft}
                    onChange={(event) => {
                      const nextPageSize = clampLibraryPreviewPageSize(Number(event.target.value));
                      pageSizeDraftRef.current = nextPageSize;
                      setPageSizeDraft(nextPageSize);
                    }}
                    onKeyUp={commitPageSizeDraft}
                    onPointerUp={commitPageSizeDraft}
                    step={1}
                    type="range"
                    value={pageSize}
                  />
                </div>
                <div className="mt-1 flex justify-between text-[10px] text-text-secondary/70 tabular-nums">
                  <span>{LIBRARY_PREVIEW_MIN_PAGE_SIZE}</span>
                  <span>{LIBRARY_PREVIEW_MAX_PAGE_SIZE}</span>
                </div>
              </div>
            )}
          </div>
          <button
            type="button"
            aria-label={t('library.preview.nextPage')}
            className="flex h-6 w-6 items-center justify-center rounded text-text-secondary transition-colors hover:bg-card-active hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent"
            disabled={currentPage >= pageCount - 1}
            onClick={() => handlePageChange(currentPage + 1)}
          >
            <ChevronRight size={14} />
          </button>
        </div>
      )}
      <LoupeOverlay visiblePaths={pagePaths} />
    </div>
  );
}

type PreviewThumbnailCellProps = PreviewImageInteractionHandlers & {
  activePath: string | null;
  cellSize: number;
  exifOverlay: ExifOverlay;
  filenameBlockHeight: number;
  fontFamily: string;
  image: ImageFile;
  isSelected: boolean;
  listTextWidth: number;
  rating: number;
  thumbnailAspectRatio: ThumbnailAspectRatio;
  thumbnailStyle: LibraryPreviewThumbnailStyle;
};

function PreviewThumbnailCell({
  activePath,
  image,
  isSelected,
  rating,
  onContextMenu,
  onImageClick,
  onImageDoubleClick,
  cellSize,
  filenameBlockHeight,
  fontFamily,
  listTextWidth,
  thumbnailAspectRatio,
  exifOverlay,
  thumbnailStyle,
}: PreviewThumbnailCellProps) {
  const thumbnailUrl = useProcessStore((s) => s.thumbnails[image.path]);
  const displayEditIcon = useSettingsStore((s) => s.appSettings?.displayEditIcon ?? true);
  const baseName = getBaseName(image.path);
  const colorLabel = getColorLabelForTags(image.tags);
  const isEdited = !!image.is_edited && displayEditIcon;
  const isListMode = thumbnailStyle === LibraryPreviewThumbnailStyle.List;
  const showFilenameBelow = thumbnailStyle === LibraryPreviewThumbnailStyle.BelowFilename;
  const isNameOverImage = thumbnailStyle === LibraryPreviewThumbnailStyle.NameOverImage;
  const imageClass = thumbnailAspectRatio === ThumbnailAspectRatio.Contain ? 'object-contain' : 'object-cover';
  const isAlways = exifOverlay === ExifOverlay.Always;
  const isHover = exifOverlay === ExifOverlay.Hover;
  const exif = image.exif || {};
  const fNumber = exif.FNumber
    ? String(exif.FNumber).toLowerCase().startsWith('f')
      ? String(exif.FNumber)
      : `f/${exif.FNumber}`
    : '';
  const shutter = exif.ExposureTime || '';
  const iso = exif.PhotographicSensitivity || exif.ISOSpeedRatings || '';
  const focalValue = exif.FocalLengthIn35mmFilm || exif.FocalLength || '';
  const focal = focalValue ? (String(focalValue).endsWith('mm') ? String(focalValue) : `${focalValue}mm`) : '';
  const thumbnailImageSize = Math.max(1, cellSize - PREVIEW_THUMBNAIL_SAFE_INSET * 2);
  const metadataText = [shutter, fNumber, iso, focal].filter(Boolean).join(' · ');
  const listDetailsText = useMemo(() => {
    if (!isListMode) return '';
    const details = [formatPreviewListModifiedDate(image.modified)].filter(Boolean);
    if (exifOverlay !== ExifOverlay.Off) details.push(...[shutter, fNumber, iso, focal].filter(Boolean));
    return getFittingPreviewListDetails(details, listTextWidth, fontFamily);
  }, [exifOverlay, fNumber, focal, fontFamily, image.modified, isListMode, iso, listTextWidth, shutter]);
  const imageInteractionHandlers = getPreviewImageInteractionHandlers(image.path, {
    onContextMenu,
    onImageClick,
    onImageDoubleClick,
  });

  if (isListMode) {
    const rowClass =
      activePath === image.path
        ? 'ring-1 ring-inset ring-accent bg-accent/10'
        : isSelected
          ? 'ring-1 ring-inset ring-accent/50 bg-accent/5'
          : 'hover:bg-surface/80';

    return (
      <div
        className={clsx(
          'group flex w-full items-center gap-2 rounded-md p-1.5 cursor-pointer transition-colors duration-150',
          rowClass,
        )}
        style={{ height: PREVIEW_THUMBNAIL_LIST_ROW_HEIGHT }}
        {...imageInteractionHandlers}
      >
        <div
          className="relative shrink-0 overflow-hidden rounded-sm bg-surface"
          style={{ width: PREVIEW_THUMBNAIL_LIST_IMAGE_SIZE, height: PREVIEW_THUMBNAIL_LIST_IMAGE_SIZE }}
        >
          {thumbnailUrl ? (
            <PreviewCrossfadeImage
              alt={baseName}
              className={clsx('w-full h-full select-none', imageClass)}
              decoding="async"
              draggable={false}
              loading="lazy"
              url={thumbnailUrl}
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center text-text-secondary">
              <ImageIcon size={18} />
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <Text
              as="div"
              variant={TextVariants.small}
              weight={TextWeights.medium}
              className="min-w-0 flex-1 truncate"
              title={baseName}
            >
              {baseName}
            </Text>
            <PreviewStatusBadges
              className="bg-black/30"
              colorLabel={colorLabel}
              isEdited={isEdited}
              isVirtualCopy={!!image.is_virtual_copy}
              outerClassName="shrink-0"
              rating={rating}
            />
          </div>
          {listDetailsText && (
            <Text
              as="div"
              variant={TextVariants.small}
              color={TextColors.secondary}
              className="mt-1 whitespace-nowrap text-[10px] leading-4"
            >
              {listDetailsText}
            </Text>
          )}
        </div>
      </div>
    );
  }

  if (isNameOverImage) {
    return (
      <div style={{ width: cellSize, height: cellSize, padding: PREVIEW_THUMBNAIL_SAFE_INSET }}>
        <div style={{ width: thumbnailImageSize, height: thumbnailImageSize }}>
          <Thumbnail
            isActive={activePath === image.path}
            isSelected={isSelected}
            onContextMenu={onContextMenu}
            onImageClick={onImageClick}
            onImageDoubleClick={onImageDoubleClick}
            onLoad={() => {}}
            path={image.path}
            rating={rating}
            tags={image.tags}
            exif={image.exif}
            isEdited={image.is_edited}
            aspectRatio={thumbnailAspectRatio}
            exifOverlay={exifOverlay}
          />
        </div>
      </div>
    );
  }

  const ringClass =
    activePath === image.path
      ? 'ring-2 ring-inset ring-accent'
      : isSelected
        ? 'ring-2 ring-inset ring-gray-400'
        : 'group-hover:ring-2 group-hover:ring-inset group-hover:ring-hover-color';

  return (
    <div className="group flex flex-col" style={{ width: cellSize, height: cellSize + filenameBlockHeight }}>
      <div
        className="relative overflow-hidden rounded-md bg-surface cursor-pointer transform-gpu [-webkit-mask-image:-webkit-radial-gradient(white,black)]"
        style={{
          width: thumbnailImageSize,
          height: thumbnailImageSize,
          margin: PREVIEW_THUMBNAIL_SAFE_INSET,
          marginBottom: 0,
        }}
        {...imageInteractionHandlers}
      >
        {thumbnailUrl ? (
          <PreviewCrossfadeImage
            alt={baseName}
            className={clsx(
              'w-full h-full select-none group-hover:scale-[1.02] transition-transform duration-300 will-change-transform',
              imageClass,
            )}
            decoding="async"
            draggable={false}
            loading="lazy"
            url={thumbnailUrl}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-text-secondary">
            <ImageIcon size={24} />
          </div>
        )}

        {!!image.is_virtual_copy && (
          <Text
            as="div"
            variant={TextVariants.small}
            weight={TextWeights.bold}
            className="absolute bottom-1.5 right-1.5 z-20 shrink-0 rounded-full bg-black/30 px-1.5 py-0.5 text-white shadow-md backdrop-blur-xs pointer-events-none"
          >
            VC
          </Text>
        )}

        <PreviewStatusBadges
          className="bg-black/30"
          colorLabel={colorLabel}
          isEdited={isEdited}
          outerClassName="absolute top-1.5 right-1.5 z-20 flex items-center justify-end pointer-events-none"
          rating={rating}
        />

        <div className={clsx('absolute inset-0 rounded-md pointer-events-none z-30', ringClass)} />

        {(isAlways || isHover) && metadataText && (
          <div
            className={clsx(
              'absolute inset-x-0 bottom-0 px-1.5 py-1 bg-black/55 text-white text-[9px] leading-tight text-center pointer-events-none',
              isAlways
                ? '[clip-path:inset(0_0_0)]'
                : '[clip-path:inset(100%_0_0)] transition-[clip-path] duration-150 ease-out group-hover:[clip-path:inset(0_0_0)]',
            )}
          >
            {metadataText}
          </div>
        )}
      </div>

      {showFilenameBelow && (
        <div
          className="px-0.5 pt-1 text-center text-[10px] leading-4 text-text-secondary whitespace-normal break-all overflow-hidden"
          style={{
            height: filenameBlockHeight,
            marginLeft: PREVIEW_THUMBNAIL_SAFE_INSET,
            marginRight: PREVIEW_THUMBNAIL_SAFE_INSET,
          }}
          title={baseName}
        >
          {baseName}
        </div>
      )}
    </div>
  );
}

const MemoizedPreviewThumbnailCell = React.memo(PreviewThumbnailCell);

interface PreviewThumbnailRowData {
  filenameBlockHeight: number;
  height: number;
  paths: string[];
  offsetTop: number;
}

interface PreviewThumbnailRowProps extends PreviewImageInteractionHandlers {
  activePath: string | null;
  cellSize: number;
  exifOverlay: ExifOverlay;
  fontFamily: string;
  imageByPath: Map<string, ImageFile>;
  imageRatings: Record<string, number>;
  multiSelectedSet: Set<string>;
  listTextWidth: number;
  queueThumbnailRequest(path: string): void;
  rows: PreviewThumbnailRowData[];
  thumbnailAspectRatio: ThumbnailAspectRatio;
  thumbnailStyle: LibraryPreviewThumbnailStyle;
}

function PreviewThumbnailRow({
  index,
  style,
  rows,
  activePath,
  imageRatings,
  multiSelectedSet,
  onContextMenu,
  onImageClick,
  onImageDoubleClick,
  queueThumbnailRequest,
  cellSize,
  thumbnailAspectRatio,
  exifOverlay,
  fontFamily,
  listTextWidth,
  thumbnailStyle,
  imageByPath,
}: RowComponentProps<PreviewThumbnailRowProps>) {
  const row = rows[index];

  useEffect(() => {
    row?.paths.forEach(queueThumbnailRequest);
  }, [queueThumbnailRequest, row]);

  if (!row) return null;
  const images = row.paths.map((path) => imageByPath.get(path)).filter((image): image is ImageFile => !!image);

  const shiftedStyle = {
    ...style,
    transform:
      typeof style.transform === 'string'
        ? style.transform.replace(
            /translateY\(([^)]+)\)/,
            (_: string, y: string) => `translateY(${parseFloat(y) + PREVIEW_THUMBNAIL_PADDING}px)`,
          )
        : style.transform,
    top: style.transform ? style.top : (Number(style.top) || 0) + PREVIEW_THUMBNAIL_PADDING,
  };

  return (
    <div
      style={{
        ...shiftedStyle,
        left: PREVIEW_THUMBNAIL_PADDING,
        right: PREVIEW_THUMBNAIL_PADDING,
        width: 'auto',
        display: 'flex',
        gap: PREVIEW_THUMBNAIL_GAP,
      }}
    >
      {images.map((image) => (
        <MemoizedPreviewThumbnailCell
          key={image.path}
          activePath={activePath}
          cellSize={cellSize}
          filenameBlockHeight={row.filenameBlockHeight}
          thumbnailAspectRatio={thumbnailAspectRatio}
          exifOverlay={exifOverlay}
          fontFamily={fontFamily}
          listTextWidth={listTextWidth}
          thumbnailStyle={thumbnailStyle}
          image={image}
          isSelected={multiSelectedSet.has(image.path)}
          rating={imageRatings[image.path] || 0}
          onContextMenu={onContextMenu}
          onImageClick={onImageClick}
          onImageDoubleClick={onImageDoubleClick}
        />
      ))}
    </div>
  );
}

type PreviewThumbnailGridProps = PreviewImageInteractionHandlers & {
  activePath: string | null;
  exifOverlay: ExifOverlay;
  imageList: ImageFile[];
  imageRatings: Record<string, number>;
  multiSelectedSet: Set<string>;
  queueThumbnailRequest(path: string): void;
  thumbnailAspectRatio: ThumbnailAspectRatio;
  thumbnailStyle: LibraryPreviewThumbnailStyle;
  thumbnailsPerRow: number;
};

function PreviewThumbnailGrid({
  activePath,
  imageList,
  imageRatings,
  multiSelectedSet,
  onContextMenu,
  onImageClick,
  onImageDoubleClick,
  queueThumbnailRequest,
  thumbnailsPerRow,
  thumbnailAspectRatio,
  exifOverlay,
  thumbnailStyle,
}: PreviewThumbnailGridProps) {
  const { ref, size } = useElementSize<HTMLDivElement>();
  const [listHandle, setListHandle] = useListCallbackRef();
  const fontFamilySetting = useSettingsStore(
    (state) => (state.appSettings as { fontFamily?: string } | undefined)?.fontFamily || 'poppins',
  );
  const [fontMetricsVersion, setFontMetricsVersion] = useState(0);
  const scrollTopRef = useRef(useUIStore.getState().libraryPreviewThumbnailScrollTop);
  const persistScrollFrameRef = useRef<number | null>(null);
  const suppressTransientZeroUntilRef = useRef(scrollTopRef.current > 0 ? Date.now() + 1000 : 0);
  const imagePathCandidates = useMemo(() => imageList.map((image) => image.path), [imageList]);
  const imagePaths = useShallowStableArray(imagePathCandidates);
  const imageByPath = useMemo(() => new Map(imageList.map((image) => [image.path, image])), [imageList]);

  useEffect(() => {
    let cancelled = false;
    let animationFrame: number | null = null;

    const refreshFontMetrics = () => {
      if (cancelled) return;
      animationFrame = window.requestAnimationFrame(() => {
        if (!cancelled) setFontMetricsVersion((version) => version + 1);
      });
    };

    if ('fonts' in document) {
      void document.fonts.ready.then(refreshFontMetrics, refreshFontMetrics);
    } else {
      refreshFontMetrics();
    }

    return () => {
      cancelled = true;
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
    };
  }, [fontFamilySetting]);

  const gridData = useMemo(() => {
    if (size.width <= 0) return null;

    const availableWidth = Math.max(1, size.width - PREVIEW_THUMBNAIL_PADDING * 2);
    const isListMode = thumbnailStyle === LibraryPreviewThumbnailStyle.List;
    const columnCount = isListMode ? 1 : clamp(Math.round(thumbnailsPerRow), 1, 6);
    const cellSize = isListMode
      ? availableWidth
      : Math.max(32, Math.floor((availableWidth - PREVIEW_THUMBNAIL_GAP * (columnCount - 1)) / columnCount));
    const listTextWidth = isListMode
      ? Math.max(
          1,
          availableWidth -
            PREVIEW_THUMBNAIL_LIST_HORIZONTAL_PADDING * 2 -
            PREVIEW_THUMBNAIL_LIST_IMAGE_SIZE -
            PREVIEW_THUMBNAIL_GAP,
        )
      : 0;
    const showFilenameBelow = thumbnailStyle === LibraryPreviewThumbnailStyle.BelowFilename;
    const filenameTextWidth = showFilenameBelow
      ? Math.max(1, cellSize - PREVIEW_THUMBNAIL_SAFE_INSET * 2 - PREVIEW_THUMBNAIL_FILENAME_HORIZONTAL_PADDING)
      : 0;
    const filenameContext = showFilenameBelow ? document.createElement('canvas').getContext('2d') : null;

    if (filenameContext) {
      filenameContext.font = `400 ${PREVIEW_THUMBNAIL_FILENAME_FONT_SIZE}px ${getComputedStyle(document.body).fontFamily}`;
    }

    const rows: PreviewThumbnailRowData[] = [];
    let offsetTop = 0;

    for (let i = 0; i < imagePaths.length; i += columnCount) {
      const paths = imagePaths.slice(i, i + columnCount);
      let filenameLineCount = 0;

      if (showFilenameBelow) {
        filenameLineCount = PREVIEW_THUMBNAIL_FILENAME_MAX_LINES;

        if (filenameContext) {
          filenameLineCount = 1;
          for (const path of paths) {
            filenameLineCount = Math.max(
              filenameLineCount,
              getFilenameLineCount(filenameContext, getBaseName(path), filenameTextWidth),
            );
            if (filenameLineCount >= PREVIEW_THUMBNAIL_FILENAME_MAX_LINES) break;
          }
        }
      }

      const filenameBlockHeight = showFilenameBelow
        ? filenameLineCount * PREVIEW_THUMBNAIL_FILENAME_LINE_HEIGHT + PREVIEW_THUMBNAIL_FILENAME_PADDING
        : 0;
      const height = isListMode
        ? PREVIEW_THUMBNAIL_LIST_ROW_HEIGHT + PREVIEW_THUMBNAIL_GAP
        : cellSize + filenameBlockHeight + PREVIEW_THUMBNAIL_GAP;

      rows.push({ filenameBlockHeight, height, paths, offsetTop });
      offsetTop += height;
    }

    return { rows, cellSize, listTextWidth, totalHeight: offsetTop };
  }, [fontMetricsVersion, imagePaths, size.width, thumbnailsPerRow, thumbnailStyle]);

  const rowProps = useMemo(
    () => ({
      activePath,
      cellSize: gridData?.cellSize || 72,
      thumbnailAspectRatio,
      exifOverlay,
      fontFamily: fontFamilySetting,
      listTextWidth: gridData?.listTextWidth || 0,
      thumbnailStyle,
      imageByPath,
      imageRatings,
      multiSelectedSet,
      onContextMenu,
      onImageClick,
      onImageDoubleClick,
      queueThumbnailRequest,
      rows: gridData?.rows || [],
    }),
    [
      activePath,
      gridData?.cellSize,
      gridData?.listTextWidth,
      gridData?.rows,
      fontFamilySetting,
      imageByPath,
      imageRatings,
      multiSelectedSet,
      onContextMenu,
      onImageClick,
      onImageDoubleClick,
      queueThumbnailRequest,
      thumbnailAspectRatio,
      exifOverlay,
      thumbnailStyle,
    ],
  );

  const getRowHeight = useCallback(
    (index: number) => {
      if (!gridData) return 72;
      return gridData.rows[index]?.height ?? PREVIEW_THUMBNAIL_PADDING;
    },
    [gridData],
  );

  useEffect(() => {
    const element = listHandle?.element as HTMLElement | undefined;
    if (!element) return;

    const captureScrollTop = () => {
      const nextScrollTop = element.scrollTop;
      const uiState = useUIStore.getState();
      const shouldIgnoreTransientZero =
        nextScrollTop <= 0 &&
        uiState.libraryPreviewThumbnailScrollTop > 0 &&
        (uiState.quickPreviewMode || Date.now() < suppressTransientZeroUntilRef.current);

      if (shouldIgnoreTransientZero) {
        scrollTopRef.current = uiState.libraryPreviewThumbnailScrollTop;
        return;
      }

      scrollTopRef.current = nextScrollTop;

      if (!uiState.quickPreviewMode && persistScrollFrameRef.current === null) {
        persistScrollFrameRef.current = window.requestAnimationFrame(() => {
          persistScrollFrameRef.current = null;
          useUIStore.getState().setUI({ libraryPreviewThumbnailScrollTop: scrollTopRef.current });
        });
      }
    };

    element.addEventListener('scroll', captureScrollTop, { passive: true });

    return () => {
      const uiState = useUIStore.getState();
      const nextScrollTop = element.scrollTop;
      const preservedScrollTop = uiState.libraryPreviewThumbnailScrollTop;
      const shouldKeepPreservedScrollTop =
        nextScrollTop <= 0 &&
        preservedScrollTop > 0 &&
        (uiState.quickPreviewMode || Date.now() < suppressTransientZeroUntilRef.current);

      if (persistScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(persistScrollFrameRef.current);
        persistScrollFrameRef.current = null;
      }

      scrollTopRef.current = shouldKeepPreservedScrollTop ? preservedScrollTop : nextScrollTop;
      useUIStore.getState().setUI({ libraryPreviewThumbnailScrollTop: scrollTopRef.current });
      element.removeEventListener('scroll', captureScrollTop);
    };
  }, [listHandle]);

  useLayoutEffect(() => {
    const element = listHandle?.element as HTMLElement | undefined;
    if (!element) return;

    let frameId: number | null = null;
    let attempts = 0;

    const restoreScrollTop = () => {
      const persistedScrollTop = useUIStore.getState().libraryPreviewThumbnailScrollTop;
      const targetScrollTop = scrollTopRef.current > 0 ? scrollTopRef.current : persistedScrollTop;
      if (targetScrollTop <= 0) return;

      const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
      if (maxScrollTop <= 0 && attempts < 30) {
        attempts += 1;
        frameId = window.requestAnimationFrame(restoreScrollTop);
        return;
      }

      const nextScrollTop = clamp(targetScrollTop, 0, maxScrollTop);
      scrollTopRef.current = nextScrollTop;
      if (nextScrollTop > 0) {
        suppressTransientZeroUntilRef.current = Date.now() + 1000;
      }

      if (Math.abs(element.scrollTop - nextScrollTop) > 1) {
        element.scrollTop = nextScrollTop;
      }
    };

    frameId = window.requestAnimationFrame(restoreScrollTop);
    return () => {
      if (frameId !== null) window.cancelAnimationFrame(frameId);
    };
  }, [gridData?.rows.length, gridData?.totalHeight, listHandle]);

  useEffect(() => {
    const handleRevealThumbnail = (event: Event) => {
      if (!gridData || !listHandle?.element) return;

      const path = (event as CustomEvent<LibraryPreviewRevealThumbnailDetail>).detail?.path;
      if (!path) return;

      const activeIndex = imagePaths.indexOf(path);
      if (activeIndex === -1) return;

      const element = listHandle.element as HTMLElement;
      const columnCount = Math.max(1, gridData.rows[0]?.paths.length || 1);
      const rowIndex = Math.floor(activeIndex / columnCount);
      const row = gridData.rows[rowIndex];
      if (!row) return;

      const targetTop = row.offsetTop + PREVIEW_THUMBNAIL_PADDING;
      const targetBottom = targetTop + row.height - PREVIEW_THUMBNAIL_GAP;
      const visibleTop = element.scrollTop;
      const visibleBottom = visibleTop + element.clientHeight;

      let nextScrollTop: number | null = null;
      if (targetBottom > visibleBottom) {
        nextScrollTop = targetBottom - element.clientHeight;
      } else if (targetTop < visibleTop) {
        nextScrollTop = Math.max(0, targetTop);
      }

      if (nextScrollTop !== null) {
        element.scrollTo({ top: nextScrollTop, behavior: 'auto' });
        scrollTopRef.current = nextScrollTop;
        useUIStore.getState().setUI({ libraryPreviewThumbnailScrollTop: nextScrollTop });
      }
    };

    window.addEventListener(LIBRARY_PREVIEW_REVEAL_THUMBNAIL_EVENT, handleRevealThumbnail);
    return () => window.removeEventListener(LIBRARY_PREVIEW_REVEAL_THUMBNAIL_EVENT, handleRevealThumbnail);
  }, [gridData, imagePaths, listHandle]);

  return (
    <div ref={ref} className="min-h-0 flex-1">
      {gridData && (
        <List
          listRef={setListHandle}
          className="custom-scrollbar library-preview-thumbnail-list"
          rowComponent={PreviewThumbnailRow}
          rowCount={gridData.rows.length + 1}
          rowHeight={getRowHeight}
          rowProps={rowProps}
          style={{ height: '100%', width: '100%' }}
        />
      )}
    </div>
  );
}

function commonValue<T>(items: ImageFile[], getter: (image: ImageFile) => T | null | undefined, multipleText: string) {
  if (items.length === 0) return '-';

  const normalize = (value: T | null | undefined) =>
    value === null || value === undefined || value === '' ? '-' : String(value);
  const firstValue = normalize(getter(items[0]));

  for (let index = 1; index < items.length; index += 1) {
    if (normalize(getter(items[index])) !== firstValue) return multipleText;
  }

  return firstValue;
}

function MetadataRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 border-b border-border-color/25 last:border-b-0">
      <Text variant={TextVariants.small} color={TextColors.secondary} className="shrink-0">
        {label}
      </Text>
      <Text variant={TextVariants.small} color={TextColors.primary} className="min-w-0 break-words text-right">
        {value}
      </Text>
    </div>
  );
}

function LibrarySelectionMetadataPanel({
  imageRatings,
  selectedImages,
}: {
  imageRatings: Record<string, number>;
  selectedImages: ImageFile[];
}) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const persistScrollFrameRef = useRef<number | null>(null);
  const setUI = useUIStore((state) => state.setUI);
  const multiple = t('library.preview.multipleValues');
  const count = selectedImages.length;
  const ratingValue = commonValue(selectedImages, (image) => imageRatings[image.path] || 0, multiple);
  const colorValue = commonValue(
    selectedImages,
    (image) => {
      const colorName = getColorLabelForTags(image.tags)?.name;
      return colorName
        ? t(`contextMenus.colors.${colorName}`, {
            defaultValue: colorName.charAt(0).toUpperCase() + colorName.slice(1),
          })
        : null;
    },
    multiple,
  );
  const modifiedValue = commonValue(
    selectedImages,
    (image) => new Date(image.modified > 1e11 ? image.modified : image.modified * 1000).toLocaleString(),
    multiple,
  );
  const dimensionsValue = commonValue(
    selectedImages,
    (image) => {
      const dimensions = getExifDimensions(image);
      return dimensions ? `${Math.round(dimensions.width)} × ${Math.round(dimensions.height)}` : null;
    },
    multiple,
  );
  const cameraValue = commonValue(
    selectedImages,
    (image) => {
      const exif = image.exif || {};
      return `${exif.Make || ''} ${exif.Model || ''}`.trim();
    },
    multiple,
  );
  const extendedExifEntries =
    count === 1 ? Object.entries(selectedImages[0].exif || {}).sort(([keyA], [keyB]) => keyA.localeCompare(keyB)) : [];

  const selectedMetadataKey = useMemo(() => selectedImages.map((image) => image.path).join('\u0000'), [selectedImages]);

  const persistMetadataScrollTop = useCallback(() => {
    const element = scrollRef.current;
    if (!element || persistScrollFrameRef.current !== null) return;

    persistScrollFrameRef.current = window.requestAnimationFrame(() => {
      persistScrollFrameRef.current = null;
      setUI({ libraryPreviewMetadataScrollTop: element.scrollTop });
    });
  }, [setUI]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    let frameId: number | null = null;
    let attempts = 0;

    const restoreScrollTop = () => {
      const targetScrollTop = useUIStore.getState().libraryPreviewMetadataScrollTop;
      if (targetScrollTop <= 0) return;

      const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
      if (maxScrollTop <= 0 && attempts < 10) {
        attempts += 1;
        frameId = window.requestAnimationFrame(restoreScrollTop);
        return;
      }

      element.scrollTop = clamp(targetScrollTop, 0, maxScrollTop);
    };

    frameId = window.requestAnimationFrame(restoreScrollTop);
    return () => {
      if (frameId !== null) window.cancelAnimationFrame(frameId);
    };
  }, [selectedMetadataKey]);

  useEffect(() => {
    const element = scrollRef.current;
    return () => {
      if (persistScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(persistScrollFrameRef.current);
        persistScrollFrameRef.current = null;
      }
      if (element) setUI({ libraryPreviewMetadataScrollTop: element.scrollTop });
    };
  }, [setUI]);

  return (
    <div
      ref={scrollRef}
      className="h-full min-h-0 overflow-y-auto custom-scrollbar px-3 py-3"
      onScroll={persistMetadataScrollTop}
    >
      <Text variant={TextVariants.label} weight={TextWeights.semibold} className="mb-2">
        {t('library.preview.metadata')}
      </Text>
      {count === 0 ? (
        <Text variant={TextVariants.small} color={TextColors.secondary}>
          {t('library.preview.noSelection')}
        </Text>
      ) : (
        <div className="space-y-4">
          <div className="space-y-0.5">
            <MetadataRow
              label={t('library.preview.fields.fileName')}
              value={commonValue(selectedImages, (image) => getBaseName(image.path), multiple)}
            />
            <MetadataRow label={t('library.preview.fields.modified')} value={modifiedValue} />
            <MetadataRow label={t('library.preview.fields.dimensions')} value={dimensionsValue} />
            <MetadataRow
              label={t('library.preview.fields.shutter')}
              value={commonValue(selectedImages, (image) => (image.exif || {}).ExposureTime, multiple)}
            />
            <MetadataRow
              label={t('library.preview.fields.aperture')}
              value={commonValue(selectedImages, (image) => (image.exif || {}).FNumber, multiple)}
            />
            <MetadataRow
              label={t('library.preview.fields.iso')}
              value={commonValue(
                selectedImages,
                (image) => {
                  const exif = image.exif || {};
                  return exif.PhotographicSensitivity || exif.ISOSpeedRatings;
                },
                multiple,
              )}
            />
            <MetadataRow
              label={t('library.preview.fields.focalLength')}
              value={commonValue(
                selectedImages,
                (image) => {
                  const exif = image.exif || {};
                  return exif.FocalLengthIn35mmFilm || exif.FocalLength;
                },
                multiple,
              )}
            />
            <MetadataRow
              label={t('library.preview.fields.lens')}
              value={commonValue(
                selectedImages,
                (image) => {
                  const exif = image.exif || {};
                  return exif.LensModel || exif.Lens || exif.LensMake;
                },
                multiple,
              )}
            />
            <MetadataRow label={t('library.preview.fields.camera')} value={cameraValue} />
            <MetadataRow label={t('library.preview.fields.rating')} value={ratingValue} />
            <MetadataRow label={t('library.preview.fields.label')} value={colorValue} />
            <MetadataRow
              label={t('library.preview.fields.edited')}
              value={commonValue(
                selectedImages,
                (image) => (image.is_edited ? t('library.preview.yes') : t('library.preview.no')),
                multiple,
              )}
            />
            <MetadataRow
              label={t('library.preview.fields.virtualCopy')}
              value={commonValue(
                selectedImages,
                (image) => (image.is_virtual_copy ? t('library.preview.yes') : t('library.preview.no')),
                multiple,
              )}
            />
          </div>

          {extendedExifEntries.length > 0 && (
            <div>
              <Text variant={TextVariants.label} weight={TextWeights.semibold} className="mb-2">
                {t('editor.metadata.extendedExif.title')}
              </Text>
              <div className="space-y-0.5">
                {extendedExifEntries.map(([tag, value]) => (
                  <MetadataRow key={tag} label={formatExifTag(tag)} value={value} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

type LibraryPreviewRightPanelProps = PreviewImageInteractionHandlers & {
  activePath: string | null;
  imageList: ImageFile[];
  imageRatings: Record<string, number>;
  multiSelectedSet: Set<string>;
  onRequestThumbnails?(paths: string[]): void;
  selectedImages: ImageFile[];
};

function LibraryPreviewRightPanel({
  activePath,
  imageList,
  imageRatings,
  multiSelectedSet,
  onContextMenu,
  onImageClick,
  onImageDoubleClick,
  onRequestThumbnails,
  selectedImages,
}: LibraryPreviewRightPanelProps) {
  const { t } = useTranslation();
  const { activeAlbumId, currentFolderPath } = useLibraryStore(
    useShallow((state) => ({
      activeAlbumId: state.activeAlbumId,
      currentFolderPath: state.currentFolderPath,
    })),
  );
  const requestQueueRef = useRef<Set<string>>(new Set());
  const requestTimeoutRef = useRef<number | null>(null);
  const activeResizeCleanupRef = useRef<(() => void) | null>(null);
  const [isPanelResizing, setIsPanelResizing] = useState(false);
  const [resizingPanelWidth, setResizingPanelWidth] = useState<number | null>(null);
  const [resizingMetadataHeight, setResizingMetadataHeight] = useState<number | null>(null);
  const { ref: panelRef, size: panelSize } = useElementSize<HTMLElement>();
  const {
    metadataHeight,
    panelVisible,
    panelWidth,
    setUI,
    thumbnailsPerRow,
    thumbnailAspectRatio,
    exifOverlay,
    thumbnailStyle,
  } = useUIStore(
    useShallow((state) => ({
      metadataHeight: state.libraryPreviewMetadataHeight,
      panelVisible: state.uiVisibility.libraryPreviewPanel !== false,
      panelWidth: state.libraryPreviewRightPanelWidth,
      setUI: state.setUI,
      thumbnailsPerRow: state.libraryPreviewThumbnailsPerRow,
      thumbnailAspectRatio: state.libraryPreviewThumbnailAspectRatio,
      exifOverlay: state.libraryPreviewExifOverlay,
      thumbnailStyle: state.libraryPreviewThumbnailStyle,
    })),
  );
  const effectivePanelWidth = resizingPanelWidth ?? panelWidth;
  const effectiveMetadataHeight = resizingMetadataHeight ?? metadataHeight;
  const maxMetadataHeight =
    panelSize.height > 0
      ? Math.max(MIN_METADATA_HEIGHT, panelSize.height - MIN_THUMBNAIL_AREA_HEIGHT)
      : Math.max(MIN_METADATA_HEIGHT, effectiveMetadataHeight);
  const clampedMetadataHeight = clamp(effectiveMetadataHeight, MIN_METADATA_HEIGHT, maxMetadataHeight);
  const isListMode = thumbnailStyle === LibraryPreviewThumbnailStyle.List;
  const sourceLabel = currentFolderPath
    ? activeAlbumId
      ? currentFolderPath.replace(/^Album:\s*/, '')
      : getBaseName(currentFolderPath)
    : '';
  const SourceIcon = activeAlbumId ? AlbumIcon : Folder;
  const nextThumbnailsPerRow = thumbnailsPerRow >= 6 ? 1 : thumbnailsPerRow + 1;

  useEffect(
    () => () => {
      if (requestTimeoutRef.current) window.clearTimeout(requestTimeoutRef.current);
      activeResizeCleanupRef.current?.();
      activeResizeCleanupRef.current = null;
    },
    [],
  );

  const queueThumbnailRequest = useCallback(
    (path: string) => {
      if (!onRequestThumbnails) return;
      if (useProcessStore.getState().thumbnails[path]) return;
      requestQueueRef.current.add(path);
      if (!requestTimeoutRef.current) {
        requestTimeoutRef.current = window.setTimeout(() => {
          const paths = Array.from(requestQueueRef.current);
          if (paths.length > 0) onRequestThumbnails(paths);
          requestQueueRef.current.clear();
          requestTimeoutRef.current = null;
        }, 50);
      }
    },
    [onRequestThumbnails],
  );

  const startWidthResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();

      const startX = event.clientX;
      const startWidth = effectivePanelWidth;
      let finalWidth = startWidth;
      setIsPanelResizing(true);

      startPointerResize(
        activeResizeCleanupRef,
        (moveEvent) => {
          finalWidth = clamp(startWidth + startX - moveEvent.clientX, MIN_RIGHT_PANEL_WIDTH, MAX_RIGHT_PANEL_WIDTH);
          setResizingPanelWidth(finalWidth);
        },
        () => {
          setIsPanelResizing(false);
          setResizingPanelWidth(null);
          setUI({ libraryPreviewRightPanelWidth: Math.round(finalWidth) });
        },
      );
    },
    [effectivePanelWidth, setUI],
  );

  const startHeightResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();

      const startY = event.clientY;
      const startHeight = clampedMetadataHeight;
      let finalHeight = startHeight;

      startPointerResize(
        activeResizeCleanupRef,
        (moveEvent) => {
          finalHeight = clamp(startHeight + startY - moveEvent.clientY, MIN_METADATA_HEIGHT, maxMetadataHeight);
          setResizingMetadataHeight(finalHeight);
        },
        () => {
          setResizingMetadataHeight(null);
          setUI({ libraryPreviewMetadataHeight: Math.round(finalHeight) });
        },
      );
    },
    [clampedMetadataHeight, maxMetadataHeight, setUI],
  );

  return (
    <>
      {panelVisible && <Resizer direction={Orientation.Vertical} onMouseDown={startWidthResize} />}
      <aside
        ref={panelRef}
        className={clsx(
          'relative h-full min-h-0 shrink-0 overflow-hidden rounded-bl-lg border-l border-border-color/40 bg-bg-secondary',
          !isPanelResizing && 'transition-[width] duration-300 ease-in-out',
        )}
        style={{ width: panelVisible ? effectivePanelWidth : 32 }}
      >
        {!panelVisible && (
          <button
            type="button"
            className="absolute top-1/2 -translate-y-1/2 left-1 w-6 h-10 hover:bg-card-active rounded-md flex items-center justify-center z-30"
            onClick={() => setUI((state) => ({ uiVisibility: { ...state.uiVisibility, libraryPreviewPanel: true } }))}
            data-tooltip={t('library.preview.showPanel')}
          >
            <ChevronLeft size={16} className="text-text-secondary" />
          </button>
        )}

        <div
          className={clsx(
            'h-full min-h-0 flex flex-col transition-opacity duration-150 ease-in-out',
            panelVisible ? 'visible opacity-100' : 'invisible pointer-events-none opacity-0',
          )}
          style={{ width: effectivePanelWidth }}
          aria-hidden={!panelVisible}
        >
          <div className="shrink-0 border-b border-border-color/40 p-2">
            <div className="pt-1 pb-2">
              <div className="flex items-center gap-1">
                <div className="relative flex-1 min-w-0">
                  <div
                    className="w-full h-9 bg-surface border border-transparent rounded-md px-3 py-2 flex items-center gap-2"
                    title={currentFolderPath || sourceLabel}
                  >
                    {sourceLabel && <SourceIcon size={16} className="shrink-0 text-text-secondary" />}
                    <Text
                      variant={TextVariants.label}
                      weight={TextWeights.semibold}
                      className="min-w-0 flex-1 truncate"
                    >
                      {sourceLabel}
                    </Text>
                    <Text variant={TextVariants.small} color={TextColors.secondary} className="shrink-0">
                      ({imageList.length})
                    </Text>
                  </div>
                </div>
                {!isListMode && (
                  <button
                    type="button"
                    className="bg-surface rounded-md hover:bg-card-active flex items-center justify-center shrink-0 transition-colors w-9 h-9 text-sm font-semibold tabular-nums text-text-secondary"
                    onClick={() => setUI({ libraryPreviewThumbnailsPerRow: nextThumbnailsPerRow })}
                    data-tooltip={`${t('library.header.viewOptions.thumbnailsPerRow')}: ${thumbnailsPerRow}`}
                  >
                    {thumbnailsPerRow}
                  </button>
                )}
                <button
                  type="button"
                  className="bg-surface rounded-md hover:bg-card-active flex items-center justify-center shrink-0 transition-colors w-9 h-9"
                  onClick={() =>
                    setUI((state) => ({ uiVisibility: { ...state.uiVisibility, libraryPreviewPanel: false } }))
                  }
                  data-tooltip={t('library.preview.hidePanel')}
                >
                  <ChevronRight size={17.5} className="text-text-secondary" />
                </button>
              </div>
            </div>
          </div>
          <div className="min-h-0 flex-1 flex flex-col">
            <PreviewThumbnailGrid
              activePath={activePath}
              imageList={imageList}
              imageRatings={imageRatings}
              multiSelectedSet={multiSelectedSet}
              onContextMenu={onContextMenu}
              onImageClick={onImageClick}
              onImageDoubleClick={onImageDoubleClick}
              queueThumbnailRequest={queueThumbnailRequest}
              thumbnailsPerRow={thumbnailsPerRow}
              thumbnailAspectRatio={thumbnailAspectRatio}
              exifOverlay={exifOverlay}
              thumbnailStyle={thumbnailStyle}
            />
          </div>
          <Resizer direction={Orientation.Horizontal} onMouseDown={startHeightResize} />
          <div className="shrink-0 border-t border-border-color/40" style={{ height: clampedMetadataHeight }}>
            <LibrarySelectionMetadataPanel imageRatings={imageRatings} selectedImages={selectedImages} />
          </div>
        </div>
      </aside>
    </>
  );
}

export default function LibraryPreviewMode(props: LibraryPreviewModeProps) {
  const {
    activePath,
    imageList,
    imageRatings,
    multiSelectedPaths,
    onContextMenu,
    onEmptyAreaContextMenu,
    onImageClick,
    onImageDoubleClick,
    onRequestThumbnails,
  } = props;

  const { previewActivePath, setUI } = useUIStore(
    useShallow((state) => ({
      previewActivePath: state.libraryPreviewActivePath,
      setUI: state.setUI,
    })),
  );
  useEffect(
    () => () => {
      const { hoverTarget, setLibrary } = useLibraryStore.getState();
      if (hoverTarget) setLibrary({ hoverTarget: null });
    },
    [],
  );

  const multiSelectedSet = useMemo(() => new Set<string>(multiSelectedPaths), [multiSelectedPaths]);
  const thumbnailClickSelectionRef = useRef<string[]>([]);
  const selectedImages = useMemo(() => {
    const selectedSet = new Set<string>(multiSelectedPaths);
    if (selectedSet.size > 0) return imageList.filter((image: ImageFile) => selectedSet.has(image.path));
    if (activePath) return imageList.filter((image: ImageFile) => image.path === activePath);
    return [];
  }, [activePath, imageList, multiSelectedPaths]);

  const handlePreviewImageDoubleClick = useCallback(
    (path: string) => {
      const selection = useLibraryStore.getState().multiSelectedPaths;
      setUI({
        libraryPreviewRestoreSelectionPaths: selection.length > 1 && selection.includes(path) ? [...selection] : [],
      });
      onImageDoubleClick(path);
    },
    [onImageDoubleClick, setUI],
  );

  const handlePreviewThumbnailClick = useCallback(
    (path: string, event: PreviewMouseEvent) => {
      if (event.detail === 1) {
        const selection = useLibraryStore.getState().multiSelectedPaths;
        thumbnailClickSelectionRef.current = selection.length > 1 && selection.includes(path) ? [...selection] : [];
      }

      onImageClick(path, event);
    },
    [onImageClick],
  );

  const handlePreviewThumbnailDoubleClick = useCallback(
    (path: string) => {
      const restoreSelection = thumbnailClickSelectionRef.current;
      thumbnailClickSelectionRef.current = [];
      setUI({ libraryPreviewRestoreSelectionPaths: [...restoreSelection] });
      onImageDoubleClick(path);
    },
    [onImageDoubleClick, setUI],
  );

  return (
    <div className="flex-1 min-h-0 min-w-0 flex bg-bg-primary">
      <SelectionPreviewCanvas
        previewActivePath={previewActivePath}
        libraryActivePath={activePath}
        onContextMenu={onContextMenu}
        onEmptyAreaContextMenu={onEmptyAreaContextMenu}
        onImageDoubleClick={handlePreviewImageDoubleClick}
        onRequestThumbnails={onRequestThumbnails}
        selectedImages={selectedImages}
      />
      <LibraryPreviewRightPanel
        activePath={activePath}
        imageList={imageList}
        imageRatings={imageRatings}
        multiSelectedSet={multiSelectedSet}
        onContextMenu={onContextMenu}
        onImageClick={handlePreviewThumbnailClick}
        onImageDoubleClick={handlePreviewThumbnailDoubleClick}
        onRequestThumbnails={onRequestThumbnails}
        selectedImages={selectedImages}
      />
    </div>
  );
}
