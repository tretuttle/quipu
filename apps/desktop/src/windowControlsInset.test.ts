import { describe, expect, it } from "vite-plus/test";

import { installWindowControlsInset } from "./windowControlsInset.ts";

function setup(initialZoom: number) {
  const properties = new Map<string, string>();
  const events = new EventTarget();
  let zoom = initialZoom;
  installWindowControlsInset({
    webFrame: { getZoomFactor: () => zoom },
    root: { style: { setProperty: (name, value) => void properties.set(name, value) } },
    events,
  });
  return {
    events,
    inset: () => properties.get("--desktop-window-controls-inset"),
    setZoom: (next: number) => {
      zoom = next;
    },
  };
}

describe("window controls inset", () => {
  it("reserves 90px at the default zoom", () => {
    const page = setup(1);
    page.events.dispatchEvent(new Event("DOMContentLoaded"));
    expect(page.inset()).toBe("90px");
  });

  it("divides the reserved space by the zoom factor so it stays 90 native points", () => {
    const page = setup(1.5);
    page.events.dispatchEvent(new Event("DOMContentLoaded"));
    expect(page.inset()).toBe("60px");

    page.setZoom(0.5);
    page.events.dispatchEvent(new Event("resize"));
    expect(page.inset()).toBe("180px");
  });
});
