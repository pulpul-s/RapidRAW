export const LOUPE_RENDER_AREAS = ['1024', '1536', '2048', '3072', 'full'] as const;

export type LoupeRenderArea = (typeof LOUPE_RENDER_AREAS)[number];

export const LOUPE_RENDER_AREA_DEFAULT: LoupeRenderArea = '1536';

export function normalizeLoupeRenderArea(value?: string | null): LoupeRenderArea {
  return LOUPE_RENDER_AREAS.includes(value as LoupeRenderArea) ? (value as LoupeRenderArea) : LOUPE_RENDER_AREA_DEFAULT;
}
