import type { CSSProperties } from 'react';
import type { LoupePreview, LoupeTile } from '../store/useLoupeStore';
import type { RectLike } from './loupePlacement';
import type { LoupeRenderArea } from './loupeRenderArea';

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

type ViewportSize = { width: number; height: number };

function getViewportAspectRatio(viewport: ViewportSize) {
  const width = Number.isFinite(viewport.width) && viewport.width > 0 ? viewport.width : 1;
  const height = Number.isFinite(viewport.height) && viewport.height > 0 ? viewport.height : 1;
  return width / height;
}

export function getLoupeTileSourceSize(
  visibleSourceHeight: number,
  renderArea: LoupeRenderArea,
  viewport: ViewportSize,
): number | null {
  if (renderArea === 'full') return null;

  const configuredSize = Number.parseInt(renderArea, 10);
  const visibleSourceWidth = Math.max(1, visibleSourceHeight) * getViewportAspectRatio(viewport);
  const requiredSourceSize = Math.max(1, visibleSourceHeight, visibleSourceWidth);

  return Math.max(configuredSize, Math.ceil(requiredSourceSize));
}

function getFocalImagePoint(focalPoint: { x: number; y: number }, imageSize: { width: number; height: number }) {
  return {
    x: clamp(focalPoint.x, 0, 1) * imageSize.width,
    y: clamp(focalPoint.y, 0, 1) * imageSize.height,
  };
}

function getVisibleSourceRect(
  focalPoint: { x: number; y: number },
  imageSize: { width: number; height: number },
  sourceSize: number,
  viewport: ViewportSize,
): RectLike {
  const imageWidth = Math.max(1, imageSize.width);
  const imageHeight = Math.max(1, imageSize.height);
  const viewportAspectRatio = getViewportAspectRatio(viewport);

  let height = Math.min(Math.max(1, sourceSize), imageHeight);
  let width = height * viewportAspectRatio;

  if (width > imageWidth) {
    width = imageWidth;
    height = Math.min(imageHeight, width / viewportAspectRatio);
  }

  const focal = getFocalImagePoint(focalPoint, { width: imageWidth, height: imageHeight });
  const maxX = Math.max(0, imageWidth - width);
  const maxY = Math.max(0, imageHeight - height);

  return {
    x: clamp(focal.x - width / 2, 0, maxX),
    y: clamp(focal.y - height / 2, 0, maxY),
    width,
    height,
  };
}

function rectContains(container: RectLike, rect: RectLike, epsilon = 0.75) {
  return (
    rect.x >= container.x - epsilon &&
    rect.y >= container.y - epsilon &&
    rect.x + rect.width <= container.x + container.width + epsilon &&
    rect.y + rect.height <= container.y + container.height + epsilon
  );
}

export function isLoupeTileUsable(
  loupe: Pick<LoupePreview, 'tile' | 'focalPoint' | 'sourceSize' | 'size'>,
  renderArea?: LoupeRenderArea,
): boolean {
  if (!loupe.tile) return false;
  if (renderArea && loupe.tile.renderArea !== renderArea) return false;
  const visibleSourceRect = getVisibleSourceRect(loupe.focalPoint, loupe.tile.imageSize, loupe.sourceSize, loupe.size);
  return rectContains(loupe.tile.sourceRect, visibleSourceRect);
}

export function getLoupeTileImageStyle(
  tile: LoupeTile,
  focalPoint: { x: number; y: number },
  sourceSize: number,
  viewport: ViewportSize,
): CSSProperties {
  const visibleSourceRect = getVisibleSourceRect(focalPoint, tile.imageSize, sourceSize, viewport);
  const scale = viewport.height / visibleSourceRect.height;
  const width = tile.sourceRect.width * scale;
  const height = tile.sourceRect.height * scale;
  const unclampedLeft = -(visibleSourceRect.x - tile.sourceRect.x) * scale;
  const unclampedTop = -(visibleSourceRect.y - tile.sourceRect.y) * scale;
  const left = clamp(unclampedLeft, Math.min(0, viewport.width - width), 0);
  const top = clamp(unclampedTop, Math.min(0, viewport.height - height), 0);

  return {
    position: 'absolute',
    left,
    top,
    width,
    height,
    maxWidth: 'none',
    maxHeight: 'none',
  };
}
