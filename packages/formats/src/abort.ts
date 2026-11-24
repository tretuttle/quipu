import type { UnrepresentableReason } from "./errors.ts";

/**
 * Thrown by an emitter at the first node the target cannot hold. Workers know a
 * byte offset, not a path (a region starts mid-document), so the driver turns
 * the offset into a JSON Pointer with `locatePointer` before surfacing an
 * `UnrepresentableError`.
 */
export class OffendingNode extends Error {
  readonly offset: number;
  readonly reason: UnrepresentableReason;
  readonly detail: string;

  constructor(offset: number, reason: UnrepresentableReason, detail: string) {
    super(detail);
    this.name = "OffendingNode";
    this.offset = offset;
    this.reason = reason;
    this.detail = detail;
  }
}
