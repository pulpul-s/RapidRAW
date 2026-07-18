import { invoke } from '@tauri-apps/api/core';
import { create } from 'zustand';
import { Invokes } from '../components/ui/AppProperties';
import type { RectLike } from '../utils/loupePlacement';
import type { LoupeRenderArea } from '../utils/loupeRenderArea';

export type LoupeSlot = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export interface LoupeTile {
  url: string;
  previewPath: string;
  sourceRect: RectLike;
  imageSize: { width: number; height: number };
  renderArea: LoupeRenderArea;
  renderKey: string;
}

export interface LoupePreview {
  id: string;
  path: string;
  fileName: string;
  slot: LoupeSlot;
  position: { x: number; y: number };
  size: { width: number; height: number };
  tipPoint: { x: number; y: number };
  targetImageRect: RectLike;
  targetItemRect: RectLike;
  objectFit: 'cover' | 'contain';
  imageAspectRatio: number | null;
  focalPoint: { x: number; y: number };
  sourceSize: number;
  zoom: number;
  thumbnailUrl: string | null;
  tile: LoupeTile | null;
  isTileStale: boolean;
  isLoading: boolean;
  error: string | null;
  requestId: number;
  showGuide: boolean;
}

interface LoupeState {
  loupes: LoupePreview[];
  openLoupe: (loupe: LoupePreview) => void;
  closeLoupe: (id: string) => void;
  closeTopLoupe: () => void;
  closeAllLoupes: () => void;
  updateLoupe: (id: string, patch: Partial<LoupePreview>) => void;
  updateLoupes: (updates: Array<{ id: string; patch: Partial<LoupePreview> }>) => void;
  raiseLoupe: (id: string) => void;
  shiftLoupesBy: (delta: { x: number; y: number }, viewport: RectLike) => void;
}

export const MAX_LOUPES_PER_IMAGE = 2;
const MAX_OPEN_LOUPES = 32;

const shiftRect = (rect: RectLike, delta: { x: number; y: number }): RectLike => ({
  ...rect,
  x: rect.x + delta.x,
  y: rect.y + delta.y,
});

const rectIntersectsViewport = (rect: RectLike, viewport: RectLike) =>
  rect.x + rect.width > viewport.x &&
  rect.y + rect.height > viewport.y &&
  rect.x < viewport.x + viewport.width &&
  rect.y < viewport.y + viewport.height;

let lastActiveLoupePreviewPathSignature = '';
let pendingActiveLoupePreviewPaths: string[] | null = null;
let activeLoupePreviewPathSyncScheduled = false;
let activeLoupePreviewPathSyncInFlight = false;

const flushActiveLoupePreviewPaths = async () => {
  if (activeLoupePreviewPathSyncInFlight || !pendingActiveLoupePreviewPaths) return;

  const paths = pendingActiveLoupePreviewPaths;
  const signature = paths.join('\u0000');
  pendingActiveLoupePreviewPaths = null;
  if (signature === lastActiveLoupePreviewPathSignature) return;

  activeLoupePreviewPathSyncInFlight = true;
  try {
    await invoke(Invokes.SetActiveLoupePreviewPaths, { paths });
    lastActiveLoupePreviewPathSignature = signature;
  } catch {
    return;
  } finally {
    activeLoupePreviewPathSyncInFlight = false;
    if (pendingActiveLoupePreviewPaths) {
      queueMicrotask(() => void flushActiveLoupePreviewPaths());
    }
  }
};

const syncActiveLoupePreviewPaths = (loupes: LoupePreview[]) => {
  const paths = Array.from(new Set(loupes.map((loupe) => loupe.tile?.previewPath).filter(Boolean) as string[])).sort();
  const signature = paths.join('\u0000');
  if (signature === lastActiveLoupePreviewPathSignature && !activeLoupePreviewPathSyncInFlight) return;

  pendingActiveLoupePreviewPaths = paths;
  if (activeLoupePreviewPathSyncScheduled || activeLoupePreviewPathSyncInFlight) return;
  activeLoupePreviewPathSyncScheduled = true;

  queueMicrotask(() => {
    activeLoupePreviewPathSyncScheduled = false;
    void flushActiveLoupePreviewPaths();
  });
};

export const useLoupeStore = create<LoupeState>((set) => ({
  loupes: [],

  openLoupe: (loupe) =>
    set((state) => {
      const sameImage = state.loupes.filter((item) => item.path === loupe.path && item.id !== loupe.id);
      if (sameImage.length >= MAX_LOUPES_PER_IMAGE) return state;

      const existing = state.loupes.filter((item) => item.id !== loupe.id);
      const overflow = existing.length >= MAX_OPEN_LOUPES ? existing[0] : null;

      return {
        loupes: [...(overflow ? existing.slice(1) : existing), loupe],
      };
    }),

  closeLoupe: (id) =>
    set((state) => ({
      loupes: state.loupes.filter((item) => item.id !== id),
    })),

  closeTopLoupe: () =>
    set((state) => {
      if (state.loupes.length === 0) return {};
      return { loupes: state.loupes.slice(0, -1) };
    }),

  closeAllLoupes: () => set({ loupes: [] }),

  updateLoupe: (id, patch) =>
    set((state) => {
      const nextLoupes = state.loupes.map((loupe) => (loupe.id === id ? { ...loupe, ...patch } : loupe));
      return { loupes: nextLoupes };
    }),

  updateLoupes: (updates) =>
    set((state) => {
      const patches = new Map(updates.map(({ id, patch }) => [id, patch]));
      return {
        loupes: state.loupes.map((loupe) => {
          const patch = patches.get(loupe.id);
          return patch ? { ...loupe, ...patch } : loupe;
        }),
      };
    }),

  raiseLoupe: (id) =>
    set((state) => {
      const index = state.loupes.findIndex((loupe) => loupe.id === id);
      if (index < 0 || index === state.loupes.length - 1) return state;
      const next = [...state.loupes];
      const [loupe] = next.splice(index, 1);
      next.push(loupe);
      return { loupes: next };
    }),

  shiftLoupesBy: (delta, viewport) =>
    set((state) => {
      if (state.loupes.length === 0 || (delta.x === 0 && delta.y === 0)) return state;

      const next: LoupePreview[] = [];
      state.loupes.forEach((loupe) => {
        const targetImageRect = shiftRect(loupe.targetImageRect, delta);
        const targetItemRect = shiftRect(loupe.targetItemRect, delta);

        if (!rectIntersectsViewport(targetItemRect, viewport)) return;

        next.push({
          ...loupe,
          position: { x: loupe.position.x + delta.x, y: loupe.position.y + delta.y },
          tipPoint: { x: loupe.tipPoint.x + delta.x, y: loupe.tipPoint.y + delta.y },
          targetImageRect,
          targetItemRect,
        });
      });

      return { loupes: next };
    }),
}));

useLoupeStore.subscribe((state) => {
  syncActiveLoupePreviewPaths(state.loupes);
});

let latestLoupeMemoryClear: Promise<void> = Promise.resolve();

export function clearLoupeMemoryCaches() {
  latestLoupeMemoryClear = invoke<void>(Invokes.ClearLoupeCaches).catch((error) =>
    console.error('Failed to clear loupe caches:', error),
  );
  return latestLoupeMemoryClear;
}

export function waitForLoupeMemoryCachesToClear() {
  return latestLoupeMemoryClear;
}

export function discardLoupesAndClearMemory() {
  useLoupeStore.getState().closeAllLoupes();
  clearLoupeMemoryCaches();
}
