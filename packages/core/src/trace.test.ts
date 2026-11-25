import { afterAll, describe, expect, it } from "@effect/vitest";

import { EngineHost } from "./document.ts";
import { createLocalPool } from "./localPool.ts";
import { buildSampleHarBytes } from "./testing/smallHarFixture.ts";

const utf8 = new TextEncoder();
const platform = { workers: 4, crossOriginIsolated: true, createPool: createLocalPool };

const toBase64 = (s: string) => {
  let raw = "";
  for (const b of utf8.encode(s)) raw += String.fromCharCode(b);
  return btoa(raw);
};

describe("exact value trace", () => {
  const sampleHar = {
    log: {
      version: "1.2",
      entries: [
        {
          request: {
            method: "GET",
            url: "https://api.example.com/check?token=sess_Q7mX4zR9kP2vLw8NbT3cYh6D_longer",
            headers: [
              { name: "Authorization", value: "sess_Q7mX4zR9kP2vLw8NbT3cYh6D" },
              { name: "X-Prefix", value: "prefix_sess_Q7mX4zR9kP2vLw8NbT3cYh6D" },
            ],
            queryString: [{ name: "sid", value: "sess_Q7mX4zR9kP2vLw8NbT3cYh6D" }],
          },
          response: {
            status: 200,
            headers: [],
            content: {
              size: 80,
              mimeType: "application/json",
              text: JSON.stringify({ session: { token: "sess_Q7mX4zR9kP2vLw8NbT3cYh6D" } }),
            },
          },
        },
        {
          request: {
            method: "POST",
            url: "https://api.example.com/submit",
            headers: [{ name: "X-Session", value: "sess_Q7mX4zR9kP2vLw8NbT3cYh6D" }],
            postData: {
              mimeType: "application/json",
              text: JSON.stringify({ nested: { sid: "sess_Q7mX4zR9kP2vLw8NbT3cYh6D_sub" } }),
            },
          },
          response: {
            status: 204,
            headers: [],
            content: {
              size: -1,
              mimeType: "application/json",
              text: toBase64(
                JSON.stringify({
                  deepToken: "sess_Q7mX4zR9kP2vLw8NbT3cYh6D",
                }),
              ),
              encoding: "base64",
            },
          },
        },
      ],
    },
  };

  it("matches exact whole values only, groups HAR sections, includes decoded payloads, and stays consistent after edits", async () => {
    const bytes = utf8.encode(JSON.stringify(sampleHar));
    const host = new EngineHost(platform, { regionBytes: 128 * 1024 });
    const opened = await host.handle({
      _tag: "open",
      source: new Blob([bytes]),
      name: "trace-sample.har",
    });

    try {
      const result = await host.traceValue(opened.documentId, {
        value: "sess_Q7mX4zR9kP2vLw8NbT3cYh6D",
      });
      // Exact occurrences:
      // Entry 0: request.headers[0].value, request.queryString[0].value, response.content/session/token (3)
      // Entry 1: request.headers[0].value, response.content/deepToken (base64->json) (2)
      // Substrings in entry 0 url, X-Prefix, and entry 1 postData (_sub) MUST be rejected!
      expect(result.isHar).toBe(true);
      expect(result.total).toBe(5);
      expect(result.harGroups).toHaveLength(2);
      expect(result.harGroups[0]?.occurrences.map((o) => o.section)).toEqual([
        "request.headers",
        "request.queryString",
        "response.content",
      ]);
      expect(result.harGroups[1]?.occurrences.map((o) => o.section)).toEqual([
        "request.headers",
        "response.content",
      ]);
      expect(result.harGroups[1]?.occurrences[1]?.decodeChain).toEqual(["base64", "json"]);

      // Substring query must NOT match longer strings.
      const subResult = await host.traceValue(opened.documentId, {
        value: "sess_Q7mX4zR9kP2vLw8NbT3",
      });
      expect(subResult.total).toBe(0);

      // Edit one occurrence and verify count drops from 5 to 4.
      const targetRef = result.occurrences[0]?.ref;
      expect(targetRef).not.toBeNull();
      await host.handle({
        _tag: "setValue",
        ref: targetRef!,
        json: JSON.stringify("sess_edited_value"),
      });

      const afterEdit = await host.traceValue(opened.documentId, {
        value: "sess_Q7mX4zR9kP2vLw8NbT3cYh6D",
      });
      expect(afterEdit.total).toBe(4);
    } finally {
      await host.handle({ _tag: "close", documentId: opened.documentId }).catch(() => null);
    }
  });

  it("traces generic JSON by JSON Pointer", async () => {
    const doc = utf8.encode(
      JSON.stringify({
        users: [{ id: "usr_exact_1" }, { id: "usr_exact_1_extra" }],
        meta: { payload: toBase64(JSON.stringify({ owner: "usr_exact_1" })) },
      }),
    );
    const host = new EngineHost(platform);
    const opened = await host.handle({
      _tag: "open",
      source: new Blob([doc]),
      name: "generic.json",
    });
    try {
      const res = await host.traceValue(opened.documentId, { value: "usr_exact_1" });
      expect(res.isHar).toBe(false);
      expect(res.total).toBe(2);
      expect(res.occurrences.map((o) => o.pointer)).toEqual(["/users/0/id", "/meta/payload/owner"]);
      expect(res.occurrences[1]?.decodeChain).toEqual(["base64", "json"]);
    } finally {
      await host.handle({ _tag: "close", documentId: opened.documentId }).catch(() => null);
    }
  });
});

