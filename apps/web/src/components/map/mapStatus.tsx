import { create } from "zustand";

interface MapStatusState {
  /** "N nodes", with the grouping progress while a capture is being grouped; null with no map. */
  readonly status: string | null;
  /** What the last command held back or could not show (Expand all's cap, a map too big to fit). */
  readonly notice: string | null;
}

/**
 * The map's status, shown in the document's status bar rather than over the
 * canvas, where it would cover rows of the cards beneath it.
 */
export const useMapStatus = create<MapStatusState>(() => ({ status: null, notice: null }));

export function MapStatus() {
  const { status, notice } = useMapStatus();
  if (status === null) return null;
  return (
    <span aria-live="polite" data-testid="map-status" role="status">
      {status}
      {notice !== null ? <span data-testid="map-notice"> · {notice}</span> : null}
    </span>
  );
}
