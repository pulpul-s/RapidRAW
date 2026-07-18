import { getObjectFitDisplayBox } from './imageCoordinateUtils';

interface PreviewLayoutImage {
  aspectRatio: number;
  path: string;
}

interface PreviewLayoutTile {
  aspectRatio: number;
  contentHeight: number;
  contentWidth: number;
  height: number;
  isFixedCell?: boolean;
  path: string;
  width: number;
  x: number;
  y: number;
}

interface CandidateLayout {
  score: number;
  tiles: PreviewLayoutTile[];
}

const MIN_ASPECT_RATIO = 0.05;
const MAX_ASPECT_RATIO = 20;
const EXHAUSTIVE_LAYOUT_LIMIT = 10;
const PREVIEW_ASPECT_RATIO_RELATIVE_TOLERANCE = 0.01;

const clampAspectRatio = (aspectRatio: number | null | undefined) => {
  if (!aspectRatio || !Number.isFinite(aspectRatio) || aspectRatio <= 0) return 3 / 2;
  return Math.max(MIN_ASPECT_RATIO, Math.min(MAX_ASPECT_RATIO, aspectRatio));
};

const sameAspectRatio = (a: number, b: number, tolerance: number) => {
  const first = clampAspectRatio(a);
  const second = clampAspectRatio(b);
  return Math.abs(first - second) / Math.max(first, second) <= tolerance;
};

const prepareLayoutImages = (
  images: PreviewLayoutImage[],
  containerWidth: number,
  containerHeight: number,
): PreviewLayoutImage[] | null => {
  if (images.length === 0 || containerWidth <= 0 || containerHeight <= 0) return null;
  return images.map((image) => ({ ...image, aspectRatio: clampAspectRatio(image.aspectRatio) }));
};

export function hasMixedPreviewAspectRatios(
  images: PreviewLayoutImage[],
  tolerance = PREVIEW_ASPECT_RATIO_RELATIVE_TOLERANCE,
) {
  if (images.length < 2) return false;

  const reference = clampAspectRatio(images[0]?.aspectRatio);
  return images.some((image) => !sameAspectRatio(reference, image.aspectRatio, tolerance));
}

const splitBalanced = (images: PreviewLayoutImage[], rowCount: number) => {
  const rows: PreviewLayoutImage[][] = [];
  const total = images.length;
  let offset = 0;

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const remainingImages = total - offset;
    const remainingRows = rowCount - rowIndex;
    const count = Math.ceil(remainingImages / remainingRows);
    rows.push(images.slice(offset, offset + count));
    offset += count;
  }

  return rows.filter((row) => row.length > 0);
};

const createRows = (images: PreviewLayoutImage[], counts: number[]) => {
  const rows: PreviewLayoutImage[][] = [];
  let offset = 0;

  counts.forEach((count) => {
    rows.push(images.slice(offset, offset + count));
    offset += count;
  });

  return rows.filter((row) => row.length > 0);
};

const generateCompositions = (total: number) => {
  const result: number[][] = [];

  const visit = (remaining: number, current: number[]) => {
    if (remaining === 0) {
      result.push(current);
      return;
    }

    for (let count = 1; count <= remaining; count += 1) {
      visit(remaining - count, [...current, count]);
    }
  };

  visit(total, []);
  return result;
};

const buildCandidate = (
  rowsInput: PreviewLayoutImage[][],
  containerWidth: number,
  containerHeight: number,
  gap: number,
): CandidateLayout | null => {
  if (rowsInput.length === 0 || containerWidth <= 0 || containerHeight <= 0) return null;

  const rows = rowsInput.map((images) => ({
    images,
    aspectSum: images.reduce((sum, image) => sum + clampAspectRatio(image.aspectRatio), 0),
  }));

  const rowGapTotal = Math.max(0, rows.length - 1) * gap;
  const availableHeight = containerHeight - rowGapTotal;
  if (availableHeight <= 1) return null;

  const rowHeight = Math.min(
    availableHeight / rows.length,
    ...rows.map((row) => {
      const rowGap = Math.max(0, row.images.length - 1) * gap;
      const availableWidth = containerWidth - rowGap;
      return availableWidth > 0 && row.aspectSum > 0 ? availableWidth / row.aspectSum : 0;
    }),
  );

  if (!Number.isFinite(rowHeight) || rowHeight <= 1) return null;

  const usedHeight = rows.length * rowHeight + rowGapTotal;
  let y = (containerHeight - usedHeight) / 2;
  const tiles: PreviewLayoutTile[] = [];
  let totalArea = 0;
  let minArea = Number.POSITIVE_INFINITY;
  let maxArea = 0;

  rows.forEach((row) => {
    const rowGap = Math.max(0, row.images.length - 1) * gap;
    const rowWidth = row.aspectSum * rowHeight + rowGap;
    let x = (containerWidth - rowWidth) / 2;

    row.images.forEach((image) => {
      const aspectRatio = clampAspectRatio(image.aspectRatio);
      const width = rowHeight * aspectRatio;
      const height = rowHeight;
      const area = width * height;
      totalArea += area;
      minArea = Math.min(minArea, area);
      maxArea = Math.max(maxArea, area);
      tiles.push({
        aspectRatio,
        contentHeight: height,
        contentWidth: width,
        height,
        path: image.path,
        width,
        x,
        y,
      });
      x += width + gap;
    });

    y += rowHeight + gap;
  });

  const containerArea = containerWidth * containerHeight;
  const unusedSpace = Math.max(0, containerArea - totalArea);
  const imbalancePenalty = maxArea > 0 ? (maxArea - minArea) / maxArea : 0;
  const rowCountPenalty = rows.length * 0.001 * containerArea;
  const score =
    totalArea + minArea * 0.65 - unusedSpace * 0.08 - imbalancePenalty * 0.05 * containerArea - rowCountPenalty;

  return { tiles, score };
};

