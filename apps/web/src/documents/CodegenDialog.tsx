import {
  CODEGEN_LANGUAGES,
  CODEGEN_LANGUAGE_EXTENSIONS,
  CODEGEN_LANGUAGE_LABELS,
  DEFAULT_MAX_ENUM,
  type CodegenLanguage,
  type CodegenOptions,
  type CodegenResult,
} from "@quipu/contracts/schema";
import { CheckIcon, CopyIcon, DownloadIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Spinner } from "~/components/ui/spinner";

import { viewFocusTarget } from "./viewFocus.ts";

export interface CodegenDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly defaultRootName?: string;
  readonly defaultLanguage?: CodegenLanguage;
  readonly maxEnum?: number;
  readonly generate: (options: CodegenOptions) => CodegenResult | Promise<CodegenResult>;
}

type GenerationState =
  | { readonly key: string; readonly phase: "ready"; readonly result: CodegenResult }
  | { readonly key: string; readonly phase: "failed"; readonly message: string };

export function CodegenDialog({
  open,
  onOpenChange,
  defaultRootName = "Root",
  defaultLanguage = "typescript",
  maxEnum = DEFAULT_MAX_ENUM,
  generate,
}: CodegenDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-3xl" finalFocus={() => viewFocusTarget() ?? true}>
        {open ? (
          <CodegenDialogBody
            defaultRootName={defaultRootName}
            defaultLanguage={defaultLanguage}
            maxEnum={maxEnum}
            generate={generate}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

function CodegenDialogBody({
  defaultRootName,
  defaultLanguage,
  maxEnum,
  generate,
  onClose,
}: {
  readonly defaultRootName: string;
  readonly defaultLanguage: CodegenLanguage;
  readonly maxEnum: number;
  readonly generate: (options: CodegenOptions) => CodegenResult | Promise<CodegenResult>;
  readonly onClose: () => void;
}) {
  const [language, setLanguage] = useState<CodegenLanguage>(defaultLanguage);
  const [rootName, setRootName] = useState(defaultRootName);
  const [state, setState] = useState<GenerationState | null>(null);
  const [copied, setCopied] = useState(false);

  const normalizedRoot = rootName || "Root";
  const requestKey = `${language}\0${normalizedRoot}\0${maxEnum}`;

  useEffect(() => {
    let active = true;
    Promise.resolve(generate({ language, rootName: normalizedRoot, maxEnum })).then(
      (res) => {
        if (!active) return;
        setState({ key: requestKey, phase: "ready", result: res });
      },
      (err: unknown) => {
        if (!active) return;
        setState({
          key: requestKey,
          phase: "failed",
          message: err instanceof Error ? err.message : "Failed to generate types.",
        });
      },
    );
    return () => {
      active = false;
    };
  }, [language, normalizedRoot, maxEnum, requestKey, generate]);

  const loading = state === null || state.key !== requestKey;
  const result = !loading && state.phase === "ready" ? state.result : null;
  const error = !loading && state.phase === "failed" ? state.message : null;
  const code = result?.code ?? "";
  const extension = result?.extension ?? CODEGEN_LANGUAGE_EXTENSIONS[language];

  const handleCopy = () => {
    if (!code) return;
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  const handleDownload = () => {
    if (!code) return;
    const base = normalizedRoot
      .trim()
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, "-")
      .replaceAll(/^-|-$/g, "");
    const filename = `${base || "types"}.${extension}`;
    const blob = new Blob([code], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Generate Types</DialogTitle>
        <DialogDescription>
          Generate typed definitions from the document&apos;s inferred shape.
        </DialogDescription>
      </DialogHeader>

      <DialogPanel>
        <div className="flex flex-col gap-3">
          <div
            role="tablist"
            aria-label="Target language"
            className="flex flex-wrap items-center gap-1"
          >
            {CODEGEN_LANGUAGES.map((lang) => {
              const selected = lang === language;
              return (
                <Button
                  key={lang}
                  role="tab"
                  aria-selected={selected}
                  size="xs"
                  variant={selected ? "default" : "outline"}
                  onClick={() => setLanguage(lang)}
                >
                  {CODEGEN_LANGUAGE_LABELS[lang]}
                </Button>
              );
            })}
          </div>

          <div className="flex items-center gap-3">
            <label htmlFor="codegen-root-name" className="shrink-0 text-foreground text-xs">
              Root name
            </label>
            <Input
              id="codegen-root-name"
              size="compact"
              font="mono"
              className="max-w-xs"
              aria-label="Root type name"
              value={rootName}
              onChange={(event) => setRootName(event.currentTarget.value)}
            />
          </div>

          {error !== null ? (
            <Alert variant="error">
              <AlertTitle>Generation failed</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          <div className="relative h-80 overflow-hidden rounded-lg border border-border bg-muted/30">
            {loading ? (
              <div className="flex h-full items-center justify-center gap-2 text-muted-foreground text-xs">
                <Spinner size="xs" />
                Generating…
              </div>
            ) : (
              <ScrollArea className="size-full">
                <pre
                  data-codegen-preview=""
                  className="p-3 font-mono text-foreground text-xs leading-relaxed"
                >
                  {code}
                </pre>
              </ScrollArea>
            )}
          </div>
        </div>
      </DialogPanel>

      <DialogFooter>
        <Button size="sm" variant="outline" onClick={handleCopy} disabled={!code || loading}>
          {copied ? (
            <CheckIcon aria-hidden className="size-3.5" />
          ) : (
            <CopyIcon aria-hidden className="size-3.5" />
          )}
          {copied ? "Copied" : "Copy"}
        </Button>
        <Button size="sm" variant="outline" onClick={handleDownload} disabled={!code || loading}>
          <DownloadIcon aria-hidden className="size-3.5" />
          Download .{extension}
        </Button>
        <Button size="sm" onClick={onClose}>
          Close
        </Button>
      </DialogFooter>
    </>
  );
}
