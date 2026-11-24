// @effect-diagnostics nodeBuiltinImport:off - reads the sample document the flows paste.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/** An invented weather station's status, with a JWT and a JSON string to decode. */
export const SAMPLE_DOCUMENT = NodeFS.readFileSync(
  NodePath.join(import.meta.dirname, "..", "fixtures", "weather-station.json"),
  "utf8",
);
