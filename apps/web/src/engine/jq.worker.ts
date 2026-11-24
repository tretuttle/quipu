// One jq run in a worker of its own, so the coordinator can stop it at a time
// budget: a program such as `[range(1e12)] | length` never returns by itself.
import { decodeUtf8 } from "@quipu/core/boundedSlice";
import { raw } from "jq-wasm";

import { cleanJqMessage } from "./jqMessage.ts";

export interface JqRunRequest {
  readonly input: ArrayBuffer;
  readonly program: string;
  readonly outputLimit: number;
}

export interface JqRunReply {
  readonly status: "ok" | "error";
  readonly output: string;
  readonly truncated: boolean;
  readonly message: string;
}

self.addEventListener("message", (event: MessageEvent<JqRunRequest>) => {
  void (async () => {
    const { input, program, outputLimit } = event.data;
    let reply: JqRunReply;
    try {
      const text = decodeUtf8(new Uint8Array(input));
      const result = await raw(text, program);
      if (result.exitCode !== 0) {
        reply = {
          status: "error",
          output: "",
          truncated: false,
          message:
            cleanJqMessage(result.stderr.trim()) || `jq stopped with exit code ${result.exitCode}.`,
        };
      } else {
        const truncated = result.stdout.length > outputLimit;
        reply = {
          status: "ok",
          output: truncated ? result.stdout.slice(0, outputLimit) : result.stdout,
          truncated,
          message: "",
        };
      }
    } catch (error) {
      reply = {
        status: "error",
        output: "",
        truncated: false,
        message: error instanceof Error ? error.message : "jq could not run this filter.",
      };
    }
    self.postMessage(reply, { transfer: [] });
  })();
});
