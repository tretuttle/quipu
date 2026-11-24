import { isMacPlatform, isWindowsPlatform } from "@quipu/shared/keybindings";
import { type CxOptions, cx } from "class-variance-authority";
import { extendTailwindMerge } from "tailwind-merge";

// The theme's extra font sizes (index.css). Unregistered, tailwind-merge reads
// text-2xs as a color and drops it next to text-muted-foreground.
const twMerge = extendTailwindMerge({ extend: { theme: { text: ["2xs", "3xs", "4xs", "5xs"] } } });

export function cn(...inputs: CxOptions) {
  return twMerge(cx(inputs));
}

export { isMacPlatform, isWindowsPlatform };

/** Lowercased, accent-folded and whitespace-collapsed, so search ignores case and diacritics. */
export function normalizeSearchText(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}
