import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { Invokes } from '../components/ui/AppProperties';
import type { LoupePreview, LoupeTile } from '../store/useLoupeStore';
import { useLoupeStore, waitForLoupeMemoryCachesToClear } from '../store/useLoupeStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { Adjustments, INITIAL_ADJUSTMENTS, normalizeLoadedAdjustments } from './adjustments';
import { getLoupeTileSourceSize, isLoupeTileUsable } from './loupeTile';
import { normalizeLoupeRenderArea, type LoupeRenderArea } from './loupeRenderArea';

interface MetadataResponse {
  adjustments?: { is_null?: boolean } | Record<string, unknown> | null;
}

interface LoupeTileResponse {
  tilePath: string;
  sourceRect: { x: number; y: number; width: number; height: number };
  imageSize: { width: number; height: number };
}

function getAdjustmentsFromMetadata(metadata: MetadataResponse): Adjustments {
  const loadedAdjustments = metadata.adjustments;
  return loadedAdjustments && !(loadedAdjustments as { is_null?: boolean }).is_null
    ? normalizeLoadedAdjustments(loadedAdjustments as Adjustments)
    : { ...INITIAL_ADJUSTMENTS };
}

const adjustmentsInFlightByPath = new Map<string, Promise<Adjustments>>();
const loupeTileRequests = new Map<string, Promise<LoupeTileResponse>>();

function getAdjustmentsForPath(path: string): Promise<Adjustments> {
  const cached = adjustmentsInFlightByPath.get(path);
  if (cached) return cached;

  const promise = invoke<MetadataResponse>(Invokes.LoadMetadata, { path })
    .then(getAdjustmentsFromMetadata)
    .finally(() => adjustmentsInFlightByPath.delete(path));

  adjustmentsInFlightByPath.set(path, promise);
  return promise;
}

function responseToTile(
  response: LoupeTileResponse,
  url: string,
  renderArea: LoupeRenderArea,
  renderKey: string,
): LoupeTile {
  return {
    url,
    previewPath: response.tilePath,
    sourceRect: response.sourceRect,
    imageSize: response.imageSize,
    renderArea,
    renderKey,
  };
}

function getLoupeRenderAreaSetting() {
  return normalizeLoupeRenderArea(useSettingsStore.getState().appSettings?.loupeRenderArea);
}

function findReusableTile(loupe: LoupePreview, renderArea: LoupeRenderArea, renderKey: string): LoupeTile | null {
  for (const item of useLoupeStore.getState().loupes) {
    if (item.id === loupe.id || item.path !== loupe.path || !item.tile) continue;
    if (item.tile.renderKey !== renderKey) continue;
    if (isLoupeTileUsable({ ...loupe, tile: item.tile }, renderArea)) return item.tile;
  }

  return null;
}

function getTileRenderKey(path: string, renderArea: LoupeRenderArea, adjustments: Adjustments) {
  return `${path}\u0000${renderArea}\u0000${JSON.stringify(adjustments)}`;
}

function getLoupeTileResponse(
  loupe: LoupePreview,
  adjustments: Adjustments,
  renderArea: LoupeRenderArea,
  renderKey: string,
) {
  const tileSourceSize = getLoupeTileSourceSize(loupe.sourceSize, renderArea, loupe.size);
  const requestKey =
    renderArea === 'full'
      ? `${renderKey}\u0000full`
      : [renderKey, tileSourceSize, loupe.focalPoint.x.toFixed(6), loupe.focalPoint.y.toFixed(6)].join('\u0000');
  const cached = loupeTileRequests.get(requestKey);
  if (cached) return cached;

  const promise = invoke<LoupeTileResponse>(Invokes.GenerateLoupeTile, {
    path: loupe.path,
    jsAdjustments: adjustments,
    centerX: loupe.focalPoint.x,
    centerY: loupe.focalPoint.y,
    tileSourceSize,
  }).finally(() => loupeTileRequests.delete(requestKey));

  loupeTileRequests.set(requestKey, promise);
  return promise;
}

function applyReusableTile(loupeId: string, requestId: number, tile: LoupeTile) {
  const latest = useLoupeStore.getState().loupes.find((loupe) => loupe.id === loupeId);
  if (!latest || latest.requestId !== requestId) return;

  useLoupeStore.getState().updateLoupe(loupeId, {
    tile,
    isLoading: false,
    isTileStale: false,
    error: null,
  });
}

