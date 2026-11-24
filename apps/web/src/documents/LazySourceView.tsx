import { type ComponentProps, type ComponentType, useEffect, useState } from "react";

import { Spinner } from "~/components/ui/spinner";

type SourceViewComponent = typeof import("./SourceView.tsx").SourceView;

// The highlighter (shiki and its grammars) is the heaviest thing the shell can
// load, and nothing needs it until a document's source is on screen, so the
// view is loaded lazily. This is not React.lazy: a Suspense boundary that shows
// its fallback holds the content back for 300 ms before revealing it, and the
// first screen of a 2 GiB file has 300 ms in all.
let loaded: SourceViewComponent | null = null;
let loading: Promise<SourceViewComponent> | null = null;

function load(): Promise<SourceViewComponent> {
  loading ??= import("./SourceView.tsx").then((module) => {
    loaded = module.SourceView;
    return module.SourceView;
  });
  return loading;
}

/** Starts loading the view's code; a document that has just opened calls it so a switch is instant. */
export function preloadSourceView(): void {
  void load();
}

/** The source view, loaded the first time one is needed. */
export function SourceView(props: ComponentProps<SourceViewComponent>) {
  const [Impl, setImpl] = useState<ComponentType<ComponentProps<SourceViewComponent>> | null>(
    () => loaded,
  );
  useEffect(() => {
    if (Impl !== null) return;
    let current = true;
    void load().then((component) => {
      if (current) setImpl(() => component);
    });
    return () => {
      current = false;
    };
  }, [Impl]);
  if (Impl === null) {
    return (
      <div
        role="status"
        className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-muted-foreground"
      >
        <Spinner size="sm" />
        Loading…
      </div>
    );
  }
  return <Impl {...props} />;
}
