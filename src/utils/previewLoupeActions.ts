import { LibraryLayoutMode } from '../components/ui/AppProperties';
import { useEditorStore } from '../store/useEditorStore';
import { MAX_LOUPES_PER_IMAGE, useLoupeStore } from '../store/useLoupeStore';
import { useLibraryStore } from '../store/useLibraryStore';
import { useProcessStore } from '../store/useProcessStore';
import { useUIStore } from '../store/useUIStore';
import { getImageTargetGeometry, getNormalizedPointFromObjectFit } from './imageCoordinateUtils';
import {
  chooseNextLoupeSlot,
  clampPointToRect,
  getLoupePositionForTip,
  getLoupeSafeBounds,
  getLoupeWindowRect,
} from './loupePlacement';
import { loadLoupeTile } from './loupeTileLoader';

const INITIAL_LOUPE_RENDER_DELAY_MS = 120;

function getBaseName(path: string) {
  return path.split(/[\\/]/).pop()?.split('?vc=')[0] || path;
}

function findPreviewLoupeTargetElement(path: string, thumbnailUrl: string | null) {
  const roots = document.querySelectorAll<HTMLElement>('[data-rapidraw-loupe-path]');
  const root = Array.from(roots).find((item) => item.dataset.rapidrawLoupePath === path);
  if (!root) return null;

  const imageArea = root.querySelector<HTMLElement>('[data-rapidraw-loupe-image-area="true"]') || root;
  const objectFit = 'contain' as const;
  const { imageAspectRatio, imageRect, itemRect } = getImageTargetGeometry(root, imageArea, objectFit);
  if (itemRect.width <= 0 || itemRect.height <= 0 || imageRect.width <= 0 || imageRect.height <= 0) return null;

  return {
    path,
    fileName: getBaseName(path),
    itemRect,
    imageRect,
    pointer: null,
    imageAspectRatio,
    objectFit,
    thumbnailUrl,
  };
}

export function getPreviewLoupeShortcutTargetPath(): string | null {
  const { selectedImage } = useEditorStore.getState();
  const { hoverTarget, multiSelectedPaths } = useLibraryStore.getState();
  const { libraryLayoutMode } = useUIStore.getState();

  if (selectedImage || libraryLayoutMode !== LibraryLayoutMode.Preview) return null;

  const hoverPath = hoverTarget?.path || null;
  return hoverPath && multiSelectedPaths.includes(hoverPath) ? hoverPath : null;
}

export function openPreviewLoupe(targetPath: string | null): void {
  if (!targetPath) return;

  const { selectedImage } = useEditorStore.getState();
  const library = useLibraryStore.getState();
  const { libraryLayoutMode } = useUIStore.getState();
  if (
    selectedImage ||
    libraryLayoutMode !== LibraryLayoutMode.Preview ||
    !library.multiSelectedPaths.includes(targetPath)
  ) {
    return;
  }

  const existingLoupes = useLoupeStore.getState().loupes;
  if (existingLoupes.filter((loupe) => loupe.path === targetPath).length >= MAX_LOUPES_PER_IMAGE) return;

  const thumbnailUrl = useProcessStore.getState().thumbnails[targetPath] || null;
  const target =
    library.hoverTarget?.path === targetPath
      ? library.hoverTarget
      : findPreviewLoupeTargetElement(targetPath, thumbnailUrl);

  const displaySize = 190;
  const loupeSize = { width: displaySize * 1.1, height: displaySize };
  const fallbackRect = {
    x: window.innerWidth / 2 - 160,
    y: window.innerHeight / 2 - 160,
    width: loupeSize.width,
    height: loupeSize.height,
  };
  const targetItemRect = target?.itemRect || fallbackRect;
  const targetImageRect = target?.imageRect || targetItemRect;
  const pointer = target?.pointer
    ? { x: target.pointer.clientX, y: target.pointer.clientY }
    : { x: targetImageRect.x + targetImageRect.width / 2, y: targetImageRect.y + targetImageRect.height / 2 };
  const tipPoint = clampPointToRect(pointer, targetImageRect);
  const safeBounds = getLoupeSafeBounds();
  const avoidRects = existingLoupes.map((loupe) => getLoupeWindowRect(loupe.position, loupe.size));
  const slot = chooseNextLoupeSlot(tipPoint, loupeSize, safeBounds, avoidRects);
  if (!slot) return;

  const focalPoint = getNormalizedPointFromObjectFit(
    { clientX: tipPoint.x, clientY: tipPoint.y },
    targetImageRect,
    target?.imageAspectRatio,
    target?.objectFit || 'contain',
  );
  const position = getLoupePositionForTip(slot, tipPoint, loupeSize);
  const fileName = target?.fileName || getBaseName(targetPath);
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  useLoupeStore.getState().openLoupe({
    id,
    path: targetPath,
    fileName,
    slot,
    position,
    size: loupeSize,
    tipPoint,
    targetImageRect,
    targetItemRect,
    objectFit: target?.objectFit || 'contain',
    imageAspectRatio: target?.imageAspectRatio || null,
    focalPoint,
    sourceSize: displaySize,
    zoom: 1,
    thumbnailUrl: target?.thumbnailUrl || thumbnailUrl,
    tile: null,
    isTileStale: true,
    isLoading: true,
    error: null,
    requestId: 0,
    showGuide: false,
  });

  window.setTimeout(() => loadLoupeTile(id), INITIAL_LOUPE_RENDER_DELAY_MS);
}
