// Native window buttons do not scale with Chromium zoom. Keep their reserved
// space in native points, including when a zoomed page is reloaded.
const WINDOW_CONTROLS_INSET_POINTS = 90;

export interface WindowControlsInsetInput {
  readonly webFrame: { readonly getZoomFactor: () => number };
  readonly root: { readonly style: { setProperty: (name: string, value: string) => void } };
  readonly events: Pick<EventTarget, "addEventListener">;
}

export function installWindowControlsInset(input: WindowControlsInsetInput): void {
  const sync = () => {
    input.root.style.setProperty(
      "--desktop-window-controls-inset",
      `${WINDOW_CONTROLS_INSET_POINTS / input.webFrame.getZoomFactor()}px`,
    );
  };
  input.events.addEventListener("DOMContentLoaded", sync, { once: true });
  input.events.addEventListener("resize", sync);
}
