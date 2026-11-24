export const SIDEBAR_WIDTH_STORAGE_KEY = "quipu:sidebar-width";
const SIDEBAR_DEFAULT_WIDTH = 16 * 16;
export const SIDEBAR_MIN_WIDTH = 13 * 16;
export const MAIN_CONTENT_MIN_WIDTH = 40 * 16;

// The brand's measured width can raise the minimum so "Quipu" never clips.
export function resolveSidebarMinimumWidth(brandWidth: number): number {
  return Math.max(SIDEBAR_MIN_WIDTH, Math.ceil(brandWidth));
}

export function resolveSidebarMaximumWidth(
  viewportWidth: number,
  minimumWidth = SIDEBAR_MIN_WIDTH,
): number {
  return Math.max(minimumWidth, Math.floor(viewportWidth) - MAIN_CONTENT_MIN_WIDTH);
}

export function clampSidebarWidth(
  width: number,
  minimumWidth: number,
  maximumWidth: number,
): number {
  return Math.min(maximumWidth, Math.max(minimumWidth, width));
}

export function resolveInitialSidebarWidth(
  storedWidth: number | null,
  viewportWidth: number,
): number {
  const preferredWidth =
    storedWidth === null ? SIDEBAR_DEFAULT_WIDTH : Math.max(SIDEBAR_MIN_WIDTH, storedWidth);
  return Math.min(preferredWidth, resolveSidebarMaximumWidth(viewportWidth));
}
