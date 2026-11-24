import { RefreshIcon } from "~/components/ui/refresh-icon";
import { ExternalLinkIcon, PackagePlusIcon, PaletteIcon, SearchIcon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  createTaskQueue,
  MAX_CONCURRENT_THEME_CHECKS,
  SEARCH_DEBOUNCE_MS,
  SORT_OPTIONS,
  SUGGESTED_SEARCHES,
} from "../../openVsxThemeSearch";
import {
  checkOpenVsxTheme,
  fetchOpenVsxIcon,
  importOpenVsxThemeExtension,
  openVsxCollectionId,
  searchOpenVsxThemes,
  type OpenVsxThemeCandidate,
  type OpenVsxThemeCheck,
  type OpenVsxThemeExtension,
  type OpenVsxThemeSort,
} from "../../openVsxThemes";
import {
  getCustomThemes,
  getStoredCustomThemeCollection,
  replaceCustomThemeCollection,
  type ThemeDefinition,
} from "../../themePalette";
import { GitHubIcon, GitLabIcon } from "../Icons";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";

const DOWNLOAD_FORMAT = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

function useDebouncedValue<A>(value: A, delayMs: number): A {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebounced(value);
    }, delayMs);
    return () => {
      window.clearTimeout(timer);
    };
  }, [delayMs, value]);

  return debounced;
}

function SourceLinkIcon({ url }: { url: string }) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === "github.com" || host.endsWith(".github.com"))
      return <GitHubIcon className="size-3.5" />;
    if (host === "gitlab.com" || host.endsWith(".gitlab.com"))
      return <GitLabIcon className="size-3.5" monochrome />;
  } catch {
    // Fall through to the generic external-link icon.
  }
  return <ExternalLinkIcon className="size-3.5" />;
}

type QueueTask = ReturnType<typeof createTaskQueue>;

/**
 * Loads a card's icon once the card is on screen, through the shared download
 * queue, as a Blob URL (see {@link fetchOpenVsxIcon}). A load that has not
 * finished when the card leaves the screen is cancelled and retried on return.
 */
function useExtensionIcon(iconUrl: string | null, visible: boolean, enqueue: QueueTask) {
  const [src, setSrc] = useState<string | null>(null);
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (iconUrl === null || !visible || settled) return;
    const controller = new AbortController();
    enqueue((signal) => fetchOpenVsxIcon(iconUrl, signal), controller.signal).then(
      (blob) => {
        if (blob) setSrc(URL.createObjectURL(blob));
        setSettled(true);
      },
      () => {
        // Cancelled; a later visit starts it again.
      },
    );
    return () => controller.abort();
  }, [enqueue, iconUrl, settled, visible]);
  useEffect(
    () => () => {
      if (src) URL.revokeObjectURL(src);
    },
    [src],
  );
  return src;
}

/** An extension's icon, or the generic glyph when it has none or it cannot be shown. */
function ThemeExtensionIcon({ src }: { src: string | null }) {
  const [failed, setFailed] = useState(false);

  return (
    <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted text-muted-foreground">
      {src && !failed ? (
        <img
          alt=""
          className="size-full object-cover"
          data-theme-extension-icon=""
          src={src}
          onError={() => setFailed(true)}
        />
      ) : (
        <PaletteIcon aria-hidden className="size-4" />
      )}
    </div>
  );
}

type ThemeCheckState =
  | { status: "checking" }
  | OpenVsxThemeCheck
  | { status: "error"; message: string };

function checkKey(candidate: OpenVsxThemeCandidate): string {
  return `${candidate.id}@${candidate.version}`;
}