function settleCurrentTileIfReusable(loupe: LoupePreview, renderArea: LoupeRenderArea, renderKey: string) {
  if (loupe.tile?.renderKey !== renderKey || !isLoupeTileUsable(loupe, renderArea)) return false;

  if (loupe.isLoading || loupe.isTileStale || loupe.error) {
    useLoupeStore.getState().updateLoupe(loupe.id, {
      isLoading: false,
      isTileStale: false,
      error: null,
      requestId: loupe.isLoading ? loupe.requestId + 1 : loupe.requestId,
    });
  }

  return true;
}

export async function loadLoupeTile(loupeId: string, adjustmentsOverride?: Adjustments) {
  const initial = useLoupeStore.getState().loupes.find((loupe) => loupe.id === loupeId);
  if (!initial) return;

  const requestId = initial.requestId + 1;
  useLoupeStore.getState().updateLoupe(loupeId, {
    isLoading: true,
    isTileStale: true,
    error: null,
    requestId,
  });

  try {
    const adjustments = adjustmentsOverride ?? (await getAdjustmentsForPath(initial.path));

    const latest = useLoupeStore.getState().loupes.find((loupe) => loupe.id === loupeId);
    if (!latest || latest.requestId !== requestId) return;

    const renderArea = getLoupeRenderAreaSetting();
    const renderKey = getTileRenderKey(latest.path, renderArea, adjustments);
    if (latest.tile?.renderKey === renderKey && isLoupeTileUsable(latest, renderArea)) {
      applyReusableTile(loupeId, requestId, latest.tile);
      return;
    }

    const reusableTile = findReusableTile(latest, renderArea, renderKey);
    if (reusableTile) {
      applyReusableTile(loupeId, requestId, reusableTile);
      return;
    }

    const response = await getLoupeTileResponse(latest, adjustments, renderArea, renderKey);

    const afterRender = useLoupeStore.getState().loupes.find((loupe) => loupe.id === loupeId);
    if (!afterRender || afterRender.requestId !== requestId) return;

    const reusableTileAfterRender = findReusableTile(afterRender, renderArea, renderKey);
    if (reusableTileAfterRender) {
      applyReusableTile(loupeId, requestId, reusableTileAfterRender);
      return;
    }

    const url = convertFileSrc(response.tilePath);
    const tile = responseToTile(response, url, renderArea, renderKey);
    useLoupeStore.getState().updateLoupe(loupeId, {
      tile,
      isLoading: false,
      isTileStale: !isLoupeTileUsable({ ...afterRender, tile }, renderArea),
      error: null,
    });
  } catch (err) {
    const latest = useLoupeStore.getState().loupes.find((loupe) => loupe.id === loupeId);
    if (!latest || latest.requestId !== requestId) return;
    useLoupeStore.getState().updateLoupe(loupeId, {
      isLoading: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function refreshLoupeTilesForAdjustments(path: string, adjustments: Adjustments) {
  const renderArea = getLoupeRenderAreaSetting();
  const renderKey = getTileRenderKey(path, renderArea, adjustments);

  useLoupeStore
    .getState()
    .loupes.filter((loupe) => loupe.path === path)
    .forEach((loupe) => {
      if (settleCurrentTileIfReusable(loupe, renderArea, renderKey)) return;

      void loadLoupeTile(loupe.id, adjustments);
    });
}

async function refreshLoupeTileFromMetadata(loupeId: string) {
  const initial = useLoupeStore.getState().loupes.find((loupe) => loupe.id === loupeId);
  if (!initial) return;

  try {
    const adjustments = await getAdjustmentsForPath(initial.path);
    const latest = useLoupeStore.getState().loupes.find((loupe) => loupe.id === loupeId);
    if (!latest) return;

    const renderArea = getLoupeRenderAreaSetting();
    const renderKey = getTileRenderKey(latest.path, renderArea, adjustments);
    if (settleCurrentTileIfReusable(latest, renderArea, renderKey)) return;

    await loadLoupeTile(loupeId, adjustments);
  } catch (error) {
    console.error('Failed to refresh preserved loupe tile:', error);
  }
}

export async function refreshPreservedLoupeTilesAfterEditor(editedPath: string, editedAdjustments: Adjustments) {
  await waitForLoupeMemoryCachesToClear();

  const loupes = useLoupeStore.getState().loupes;
  refreshLoupeTilesForAdjustments(editedPath, editedAdjustments);

  loupes.forEach((loupe) => {
    if (loupe.path !== editedPath) void refreshLoupeTileFromMetadata(loupe.id);
  });
}
