import { DecoderKind } from "@quipu/contracts/engine";
import * as Schema from "effect/Schema";
import { create } from "zustand";

import { resolveStorage } from "../lib/storage";
import type { AutoDecode } from "./treeModel.ts";

const STORAGE_KEY = "quipu:auto-decode";
const Stored = Schema.Struct({
  enabled: Schema.Boolean,
  kinds: Schema.NullOr(Schema.Array(DecoderKind)),
});
const decodeStored = Schema.decodeUnknownExit(Schema.fromJsonString(Stored));
const OFF: AutoDecode = { enabled: false, kinds: null };

const storage = () => resolveStorage(typeof window === "undefined" ? null : window.localStorage);

function readStored(): AutoDecode {
  try {
    const decoded = decodeStored(storage().getItem(STORAGE_KEY));
    return decoded._tag === "Success" ? decoded.value : OFF;
  } catch {
    return OFF;
  }
}

interface DecodePreferences {
  readonly auto: AutoDecode;
  readonly setAuto: (auto: AutoDecode) => void;
}

/**
 * Whether detected values decode on their own as the user browses, for every
 * decoder kind or the kinds chosen. Off by default: decoding is per value, and
 * this is a layer on top that never overrides a value opened or closed by hand.
 * It persists in localStorage like the document view.
 */
export const useDecodePreferences = create<DecodePreferences>((set) => ({
  auto: readStored(),
  setAuto: (auto) => {
    try {
      storage().setItem(STORAGE_KEY, JSON.stringify(auto));
    } catch {
      // Blocked storage still changes the setting for this session.
    }
    set({ auto });
  },
}));

/** What each decoder kind is called where the user picks the kinds to decode automatically. */
export const DECODER_KIND_LABELS: Readonly<Record<DecoderKind, string>> = {
  json: "JSON",
  jwt: "JWT",
  base64: "Base64",
  form: "Form",
  graphql: "GraphQL",
  ndjson: "NDJSON",
  svg: "SVG",
};

/** The kinds automatic decoding can cover; none chosen means every one. */
export const DECODER_KINDS: ReadonlyArray<DecoderKind> = DecoderKind.literals;