/** Calls back when the element scrolls into or out of view, clipped by its scroll containers. */
function useVisibility(onChange: (visible: boolean) => void) {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const onChangeRef = useRef(onChange);
  useLayoutEffect(() => {
    onChangeRef.current = onChange;
  });
  useEffect(() => {
    if (element === null) return;
    if (typeof IntersectionObserver === "undefined") {
      onChangeRef.current(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      const entry = entries.at(-1);
      if (entry) onChangeRef.current(entry.isIntersecting);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return setElement;
}

const UNSUPPORTED_REASON: Record<
  Extract<OpenVsxThemeCheck, { status: "unsupported" }>["reason"],
  string
> = {
  license: "Its license is not one Quipu can install.",
  "no-themes": "It has no color themes.",
};

function ThemeSearchResultCard({
  candidate,
  check,
  enqueue,
  installingId,
  isInstalled,
  onVisibleChange,
  onInstall,
  onRetry,
}: {
  candidate: OpenVsxThemeCandidate;
  check: ThemeCheckState | undefined;
  enqueue: QueueTask;
  installingId: string | null;
  isInstalled: boolean;
  onVisibleChange: (candidate: OpenVsxThemeCandidate, visible: boolean) => void;
  onInstall: (extension: OpenVsxThemeExtension) => void;
  onRetry: (candidate: OpenVsxThemeCandidate) => void;
}) {
  const [visible, setVisible] = useState(false);
  const observe = useVisibility((nextVisible) => {
    setVisible(nextVisible);
    onVisibleChange(candidate, nextVisible);
  });
  const iconSrc = useExtensionIcon(candidate.iconUrl, visible, enqueue);
  const extension = check?.status === "supported" ? check.extension : null;
  const isInstalling = installingId === candidate.id;
  const action = isInstalled ? "Update" : "Install";
  const progressAction = isInstalled ? "Updating" : "Installing";
  return (
    <article
      ref={observe}
      className="group flex min-w-0 flex-col gap-3 rounded-xl border border-border/70 bg-card/60 p-3 transition-colors hover:bg-accent/20"
    >
      <div className="flex min-w-0 gap-3">
        <ThemeExtensionIcon key={iconSrc} src={iconSrc} />
        <div className="min-w-0 flex-1">
          <h4 className="text-sm font-medium break-words">{candidate.name}</h4>
          <p className="text-muted-foreground text-xs break-words">
            {candidate.publisher} · {DOWNLOAD_FORMAT.format(candidate.downloadCount)} downloads
          </p>
        </div>
      </div>
      <p className="line-clamp-2 min-h-8 text-muted-foreground text-xs leading-4">
        {candidate.description || "A community color theme for your editor."}
      </p>
      <div className="mt-auto flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {extension?.sourceUrl ? (
            <Button
              aria-label={`View source for ${candidate.name}`}
              render={<a href={extension.sourceUrl} rel="noreferrer" target="_blank" />}
              size="icon-micro"
              variant="ghost-muted"
            >
              <SourceLinkIcon url={extension.sourceUrl} />
            </Button>
          ) : null}
          {check?.status === "unsupported" ? (
            <p className="text-muted-foreground text-xs">{UNSUPPORTED_REASON[check.reason]}</p>
          ) : null}
          {check?.status === "error" ? (
            <p className="text-muted-foreground text-xs">{check.message}</p>
          ) : null}
        </div>
        {check?.status === "error" ? (
          <Button
            aria-label={`Check ${candidate.name} again`}
            size="xs"
            variant="outline"
            onClick={() => onRetry(candidate)}
          >
            <RefreshIcon />
            Retry
          </Button>
        ) : check?.status === "unsupported" ? null : (
          <Button
            aria-label={`${isInstalling ? progressAction : action} ${candidate.name}`}
            disabled={extension === null || installingId !== null}
            size="xs"
            variant="outline"
            onClick={() => {
              if (extension) onInstall(extension);
            }}
          >
            {isInstalling || extension === null ? (
              <Spinner />
            ) : isInstalled ? (
              <RefreshIcon />
            ) : (
              <PackagePlusIcon />
            )}
            {isInstalling ? `${progressAction}...` : extension === null ? "Checking..." : action}
          </Button>
        )}
      </div>
    </article>
  );
}

export function ThemeSearchSection({
  open,
  onInstalled,
}: {
  open: boolean;
  onInstalled: (themes: ReadonlyArray<ThemeDefinition>, context: { updated: boolean }) => void;
}) {
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState<OpenVsxThemeSort>("downloadCount");
  const [results, setResults] = useState<ReadonlyArray<OpenVsxThemeCandidate> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [pendingUpdate, setPendingUpdate] = useState<OpenVsxThemeExtension | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  // The (query, sort) pair the last search actually ran, so an install
  // finishing can tell a same-key rerun (which must not wipe an install
  // error) from a query that changed mid-install (which must be searched).
  const lastSearchKeyRef = useRef<string | null>(null);
  // The (query, sort) pair from the previous effect run, so a search error
  // that belongs to an older key can be cleared when the user returns to
  // already-shown results without clearing a fresh install error.
  const prevSearchKeyRef = useRef<string | null>(null);
  // Install checks, keyed by extension and version. Finished checks are kept
  // for the life of the dialog; a check is only started for a card on screen,
  // and one whose card scrolls away or unmounts before it finishes is aborted.
  const [checks, setChecks] = useState<ReadonlyMap<string, ThemeCheckState>>(() => new Map());
  // Mirrors `checks` for the callbacks, which must not wait for a render.
  const checksRef = useRef<ReadonlyMap<string, ThemeCheckState>>(checks);
  const checkControllersRef = useRef(new Map<string, AbortController>());
  // Checks and icons share one queue, so a query never has more than a few
  // downloads in flight.
  const enqueueCheck = useMemo(() => createTaskQueue(MAX_CONCURRENT_THEME_CHECKS), []);

  const writeCheck = useCallback((key: string, state: ThemeCheckState | null) => {
    const next = new Map(checksRef.current);
    if (state === null) next.delete(key);
    else next.set(key, state);
    checksRef.current = next;
    setChecks(next);
  }, []);

  const cancelCheck = useCallback(
    (key: string) => {
      const controller = checkControllersRef.current.get(key);
      if (!controller) return;
      checkControllersRef.current.delete(key);
      controller.abort();
      if (checksRef.current.get(key)?.status === "checking") writeCheck(key, null);
    },
    [writeCheck],
  );

  const startCheck = useCallback(
    (candidate: OpenVsxThemeCandidate, { retry = false } = {}) => {
      const key = checkKey(candidate);
      const known = checksRef.current.get(key);
      if (checkControllersRef.current.has(key)) return;
      if (known && !(retry && known.status === "error")) return;
      const controller = new AbortController();
      checkControllersRef.current.set(key, controller);
      writeCheck(key, { status: "checking" });
      void enqueueCheck((signal) => checkOpenVsxTheme(candidate, signal), controller.signal)
        .then(
          (result): ThemeCheckState => result,
          (cause: unknown): ThemeCheckState => ({
            status: "error",
            message: cause instanceof Error ? cause.message : "This theme could not be checked.",
          }),
        )
        .then((state) => {
          if (checkControllersRef.current.get(key) !== controller) return;
          checkControllersRef.current.delete(key);
          writeCheck(key, state);
        });
    },
    [enqueueCheck, writeCheck],
  );

  const handleCardVisibility = useCallback(
    (candidate: OpenVsxThemeCandidate, visible: boolean) => {
      if (visible) startCheck(candidate);
      else cancelCheck(checkKey(candidate));
    },
    [cancelCheck, startCheck],
  );

  // A new result list drops the checks its cards no longer need.
  useEffect(() => {
    const keep = new Set((results ?? []).map(checkKey));
    for (const key of checkControllersRef.current.keys()) {
      if (!keep.has(key)) cancelCheck(key);
    }
  }, [cancelCheck, results]);

  useEffect(() => {
    requestRef.current?.abort();
    requestRef.current = null;
    for (const controller of checkControllersRef.current.values()) controller.abort();
    checkControllersRef.current.clear();
    if (open) {
      checksRef.current = new Map();
      setChecks(checksRef.current);
      lastSearchKeyRef.current = null;
      prevSearchKeyRef.current = null;
      setQuery("");
      setSortBy("downloadCount");
      setResults(null);
      setError(null);
      setIsSearching(false);
      setInstallingId(null);
      setPendingUpdate(null);
    }
    return () => {
      requestRef.current?.abort();
      requestRef.current = null;
    };
  }, [open]);

  const runSearch = useCallback(
    async (searchText: string, nextSort = sortBy) => {
      const trimmed = searchText.trim();
      if (!trimmed) return;
      requestRef.current?.abort();
      const controller = new AbortController();
      requestRef.current = controller;
      setError(null);
      setIsSearching(true);
      try {
        const nextResults = await searchOpenVsxThemes(trimmed, {
          signal: controller.signal,
          sortBy: nextSort,
        });
        if (!controller.signal.aborted) {
          setResults(nextResults);
          lastSearchKeyRef.current = `${trimmed}\u0000${nextSort}`;
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          setResults(null);
          lastSearchKeyRef.current = null;
          setError(cause instanceof Error ? cause.message : "Open VSX search failed.");
        }
      }
      if (requestRef.current === controller) {
        requestRef.current = null;
        setIsSearching(false);
      }
    },
    [sortBy],
  );

  const debouncedQuery = useDebouncedValue(query.trim(), SEARCH_DEBOUNCE_MS);

  useEffect(() => {
    if (query.trim() || installingId !== null) return;
    requestRef.current?.abort();
    requestRef.current = null;
    lastSearchKeyRef.current = null;
    setResults(null);
    setError(null);
    setIsSearching(false);
  }, [query, installingId]);

  useEffect(() => {
    if (!open) return;
    const searchKey = `${debouncedQuery}\u0000${sortBy}`;
    const keyChanged = prevSearchKeyRef.current !== searchKey;
    prevSearchKeyRef.current = searchKey;
    if (installingId !== null) return;
    if (!debouncedQuery) {
      lastSearchKeyRef.current = null;
      requestRef.current?.abort();
      requestRef.current = null;
      setResults(null);
      setError(null);
      setIsSearching(false);
      return;
    }
    if (debouncedQuery !== query.trim()) {
      // The debounced value still trails the input (dialog reopened with the
      // box reset, or the user is mid-keystroke). Searching it would hit Open
      // VSX for a query that is no longer visible; wait for the debounce to
      // catch up to the current input instead.
      return;
    }
    if (lastSearchKeyRef.current === searchKey) {
      // The results already match this query. A request for a newer key may
      // still be in flight (typed and then undone); abort it so it cannot
      // overwrite the results. Only a genuine key change makes a stale search
      // error irrelevant, so an install error on an unchanged query survives.
      requestRef.current?.abort();
      requestRef.current = null;
      setIsSearching(false);
      if (keyChanged) setError(null);
      return;
    }
    void runSearch(debouncedQuery);
    // `sortBy` is deliberately not a direct dependency: the guards above read
    // the current value from the fresh render closure. An install finishing
    // reruns the search only when the query or sort changed while it was in
    // flight (checked via lastSearchKeyRef, recorded only once a search
    // succeeds), so the install error the user needs to see is preserved
    // across that rerun.
  }, [open, query, debouncedQuery, installingId, runSearch]);

  const handleSortChange = useCallback((value: OpenVsxThemeSort | null) => {
    const nextSort = SORT_OPTIONS.find((option) => option.value === value)?.value;
    if (!nextSort) return;
    setSortBy(nextSort);
  }, []);

  const handleInstall = useCallback(
    async (extension: OpenVsxThemeExtension, allowUpdate: boolean) => {
      setError(null);
      let installedCollection: ReadonlyArray<ThemeDefinition>;
      try {
        installedCollection = getStoredCustomThemeCollection(extension.collectionId);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Installed themes could not be read.");
        return;
      }
      const updated = installedCollection.length > 0;
      if (updated && !allowUpdate) {
        setPendingUpdate(extension);
        return;
      }

      requestRef.current?.abort();
      const controller = new AbortController();
      requestRef.current = controller;
      setIsSearching(false);
      setInstallingId(extension.id);
      try {
        const themes = await importOpenVsxThemeExtension(extension, controller.signal);
        if (!controller.signal.aborted) {
          const imported = replaceCustomThemeCollection(extension.collectionId, themes, {
            expectedCollection: installedCollection,
          });
          onInstalled(imported, { updated });
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : "That theme could not be added.");
        }
      }
      if (requestRef.current === controller) {
        requestRef.current = null;
        setInstallingId(null);
      }
    },
    [onInstalled],
  );

  return (
    <section className="space-y-3" aria-labelledby="theme-search-heading">
      <div>
        <h3 className="text-sm font-medium" id="theme-search-heading">
          Search community themes
        </h3>
        <p className="mt-0.5 text-muted-foreground text-xs">
          Find open-source themes from Open VSX.
        </p>
      </div>
      <InputGroup>
        <InputGroupAddon>
          {isSearching ? <Spinner aria-hidden /> : <SearchIcon aria-hidden />}
        </InputGroupAddon>
        <InputGroupInput
          aria-label="Search Open VSX themes"
          autoFocus
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === "Enter" && !isSearching && installingId === null)
              void runSearch(query.trim());
          }}
          placeholder="Search themes…"
          size="lg"
          type="search"
          value={query}
        />
      </InputGroup>

      {!isSearching || results !== null ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <p className="text-muted-foreground text-xs">Popular</p>
            {SUGGESTED_SEARCHES.map((suggestion) => (
              <Button
                key={suggestion}
                disabled={installingId !== null}
                size="xs"
                variant="ghost"
                onClick={() => {
                  if (query.trim() === suggestion) {
                    void runSearch(suggestion);
                  } else {
                    setQuery(suggestion);
                  }
                }}
              >
                {suggestion}
              </Button>
            ))}
          </div>
          {results && results.length > 0 ? (
            <div className="flex shrink-0 items-center justify-end gap-2">
              <p className="text-muted-foreground text-xs">Sort</p>
              <Select
                disabled={installingId !== null}
                value={sortBy}
                onValueChange={handleSortChange}
              >
                <SelectTrigger size="sm" className="w-40" aria-label="Sort themes">
                  <SelectValue>
                    {SORT_OPTIONS.find((option) => option.value === sortBy)?.label}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {SORT_OPTIONS.map((option) => (
                    <SelectItem key={option.value} hideIndicator value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="sr-only" role="status">
        {isSearching
          ? "Searching themes…"
          : results
            ? `${results.length} ${results.length === 1 ? "theme" : "themes"} found.`
            : ""}
      </div>

      {error ? (
        <Alert variant="error" role="status" aria-live="polite">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {isSearching && results === null ? (
        <div className="flex min-h-20 items-center justify-center gap-2 text-muted-foreground text-sm">
          <Spinner /> Searching themes...
        </div>
      ) : null}

      {results ? (
        results.length === 0 ? (
          <div className="flex min-h-40 flex-col items-center justify-center rounded-2xl border border-dashed text-center">
            <p className="text-sm font-medium">No themes found</p>
            <p className="mt-1 text-muted-foreground text-xs">Try a broader search.</p>
          </div>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {results.map((candidate) => (
              <ThemeSearchResultCard
                candidate={candidate}
                check={checks.get(checkKey(candidate))}
                enqueue={enqueueCheck}
                installingId={installingId}
                isInstalled={getCustomThemes().some(
                  (theme) => theme.collection?.id === openVsxCollectionId(candidate.id),
                )}
                key={candidate.id}
                onInstall={(extension) => void handleInstall(extension, false)}
                onRetry={(retried) => startCheck(retried, { retry: true })}
                onVisibleChange={handleCardVisibility}
              />
            ))}
          </div>
        )
      ) : null}

      <AlertDialog
        open={pendingUpdate !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setPendingUpdate(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Update “{pendingUpdate?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This replaces its installed variants, including any local edits. Variants no longer in
              the extension will be removed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              onClick={() => {
                const extension = pendingUpdate;
                setPendingUpdate(null);
                if (extension) void handleInstall(extension, true);
              }}
            >
              Update theme
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </section>
  );
}
