import type { LoupeSlot } from '../store/useLoupeStore';

export interface RectLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

type Point = { x: number; y: number };
type LoupeSize = { width: number; height: number };
type LoupeTipCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

const LOUPE_SLOT_ORDER: LoupeSlot[] = ['top-left', 'top-right', 'bottom-right', 'bottom-left'];
export const LOUPE_TIP_SIZE = 12;
const LOUPE_VIEWPORT_GAP = 8;
const LOUPE_SLOT_SWITCH_OVERFLOW_PX = 14;
const LOUPE_COLLISION_GAP = 8;

const OPPOSITE_VERTICAL_SLOT: Record<LoupeSlot, LoupeSlot> = {
  'top-left': 'bottom-left',
  'top-right': 'bottom-right',
  'bottom-left': 'top-left',
  'bottom-right': 'top-right',
};

const OPPOSITE_HORIZONTAL_SLOT: Record<LoupeSlot, LoupeSlot> = {
  'top-left': 'top-right',
  'top-right': 'top-left',
  'bottom-left': 'bottom-right',
  'bottom-right': 'bottom-left',
};

const LOUPE_TIP_CORNER: Record<LoupeSlot, LoupeTipCorner> = {
  'top-left': 'bottom-right',
  'top-right': 'bottom-left',
  'bottom-left': 'top-right',
  'bottom-right': 'top-left',
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function defaultBounds(): RectLike {
  return {
    x: 0,
    y: 0,
    width: typeof window === 'undefined' ? 0 : window.innerWidth,
    height: typeof window === 'undefined' ? 0 : window.innerHeight,
  };
}

export function getLoupeSafeBounds(): RectLike {
  if (typeof document === 'undefined') return defaultBounds();

  const safeElement = document.querySelector<HTMLElement>('[data-rapidraw-loupe-bounds="true"]');
  const rect = safeElement?.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0) return defaultBounds();

  return {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

export function clampPointToRect(point: Point, rect: RectLike, inset = 2): Point {
  const minX = rect.x + inset;
  const maxX = rect.x + Math.max(inset, rect.width - inset);
  const minY = rect.y + inset;
  const maxY = rect.y + Math.max(inset, rect.height - inset);

  return {
    x: clamp(point.x, minX, maxX),
    y: clamp(point.y, minY, maxY),
  };
}

export function getLoupePositionForTip(
  slot: LoupeSlot,
  tipPoint: Point,
  size: LoupeSize,
  tipSize = LOUPE_TIP_SIZE,
): Point {
  switch (slot) {
    case 'top-left':
      return { x: tipPoint.x - size.width - tipSize, y: tipPoint.y - size.height - tipSize };
    case 'top-right':
      return { x: tipPoint.x + tipSize, y: tipPoint.y - size.height - tipSize };
    case 'bottom-left':
      return { x: tipPoint.x - size.width - tipSize, y: tipPoint.y + tipSize };
    case 'bottom-right':
    default:
      return { x: tipPoint.x + tipSize, y: tipPoint.y + tipSize };
  }
}

function getLoupeTipForPosition(slot: LoupeSlot, position: Point, size: LoupeSize, tipSize = LOUPE_TIP_SIZE): Point {
  switch (slot) {
    case 'top-left':
      return { x: position.x + size.width + tipSize, y: position.y + size.height + tipSize };
    case 'top-right':
      return { x: position.x - tipSize, y: position.y + size.height + tipSize };
    case 'bottom-left':
      return { x: position.x + size.width + tipSize, y: position.y - tipSize };
    case 'bottom-right':
    default:
      return { x: position.x - tipSize, y: position.y - tipSize };
  }
}

export function getLoupeTipCorner(slot: LoupeSlot): LoupeTipCorner {
  return LOUPE_TIP_CORNER[slot];
}

function getLoupeViewportOverflow(position: Point, size: LoupeSize, bounds: RectLike, gap = LOUPE_VIEWPORT_GAP) {
  const minX = bounds.x + gap;
  const maxX = bounds.x + bounds.width - gap;
  const minY = bounds.y + gap;
  const maxY = bounds.y + bounds.height - gap;

  return {
    left: Math.max(0, minX - position.x),
    right: Math.max(0, position.x + size.width - maxX),
    top: Math.max(0, minY - position.y),
    bottom: Math.max(0, position.y + size.height - maxY),
  };
}

function maxViewportOverflow(overflow: ReturnType<typeof getLoupeViewportOverflow>) {
  return Math.max(overflow.left, overflow.right, overflow.top, overflow.bottom);
}

function totalViewportOverflow(overflow: ReturnType<typeof getLoupeViewportOverflow>) {
  return overflow.left + overflow.right + overflow.top + overflow.bottom;
}

export function getLoupeSlotForOverdrag(
  slot: LoupeSlot,
  position: Point,
  size: LoupeSize,
  bounds: RectLike = getLoupeSafeBounds(),
  avoidRects: RectLike[] = [],
  threshold = LOUPE_SLOT_SWITCH_OVERFLOW_PX,
): LoupeSlot | null {
  const overflow = getLoupeViewportOverflow(position, size, bounds);
  const horizontalOverflow = slot.endsWith('left') ? overflow.left : overflow.right;
  const verticalOverflow = slot.startsWith('top') ? overflow.top : overflow.bottom;
  const candidates = [
    { slot: OPPOSITE_HORIZONTAL_SLOT[slot], overflow: horizontalOverflow },
    { slot: OPPOSITE_VERTICAL_SLOT[slot], overflow: verticalOverflow },
  ]
    .filter((candidate) => candidate.overflow > threshold)
    .sort((first, second) => second.overflow - first.overflow);

  if (candidates.length === 0) return null;

  const tipPoint = getLoupeTipForPosition(slot, position, size);
  const currentOverflow = totalViewportOverflow(overflow);
  let fallbackSlot: LoupeSlot | null = null;
  let fallbackOverflow = currentOverflow;

  for (const candidate of candidates) {
    const nextPosition = getLoupePositionForTip(candidate.slot, tipPoint, size);
    const nextOverflow = totalViewportOverflow(getLoupeViewportOverflow(nextPosition, size, bounds));
    if (nextOverflow >= currentOverflow) continue;

    if (nextOverflow < fallbackOverflow) {
      fallbackSlot = candidate.slot;
      fallbackOverflow = nextOverflow;
    }

    const nextRect = getLoupeWindowRect(nextPosition, size);
    if (avoidRects.some((existing) => rectsOverlap(nextRect, existing, LOUPE_COLLISION_GAP))) continue;

    return candidate.slot;
  }

  return fallbackSlot;
}

export function getLoupeWindowRect(position: Point, size: LoupeSize): RectLike {
  return { x: position.x, y: position.y, width: size.width, height: size.height };
}

function rectsOverlap(a: RectLike, b: RectLike, gap = LOUPE_COLLISION_GAP) {
  return !(
    a.x + a.width + gap <= b.x ||
    b.x + b.width + gap <= a.x ||
    a.y + a.height + gap <= b.y ||
    b.y + b.height + gap <= a.y
  );
}

function uniqueSlots(slots: LoupeSlot[]) {
  return slots.filter((slot, index) => slots.indexOf(slot) === index);
}

function loupeSlotFitsViewport(
  slot: LoupeSlot,
  tipPoint: Point,
  size: LoupeSize,
  bounds: RectLike,
  maxOverflow = 0,
  gap = LOUPE_VIEWPORT_GAP,
): boolean {
  const position = getLoupePositionForTip(slot, tipPoint, size);
  return maxViewportOverflow(getLoupeViewportOverflow(position, size, bounds, gap)) <= maxOverflow;
}

type ChooseLoupeSlotOptions = {
  allowOverlapFallback?: boolean;
  avoidRects?: RectLike[];
  maxOverflow?: number;
  viewportGap?: number;
};

function chooseSlotFromOrder(
  preferredOrder: LoupeSlot[],
  tipPoint: Point,
  size: LoupeSize,
  bounds: RectLike,
  {
    allowOverlapFallback = false,
    avoidRects = [],
    maxOverflow = 0,
    viewportGap = LOUPE_VIEWPORT_GAP,
  }: ChooseLoupeSlotOptions = {},
): LoupeSlot | null {
  const candidates = uniqueSlots(preferredOrder);
  const isCandidateValid = (slot: LoupeSlot, respectCollisions: boolean) => {
    if (!loupeSlotFitsViewport(slot, tipPoint, size, bounds, maxOverflow, viewportGap)) return false;
    if (!respectCollisions || avoidRects.length === 0) return true;

    const position = getLoupePositionForTip(slot, tipPoint, size);
    const rect = getLoupeWindowRect(position, size);
    return avoidRects.every((existing) => !rectsOverlap(rect, existing));
  };

  return (
    candidates.find((slot) => isCandidateValid(slot, true)) ||
    (allowOverlapFallback ? candidates.find((slot) => isCandidateValid(slot, false)) : null) ||
    null
  );
}

export function chooseNextLoupeSlot(
  preferredTipPoint: Point,
  size: LoupeSize,
  bounds: RectLike = getLoupeSafeBounds(),
  avoidRects: RectLike[] = [],
): LoupeSlot | null {
  return chooseSlotFromOrder(LOUPE_SLOT_ORDER, preferredTipPoint, size, bounds, {
    allowOverlapFallback: true,
    avoidRects,
  });
}

export function chooseNextAvailableLoupeSlot(
  currentSlot: LoupeSlot,
  tipPoint: Point,
  size: LoupeSize,
  bounds: RectLike = getLoupeSafeBounds(),
  avoidRects: RectLike[] = [],
): LoupeSlot | null {
  const currentIndex = LOUPE_SLOT_ORDER.indexOf(currentSlot);
  const candidates = LOUPE_SLOT_ORDER.slice(currentIndex + 1).concat(LOUPE_SLOT_ORDER.slice(0, currentIndex));

  return chooseSlotFromOrder(candidates, tipPoint, size, bounds, {
    avoidRects,
    maxOverflow: LOUPE_SLOT_SWITCH_OVERFLOW_PX,
    viewportGap: 0,
  });
}

export function chooseLoupeSlotForTip(
  preferredSlot: LoupeSlot,
  tipPoint: Point,
  size: LoupeSize,
  bounds: RectLike = getLoupeSafeBounds(),
): LoupeSlot {
  if (loupeSlotFitsViewport(preferredSlot, tipPoint, size, bounds, LOUPE_SLOT_SWITCH_OVERFLOW_PX)) {
    return preferredSlot;
  }

  const preferredOrder = [
    OPPOSITE_VERTICAL_SLOT[preferredSlot],
    OPPOSITE_HORIZONTAL_SLOT[preferredSlot],
    ...LOUPE_SLOT_ORDER,
  ];
  return chooseSlotFromOrder(preferredOrder, tipPoint, size, bounds) || preferredSlot;
}
