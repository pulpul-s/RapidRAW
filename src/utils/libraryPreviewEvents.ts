export const LIBRARY_PREVIEW_REVEAL_THUMBNAIL_EVENT = 'rapidraw:library-preview-reveal-thumbnail';

export type LibraryPreviewRevealThumbnailDetail = {
  path: string;
};

export function revealLibraryPreviewThumbnail(path: string) {
  window.dispatchEvent(
    new CustomEvent<LibraryPreviewRevealThumbnailDetail>(LIBRARY_PREVIEW_REVEAL_THUMBNAIL_EVENT, {
      detail: { path },
    }),
  );
}