export function computePreviewComparisonLayout({
  images,
  containerWidth,
  containerHeight,
  gap = 12,
}: {
  images: PreviewLayoutImage[];
  containerWidth: number;
  containerHeight: number;
  gap?: number;
}): PreviewLayoutTile[] {
  const sanitizedImages = prepareLayoutImages(images, containerWidth, containerHeight);
  if (!sanitizedImages) return [];
  let best: CandidateLayout | null = null;

  if (sanitizedImages.length <= EXHAUSTIVE_LAYOUT_LIMIT) {
    for (const counts of generateCompositions(sanitizedImages.length)) {
      const candidate = buildCandidate(createRows(sanitizedImages, counts), containerWidth, containerHeight, gap);
      if (candidate && (!best || candidate.score > best.score)) best = candidate;
    }
  } else {
    for (let rowCount = 1; rowCount <= sanitizedImages.length; rowCount += 1) {
      const candidate = buildCandidate(splitBalanced(sanitizedImages, rowCount), containerWidth, containerHeight, gap);
      if (candidate && (!best || candidate.score > best.score)) best = candidate;
    }
  }

  return best?.tiles || [];
}

export function computePreviewFixedCellLayout({
  images,
  containerWidth,
  containerHeight,
  gap = 12,
  cellAspectRatio = 3 / 2,
}: {
  images: PreviewLayoutImage[];
  containerWidth: number;
  containerHeight: number;
  gap?: number;
  cellAspectRatio?: number;
}): PreviewLayoutTile[] {
  const sanitizedImages = prepareLayoutImages(images, containerWidth, containerHeight);
  if (!sanitizedImages) return [];
  const fixedAspectRatio = clampAspectRatio(cellAspectRatio);
  let best: {
    cellHeight: number;
    cellWidth: number;
    columns: number;
    rows: number;
    score: number;
  } | null = null;

  for (let columns = 1; columns <= sanitizedImages.length; columns += 1) {
    const rows = Math.ceil(sanitizedImages.length / columns);
    const availableWidth = containerWidth - Math.max(0, columns - 1) * gap;
    const availableHeight = containerHeight - Math.max(0, rows - 1) * gap;
    if (availableWidth <= 1 || availableHeight <= 1) continue;

    const maxCellWidth = availableWidth / columns;
    const maxCellHeight = availableHeight / rows;
    let cellWidth = maxCellWidth;
    let cellHeight = cellWidth / fixedAspectRatio;

    if (cellHeight > maxCellHeight) {
      cellHeight = maxCellHeight;
      cellWidth = cellHeight * fixedAspectRatio;
    }

    if (!Number.isFinite(cellWidth) || !Number.isFinite(cellHeight) || cellWidth <= 1 || cellHeight <= 1) continue;

    const emptyCells = rows * columns - sanitizedImages.length;
    const score = cellWidth * cellHeight * sanitizedImages.length - emptyCells * cellWidth * cellHeight * 0.12;
    if (!best || score > best.score) {
      best = { cellHeight, cellWidth, columns, rows, score };
    }
  }

  if (!best) return [];

  const layout = best;
  const gridHeight = layout.rows * layout.cellHeight + Math.max(0, layout.rows - 1) * gap;
  const startY = (containerHeight - gridHeight) / 2;

  return sanitizedImages.map((image, index) => {
    const column = index % layout.columns;
    const row = Math.floor(index / layout.columns);
    const rowStartIndex = row * layout.columns;
    const itemsInRow = Math.min(layout.columns, sanitizedImages.length - rowStartIndex);
    const rowWidth = itemsInRow * layout.cellWidth + Math.max(0, itemsInRow - 1) * gap;
    const rowStartX = (containerWidth - rowWidth) / 2;
    const { displayWidth, displayHeight } = getObjectFitDisplayBox(
      { x: 0, y: 0, width: layout.cellWidth, height: layout.cellHeight },
      image.aspectRatio,
      'contain',
    );

    return {
      aspectRatio: image.aspectRatio,
      contentHeight: displayHeight,
      contentWidth: displayWidth,
      height: layout.cellHeight,
      isFixedCell: true,
      path: image.path,
      width: layout.cellWidth,
      x: rowStartX + column * (layout.cellWidth + gap),
      y: startY + row * (layout.cellHeight + gap),
    };
  });
}
