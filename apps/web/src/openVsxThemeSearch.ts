import type { OpenVsxThemeSort } from "./openVsxThemes";

/**
 * The "Add a theme" search choices and request pacing, kept out of
 * ThemeSearchSection.tsx so they are testable without a React tree.
 */
export const SUGGESTED_SEARCHES: ReadonlyArray<string> = [
  "Dracula",
  "Catppuccin",
  "Nord",
  "Tokyo Night",
];

export const SORT_OPTIONS: ReadonlyArray<{ value: OpenVsxThemeSort; label: string }> = [
  { value: "downloadCount", label: "Most downloaded" },
  { value: "rating", label: "Best rated" },
  { value: "timestamp", label: "Newest" },
  { value: "relevance", label: "Most relevant" },
];

/** How long typing must pause before the query is sent. */
export const SEARCH_DEBOUNCE_MS = 500;

/** Downloads (install checks and icons) the result cards may have in flight at once. */
export const MAX_CONCURRENT_THEME_CHECKS = 3;

/**
 * Runs at most `limit` tasks at a time, in the order they were queued. A
 * queued task whose signal aborts is dropped without starting; a running one
 * sees the abort through the signal it was given.
 */
export function createTaskQueue(limit: number) {
  let running = 0;
  const waiting: Array<() => void> = [];
  const startNext = () => {
    if (running >= limit) return;
    const next = waiting.shift();
    if (!next) return;
    next();
    startNext();
  };
  return function enqueue<A>(
    task: (signal: AbortSignal) => Promise<A>,
    signal: AbortSignal,
  ): Promise<A> {
    return new Promise<A>((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const start = () => {
        signal.removeEventListener("abort", drop);
        running += 1;
        task(signal)
          .then(resolve, reject)
          .finally(() => {
            running -= 1;
            startNext();
          });
      };
      const drop = () => {
        const index = waiting.indexOf(start);
        if (index === -1) return;
        waiting.splice(index, 1);
        reject(signal.reason);
      };
      signal.addEventListener("abort", drop, { once: true });
      waiting.push(start);
      startNext();
    });
  };
}
