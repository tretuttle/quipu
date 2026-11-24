/**
 * What the recorder writes next to its frames, and the only input the renderer
 * reads. Times are milliseconds since the recording started. Boxes and points
 * are CSS pixels in the recorded page's viewport.
 */
import * as Schema from "effect/Schema";

const Box = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
  width: Schema.Finite,
  height: Schema.Finite,
});
export type Box = typeof Box.Type;

const Move = Schema.Struct({
  kind: Schema.Literal("move"),
  t: Schema.Finite,
  x: Schema.Finite,
  y: Schema.Finite,
});

const Down = Schema.Struct({
  kind: Schema.Literal("down"),
  t: Schema.Finite,
  x: Schema.Finite,
  y: Schema.Finite,
  target: Schema.NullOr(Box),
});

const Up = Schema.Struct({
  kind: Schema.Literal("up"),
  t: Schema.Finite,
  x: Schema.Finite,
  y: Schema.Finite,
});

const Key = Schema.Struct({
  kind: Schema.Literal("key"),
  t: Schema.Finite,
  key: Schema.String,
  /** The focused element's box when the key was pressed, if there was one. */
  target: Schema.NullOr(Box),
});

export const DemoEvent = Schema.Union([Move, Down, Up, Key]);
export type DemoEvent = typeof DemoEvent.Type;

export const EventLog = Schema.Struct({
  version: Schema.Literal(1),
  flow: Schema.String,
  viewport: Schema.Struct({
    width: Schema.Finite,
    height: Schema.Finite,
    deviceScaleFactor: Schema.Finite,
  }),
  durationMs: Schema.Finite,
  /** Frame files, relative to the recording directory, in time order. */
  frames: Schema.Array(Schema.Struct({ t: Schema.Finite, file: Schema.String })),
  events: Schema.Array(DemoEvent),
});
export type EventLog = typeof EventLog.Type;

const EventLogJson = Schema.fromJsonString(EventLog);
export const encodeEventLog = Schema.encodeSync(EventLogJson);
export const decodeEventLog = Schema.decodeUnknownSync(EventLogJson);
