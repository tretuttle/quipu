import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  ElementMapItemError,
  ElementMapProgress,
  ElementMapSummary,
  formatJqTooLargeMessage,
  JqElementRequest,
  JqElementResult,
  JqSuggestedPath,
} from "./elementMap.ts";

const decodeItemError = Schema.decodeSync(ElementMapItemError);
const encodeItemError = Schema.encodeSync(ElementMapItemError);
const decodeProgress = Schema.decodeSync(ElementMapProgress);
const encodeProgress = Schema.encodeSync(ElementMapProgress);
const decodeSummary = Schema.decodeSync(ElementMapSummary);
const encodeSummary = Schema.encodeSync(ElementMapSummary);
const decodeSuggested = Schema.decodeSync(JqSuggestedPath);
const encodeSuggested = Schema.encodeSync(JqSuggestedPath);
const decodeReq = Schema.decodeSync(JqElementRequest);
const encodeReq = Schema.encodeSync(JqElementRequest);
const decodeRes = Schema.decodeSync(JqElementResult);
const encodeRes = Schema.encodeSync(JqElementResult);

describe("elementMap contracts", () => {
  it("round-trips elementMap progress, errors, and jqElement messages", () => {
    const itemError = { index: 3, key: null, bytes: 70_000_000, message: "exceeds 64 MiB" };
    expect(decodeItemError(encodeItemError(itemError))).toEqual(itemError);

    const progress = { processed: 10, total: 100, errors: 1, bytesRead: 1024 };
    expect(decodeProgress(encodeProgress(progress))).toEqual(progress);

    const summary = { total: 100, processed: 99, errors: 1, cancelled: false };
    expect(decodeSummary(encodeSummary(summary))).toEqual(summary);

    const suggested = { path: ".log.entries", count: 40_398, bytes: 1_900_000_000 };
    expect(decodeSuggested(encodeSuggested(suggested))).toEqual(suggested);

    const req = {
      _tag: "jqElement" as const,
      ref: { documentId: 1, tapeId: 0, token: 0 },
      path: ".log.entries",
      program: ".request.url",
      timeoutMs: 5000,
      concurrency: 4,
    };
    expect(decodeReq(encodeReq(req))).toEqual(req);

    const res = {
      status: "partial" as const,
      output: '"https://example.com"\n',
      truncated: false,
      message: "1 element exceeded 64 MiB",
      path: ".log.entries",
      processed: 1,
      total: 2,
      errors: [itemError],
      inputBytes: 1024,
    };
    expect(decodeRes(encodeRes(res))).toEqual(res);
  });

  it("formats refusal messages with and without a suggested element path", () => {
    expect(formatJqTooLargeMessage(100 * 1024 * 1024, 64 * 1024 * 1024, ".log.entries")).toContain(
      "Run per element of .log.entries",
    );
    expect(formatJqTooLargeMessage(100 * 1024 * 1024, 64 * 1024 * 1024, null)).toContain(
      "Select a smaller node",
    );
  });
});
