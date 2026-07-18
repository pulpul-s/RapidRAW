import type { RectLike } from './loupePlacement';

const GEOMETRY_EPSILON_PX = 0.5;
const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

type ImageObjectFit = 'cover' | 'contain';
type PointLike = { x: number; y: number };

function rectToPlain(rect: DOMRect): RectLike {
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

export function pointsDiffer(
  first: PointLike | null | undefined,
  second: PointLike | null | undefined,
  epsilon = GEOMETRY_EPSILON_PX,
) {
  if (!first || !second) return true;
  return Math.abs(first.x - second.x) > epsilon || Math.abs(first.y - second.y) > epsilon;
}

export function rectsDiffer(first: RectLike, second: RectLike, epsilon = GEOMETRY_EPSILON_PX) {
  return (
    Math.abs(first.x - second.x) > epsilon ||
    Math.abs(first.y - second.y) > epsilon ||
    Math.abs(first.width - second.width) > epsilon ||
    Math.abs(first.height - second.height) > epsilon
  );
}

function getImageAspectRatio(root: HTMLElement | null) {
  const img = root?.querySelector('img') as HTMLImageElement | null;
  if (img && img.naturalWidth > 0 && img.naturalHeight > 0) {
    return img.naturalWidth / img.naturalHeight;
  }
  return null;
}

export function isClientPointInRect(point: { clientX: number; clientY: number }, rect: RectLike) {
  return (
    point.clientX >= rect.x &&
    point.clientX <= rect.x + rect.width &&
    point.clientY >= rect.y &&
    point.clientY <= rect.y + rect.height
  );
}

export function getObjectFitDisplayBox(
  rect: RectLike,
  imageAspectRatio: number | null | undefined,
  fit: ImageObjectFit,
) {
  if (rect.width <= 0 || rect.height <= 0 || !imageAspectRatio || imageAspectRatio <= 0) {
    return { displayWidth: rect.width, displayHeight: rect.height, offsetX: 0, offsetY: 0 };
  }

  const containerAspect = rect.width / rect.height;
  let displayWidth = rect.width;
  let displayHeight = rect.height;
  let offsetX = 0;
  let offsetY = 0;
  const isContain = fit === 'contain';
  if (isContain) {
    if (imageAspectRatio > containerAspect) {
      displayWidth = rect.width;
      displayHeight = rect.width / imageAspectRatio;
      offsetY = (rect.height - displayHeight) / 2;
    } else {
      displayHeight = rect.height;
      displayWidth = rect.height * imageAspectRatio;
      offsetX = (rect.width - displayWidth) / 2;
    }
  } else if (imageAspectRatio > containerAspect) {
    displayHeight = rect.height;
    displayWidth = rect.height * imageAspectRatio;
    offsetX = (rect.width - displayWidth) / 2;
  } else {
    displayWidth = rect.width;
    displayHeight = rect.width / imageAspectRatio;
    offsetY = (rect.height - displayHeight) / 2;
  }

  return { displayWidth, displayHeight, offsetX, offsetY };
}

function getObjectFitDisplayRect(
  rect: RectLike,
  imageAspectRatio: number | null | undefined,
  fit: ImageObjectFit,
): RectLike {
  const { displayWidth, displayHeight, offsetX, offsetY } = getObjectFitDisplayBox(rect, imageAspectRatio, fit);

  return {
    x: rect.x + offsetX,
    y: rect.y + offsetY,
    width: displayWidth,
    height: displayHeight,
  };
}

export function getImageTargetGeometry(
  root: HTMLElement,
  imageArea: HTMLElement,
  fit: ImageObjectFit,
  fallbackAspectRatio: number | null = null,
) {
  const imageAspectRatio = getImageAspectRatio(imageArea) ?? fallbackAspectRatio;
  return {
    itemRect: rectToPlain(root.getBoundingClientRect()),
    imageRect: getObjectFitDisplayRect(rectToPlain(imageArea.getBoundingClientRect()), imageAspectRatio, fit),
    imageAspectRatio,
  };
}

export function getNormalizedPointFromObjectFit(
  pointer: { clientX: number; clientY: number } | null | undefined,
  rect: RectLike | null | undefined,
  imageAspectRatio: number | null | undefined,
  fit: ImageObjectFit,
): { x: number; y: number } {
  if (!pointer || !rect || rect.width <= 0 || rect.height <= 0 || !imageAspectRatio || imageAspectRatio <= 0) {
    return { x: 0.5, y: 0.5 };
  }

  const { displayWidth, displayHeight, offsetX, offsetY } = getObjectFitDisplayBox(rect, imageAspectRatio, fit);
  const localX = pointer.clientX - rect.x;
  const localY = pointer.clientY - rect.y;
  const normalizedX = (localX - offsetX) / displayWidth;
  const normalizedY = (localY - offsetY) / displayHeight;

  return {
    x: clamp01(normalizedX),
    y: clamp01(normalizedY),
  };
}

export function getClientPointFromNormalizedObjectFit(
  normalizedPoint: { x: number; y: number } | null | undefined,
  rect: RectLike | null | undefined,
  imageAspectRatio: number | null | undefined,
  fit: ImageObjectFit,
): { x: number; y: number } {
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    return { x: 0, y: 0 };
  }

  const point = normalizedPoint || { x: 0.5, y: 0.5 };
  const { displayWidth, displayHeight, offsetX, offsetY } = getObjectFitDisplayBox(rect, imageAspectRatio, fit);

  return {
    x: rect.x + offsetX + clamp01(point.x) * displayWidth,
    y: rect.y + offsetY + clamp01(point.y) * displayHeight,
  };
}
