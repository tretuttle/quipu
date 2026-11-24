import type {
  ElementStyle,
  FillStyle,
  InkToken,
  StrokeStyle,
  StrokeWidth,
} from "@quipu/canvas/elements";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

const INKS: ReadonlyArray<{ token: InkToken; label: string }> = [
  { token: "default", label: "Ink" },
  { token: "muted", label: "Muted" },
  { token: "red", label: "Red" },
  { token: "blue", label: "Blue" },
  { token: "green", label: "Green" },
  { token: "amber", label: "Amber" },
  { token: "violet", label: "Violet" },
];
const FILLS: ReadonlyArray<{ value: FillStyle; label: string }> = [
  { value: "none", label: "No fill" },
  { value: "soft", label: "Soft fill" },
  { value: "solid", label: "Solid fill" },
];
const WIDTHS: ReadonlyArray<{ value: StrokeWidth; label: string }> = [
  { value: 1, label: "Thin" },
  { value: 2, label: "Regular" },
  { value: 4, label: "Bold" },
];
const STROKES: ReadonlyArray<{ value: StrokeStyle; label: string }> = [
  { value: "solid", label: "Solid" },
  { value: "dashed", label: "Dashed" },
  { value: "dotted", label: "Dotted" },
];

function Row({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-col gap-1">
      <span className="text-2xs font-medium text-muted-foreground">{label}</span>
      <div className="flex flex-wrap gap-0.5">{children}</div>
    </div>
  );
}

function Choice({
  pressed,
  label,
  onClick,
  children,
}: {
  readonly pressed: boolean;
  readonly label: string;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <Button
      role="radio"
      aria-checked={pressed}
      aria-label={label}
      data-pressed={pressed ? "" : undefined}
      onClick={onClick}
      size="xs"
      variant="ghost"
    >
      {children}
    </Button>
  );
}

/** Stroke, fill, width, dash and sketch controls for the selection and for new elements. */
export function BoardStylePanel({
  style,
  onChange,
}: {
  readonly style: ElementStyle;
  readonly onChange: (patch: Partial<ElementStyle>) => void;
}) {
  return (
    <div
      className="surface-glass pointer-events-auto flex w-44 flex-col gap-3 rounded-lg border border-border/60 p-3 shadow-sm"
      data-testid="board-style-panel"
    >
      <Row label="Stroke">
        {INKS.map(({ token, label }) => (
          <Choice
            key={token}
            pressed={style.stroke === token}
            label={label}
            onClick={() => onChange({ stroke: token })}
          >
            <span
              aria-hidden
              className={cn("block size-3.5 rounded-full ring-1 ring-border")}
              style={{ backgroundColor: `var(--ink-${token})` }}
            />
          </Choice>
        ))}
      </Row>
      <Row label="Fill">
        {FILLS.map(({ value, label }) => (
          <Choice
            key={value}
            pressed={style.fill === value}
            label={label}
            onClick={() => onChange({ fill: value })}
          >
            <span
              aria-hidden
              className={cn(
                "block size-3.5 rounded-sm ring-1 ring-border",
                value === "none" && "bg-transparent",
                value === "soft" && "opacity-40",
              )}
              style={
                value === "none" ? undefined : { backgroundColor: `var(--ink-${style.stroke})` }
              }
            />
          </Choice>
        ))}
      </Row>
      <Row label="Width">
        {WIDTHS.map(({ value, label }) => (
          <Choice
            key={value}
            pressed={style.strokeWidth === value}
            label={label}
            onClick={() => onChange({ strokeWidth: value })}
          >
            <span
              aria-hidden
              className="block w-4 rounded-full bg-current"
              style={{ height: value }}
            />
          </Choice>
        ))}
      </Row>
      <Row label="Line">
        {STROKES.map(({ value, label }) => (
          <Choice
            key={value}
            pressed={style.strokeStyle === value}
            label={label}
            onClick={() => onChange({ strokeStyle: value })}
          >
            <span
              aria-hidden
              className={cn(
                "block w-4 border-t-2 border-current",
                value === "dashed" && "border-dashed",
                value === "dotted" && "border-dotted",
              )}
            />
          </Choice>
        ))}
      </Row>
      <Row label="Style">
        <Choice
          pressed={style.roughness > 0}
          label="Sketch"
          onClick={() => onChange({ roughness: 1 })}
        >
          Sketch
        </Choice>
        <Choice
          pressed={style.roughness === 0}
          label="Clean"
          onClick={() => onChange({ roughness: 0 })}
        >
          Clean
        </Choice>
      </Row>
    </div>
  );
}
