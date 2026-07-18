import { getCurrentWindow } from '@tauri-apps/api/window';
import { ImageFile, LibraryLayoutMode } from '../components/ui/AppProperties';
import { useEditorStore } from '../store/useEditorStore';
import { useLibraryStore } from '../store/useLibraryStore';
import { useUIStore } from '../store/useUIStore';

function getLibraryTargetPath(): string | null {
  const { libraryActivePath, multiSelectedPaths } = useLibraryStore.getState();
  return libraryActivePath || multiSelectedPaths?.[0] || null;
}

function persistLibraryPreviewThumbnailScrollTop() {
  const element = document.querySelector<HTMLElement>('.library-preview-thumbnail-list');
  if (!element) return;

  useUIStore.getState().setUI({ libraryPreviewThumbnailScrollTop: element.scrollTop });
}

async function enterQuickPreviewWindowFullscreen(): Promise<boolean> {
  try {
    const appWindow = getCurrentWindow();
    const wasWindowFullscreen = await appWindow.isFullscreen();
    if (!useUIStore.getState().quickPreviewMode) return false;

    if (!wasWindowFullscreen) {
      await appWindow.setFullscreen(true);
      if (!useUIStore.getState().quickPreviewMode) {
        try {
          await appWindow.setFullscreen(false);
          useUIStore.getState().setUI({ isWindowFullScreen: false });
        } catch (error) {
          console.error('Failed to restore windowed mode after cancelling quick preview:', error);
        }
        return false;
      }
    }

    useUIStore.getState().setUI({
      isWindowFullScreen: true,
      quickPreviewRestoreWindowed: !wasWindowFullscreen,
    });
  } catch (error) {
    console.error('Failed to enter quick preview window fullscreen:', error);
    useUIStore.getState().setUI({ quickPreviewRestoreWindowed: false });
  }

  return useUIStore.getState().quickPreviewMode;
}

export function canToggleQuickPreviewFromShortcut(): boolean {
  const { selectedImage } = useEditorStore.getState();
  const { quickPreviewMode } = useUIStore.getState();

  return (quickPreviewMode && !!selectedImage) || (!selectedImage && !!getLibraryTargetPath());
}

export async function toggleQuickPreviewFromShortcut({
  handleBackToLibrary,
  handleImageSelect,
  sortedImageList,
}: {
  handleBackToLibrary(): void;
  handleImageSelect(path: string): void | Promise<void>;
  sortedImageList: ImageFile[];
}): Promise<void> {
  const { selectedImage } = useEditorStore.getState();
  const library = useLibraryStore.getState();
  const ui = useUIStore.getState();

  if (ui.quickPreviewMode && selectedImage) {
    handleBackToLibrary();
    return;
  }

  if (selectedImage) return;

  const targetPath =
    ui.libraryLayoutMode === LibraryLayoutMode.Preview && ui.libraryPreviewActivePath
      ? ui.libraryPreviewActivePath
      : getLibraryTargetPath();
  if (!targetPath) return;

  const selectedSet = new Set(library.multiSelectedPaths || []);
  const previewScopePaths =
    ui.libraryLayoutMode === LibraryLayoutMode.Preview && selectedSet.size > 0
      ? sortedImageList.filter((image) => selectedSet.has(image.path)).map((image) => image.path)
      : [];

  if (ui.libraryLayoutMode === LibraryLayoutMode.Preview) {
    persistLibraryPreviewThumbnailScrollTop();
  }

  ui.setUI({
    isFullScreen: true,
    quickPreviewMode: true,
    quickPreviewRestoreWindowed: false,
    quickPreviewScopePaths: previewScopePaths,
    quickPreviewRestoreSelectionPaths:
      ui.libraryLayoutMode === LibraryLayoutMode.Preview ? [...(library.multiSelectedPaths || [])] : [],
  });

  if (!(await enterQuickPreviewWindowFullscreen())) return;

  await handleImageSelect(previewScopePaths.includes(targetPath) ? targetPath : previewScopePaths[0] || targetPath);
}