describe("exact value trace on sample 147-entry HAR", () => {
  const bytes = buildSampleHarBytes();
  const host = new EngineHost(platform, { regionBytes: 256 * 1024 });
  const opened = host.handle({ _tag: "open", source: new Blob([bytes]), name: "small.har" });

  afterAll(async () => {
    await host.handle({ _tag: "close", documentId: (await opened).documentId }).catch(() => null);
  });

  it("traces sess_Q7mX4zR9kP2vLw8NbT3cYh6D to 4 occurrences and drops to 3 after edit", async () => {
    const { documentId } = await opened;

    const initial = await host.traceValue(documentId, {
      value: "sess_Q7mX4zR9kP2vLw8NbT3cYh6D",
    });
    expect(initial.total).toBe(4);
    expect(initial.harGroups.map((g) => g.entryIndex)).toEqual([3, 10, 57, 146]);

    // Edit entry 10's header value
    const entry10Occ = initial.harGroups[1]?.occurrences[0];
    expect(entry10Occ?.ref).not.toBeNull();
    await host.handle({
      _tag: "setValue",
      ref: entry10Occ!.ref!,
      json: JSON.stringify("sess_replaced"),
    });

    const afterEdit = await host.traceValue(documentId, {
      value: "sess_Q7mX4zR9kP2vLw8NbT3cYh6D",
    });
    expect(afterEdit.total).toBe(3);
    expect(afterEdit.harGroups.map((g) => g.entryIndex)).toEqual([3, 57, 146]);
  });

  it("traces decoded usr_8c41f0a9d2e7 to 2 occurrences matching canaries.json", async () => {
    const { documentId } = await opened;

    const res = await host.traceValue(documentId, { value: "usr_8c41f0a9d2e7" });
    expect(res.total).toBe(2);
    expect(res.harGroups.map((g) => g.entryIndex)).toEqual([21, 34]);
    expect(res.occurrences[0]?.decodeChain).toEqual([
      "base64",
      "json-string",
      "json-string",
      "json",
    ]);
    expect(res.occurrences[0]?.pointer).toBe("/response/content/text/user/id");
    expect(res.occurrences[1]?.pointer).toBe("/request/postData/text/variables/userId");
  });
});
