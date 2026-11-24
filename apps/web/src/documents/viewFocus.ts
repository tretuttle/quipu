/**
 * Where the keyboard goes back to when what had it goes away: an editor that
 * commits, a dialog that closes, a document that opens or opens again. The
 * views (Tree, Source, Map) each keep one focusable cursor (a row, a node, the
 * text), so "the view" is that element.
 */

/** The views' cursor elements: a tree row, a map node, the Source view's text. */
const VIEW_CURSOR = [
  "[data-tree-view] [role='treeitem'][tabindex='0']",
  "[data-map-view] [role='treeitem'][tabindex='0']",
  "[data-source-view] [role='document']",
].join(", ");

let lastInView: HTMLElement | null = null;

const inView = (element: Element | null): element is HTMLElement =>
  element instanceof HTMLElement &&
  element.closest("[data-tree-view], [data-map-view], [data-source-view]") !== null;

/** The keyboard is nowhere: on the page itself, or on an element that has left it. */
const focusIsLost = () => {
  const active = document.activeElement;
  return active === null || active === document.body || !active.isConnected;
};

if (typeof document !== "undefined") {
  document.addEventListener("focusin", (event) => {
    if (inView(event.target as Element | null)) lastInView = event.target as HTMLElement;
  });
}

/**
 * The element to give the keyboard back to: `preferred` while it is still on
 * the page, else the view's cursor (where a search step or an edit left it),
 * else the last element focused in a view.
 */
export function viewFocusTarget(preferred: HTMLElement | null = null): HTMLElement | null {
  if (preferred?.isConnected === true && preferred !== document.body) return preferred;
  const cursor = document.querySelector<HTMLElement>(VIEW_CURSOR);
  if (cursor !== null) return cursor;
  return lastInView?.isConnected === true ? lastInView : null;
}

/**
 * Gives the keyboard back to the view when it was lost; leaves it alone
 * otherwise. A view still drawing its cursor (an edited node's row comes back
 * under a new id) gets it once the cursor is there.
 */
export function returnFocusToView(preferred: HTMLElement | null = null): void {
  if (!focusIsLost()) return;
  const target = viewFocusTarget(preferred);
  if (target !== null) target.focus({ preventScroll: true });
  else focusViewWhenReady();
}

/**
 * Once the view of a document that just opened draws its cursor, gives it the
 * keyboard, unless the user put the keyboard somewhere first.
 */
export function focusViewWhenReady(): () => void {
  if (typeof document === "undefined") return () => {};
  let done = false;
  const finish = () => {
    done = true;
    observer.disconnect();
    document.removeEventListener("focusin", onFocus);
  };
  const attempt = () => {
    if (done) return;
    if (!focusIsLost()) return finish();
    const cursor = document.querySelector<HTMLElement>(VIEW_CURSOR);
    if (cursor === null) return;
    cursor.focus({ preventScroll: true });
    finish();
  };
  const onFocus = () => {
    if (!focusIsLost()) finish();
  };
  const observer = new MutationObserver(attempt);
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["tabindex"],
  });
  document.addEventListener("focusin", onFocus);
  attempt();
  return finish;
}
