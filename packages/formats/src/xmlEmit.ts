/**
 * JSON tokens to XML, as bytes. The mapping is the one `xmlToJson.ts` reads back:
 * the document is an object with exactly one member, the root element; a member
 * whose key starts with `@` is an attribute (a scalar, written before any content);
 * `#text` is the element's text; any other member is a child element, an array
 * repeats it, and a scalar is its text. XML has no null, no empty array and no
 * array in an array, and a name has to be an XML name: each is an error naming the
 * node. Text is escaped as written; a string of only white space is written as
 * character references so a reader that drops indentation keeps it.
 */
import { COLON } from "@quipu/core/bytes";
import { unescapeBytes } from "@quipu/core/decode";

import { OffendingNode } from "./abort.ts";
import type { ByteWriter } from "./byteWriter.ts";
import { wellFormUtf8 } from "./csvEmit.ts";
import {
  type JsonHandler,
  KIND_ARRAY,
  KIND_NULL,
  KIND_OBJECT,
  type ScanState,
} from "./jsonScan.ts";

const AT = 0x40;
const HASH = 0x23;
const LT = 0x3c;
const GT = 0x3e;
const AMP = 0x26;
const QUOTE = 0x22;
const SLASH = 0x2f;

const NAME_START = new Uint8Array(256);
const NAME_CHAR = new Uint8Array(256);
for (let c = 0x41; c <= 0x5a; c++) NAME_START[c] = NAME_CHAR[c] = 1;
for (let c = 0x61; c <= 0x7a; c++) NAME_START[c] = NAME_CHAR[c] = 1;
NAME_START[0x5f] = NAME_CHAR[0x5f] = 1;
NAME_START[COLON] = NAME_CHAR[COLON] = 1;
for (let c = 0x80; c <= 0xff; c++) NAME_START[c] = NAME_CHAR[c] = 1;
for (let c = 0x30; c <= 0x39; c++) NAME_CHAR[c] = 1;
NAME_CHAR[0x2d] = 1;
NAME_CHAR[0x2e] = 1;

interface Frame {
  readonly kind: number;
  /** The element name this container is written as (object: its element; array: each item's element). */
  readonly name: Uint8Array | undefined;
  /** An object that is the document (no element of its own). */
  readonly isDocument: boolean;
  /** Where the container opened, so an error about it points at a token. */
  readonly openPos: number;
  /** An element whose start tag is still open for attributes. */
  tagOpen: boolean;
  hasChild: boolean;
  hasText: boolean;
  members: number;
  /** An array that is the document's one member: its items would be several roots. */
  readonly rootArray?: boolean;
}

export class XmlHandler implements JsonHandler {
  private readonly out: ByteWriter;
  private readonly st: ScanState;
  private readonly frames: Frame[] = [];
  private pendingKey: Uint8Array | undefined;
  private scratch = new Uint8Array(256);

  constructor(out: ByteWriter, st: ScanState) {
    this.out = out;
    this.st = st;
  }

  private unescape(bytes: Uint8Array, start: number, end: number): Uint8Array {
    const inner = end - start - 2;
    if (this.scratch.length < inner) this.scratch = new Uint8Array(inner * 2);
    const n = unescapeBytes(bytes, start + 1, end - 1, this.scratch, 0);
    wellFormUtf8(this.scratch, n);
    return this.scratch.subarray(0, n);
  }

  private checkName(name: Uint8Array, at: number) {
    let ok = name.length > 0 && NAME_START[name[0] as number] === 1;
    for (let i = 1; ok && i < name.length; i++) ok = NAME_CHAR[name[i] as number] === 1;
    if (!ok) throw new OffendingNode(at, "invalid-name", "a key that is not an XML name");
    // The prefix xml is reserved for the XML namespace, and a name cannot begin with it as a word.
  }

  private text(bytes: Uint8Array, attribute: boolean, at: number) {
    const out = this.out;
    let allSpace = bytes.length > 0;
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i] as number;
      if (b !== 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) {
        allSpace = false;
        break;
      }
    }
    let run = 0;
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i] as number;
      let ref: string | undefined;
      if (b === AMP) ref = "&amp;";
      else if (b === LT) ref = "&lt;";
      else if (b === GT) ref = "&gt;";
      else if (attribute && b === QUOTE) ref = "&quot;";
      else if (b < 0x20) {
        if (b !== 0x09 && b !== 0x0a && b !== 0x0d) {
          throw new OffendingNode(at, "invalid-input", "a control character XML 1.0 cannot hold");
        }
        // A carriage return is normalized to a line feed by every XML reader unless it is a reference.
        if (attribute || allSpace || b === 0x0d) ref = `&#${b};`;
      } else if (allSpace && b === 0x20) ref = "&#32;";
      if (ref !== undefined) {
        out.bytes(bytes, run, i);
        out.ascii(ref);
        run = i + 1;
      }
    }
    out.bytes(bytes, run, bytes.length);
  }

  private closeTag(frame: Frame) {
    if (frame.tagOpen) {
      this.out.byte(GT);
      frame.tagOpen = false;
    }
  }

  private top() {
    return this.frames[this.frames.length - 1];
  }

  /** A scalar value arrived in the current container. */
  private emitScalar(
    bytes: Uint8Array,
    start: number,
    end: number,
    kind: number,
    isString: boolean,
  ) {
    const out = this.out;
    const parent = this.top();
    if (!parent) {
      throw new OffendingNode(start, "no-root-element", "the document is not an object");
    }
    if (kind === KIND_NULL) {
      throw new OffendingNode(start, "null-value", "XML has no null");
    }
    const key = this.pendingKey;
    this.pendingKey = undefined;
    const content = isString ? this.unescape(bytes, start, end) : bytes.subarray(start, end);
    if (parent.kind === KIND_OBJECT) {
      if (!key) throw new OffendingNode(start, "invalid-input", "a value with no key");
      if (parent.isDocument && (key[0] === AT || key[0] === HASH)) {
        throw new OffendingNode(
          start,
          "no-root-element",
          "an attribute or text where the root element belongs",
        );
      }
      if (key[0] === AT) {
        if (!parent.tagOpen) {
          throw new OffendingNode(
            start,
            "attribute-after-content",
            "an attribute after the element's content",
          );
        }
        const name = key.subarray(1);
        this.checkName(name, start);
        out.byte(0x20);
        out.bytes(name, 0, name.length);
        out.byte(0x3d);
        out.byte(QUOTE);
        this.text(content, true, start);
        out.byte(QUOTE);
        return;
      }
      if (
        key.length === 5 &&
        key[0] === HASH &&
        key[1] === 0x74 &&
        key[2] === 0x65 &&
        key[3] === 0x78 &&
        key[4] === 0x74
      ) {
        if (parent.hasChild) {
          throw new OffendingNode(start, "mixed-content", "text beside child elements");
        }
        this.closeTag(parent);
        parent.hasText = true;
        this.text(content, false, start);
        return;
      }
      if (parent.hasText)
        throw new OffendingNode(start, "mixed-content", "child elements beside text");
      if (!parent.isDocument) {
        this.closeTag(parent);
        parent.hasChild = true;
      }
      this.element(key, content, start);
      return;
    }
    // Array item: an element named by the array's key.
    if (parent.rootArray && parent.members > 1) {
      throw new OffendingNode(start, "multiple-roots", "a second root element");
    }
    if (!parent.name) throw new OffendingNode(start, "no-root-element", "an array at the root");
    this.element(parent.name, content, start);
  }

  private element(name: Uint8Array, content: Uint8Array, at: number) {
    this.checkName(name, at);
    const out = this.out;
    out.byte(LT);
    out.bytes(name, 0, name.length);
    if (content.length === 0) {
      out.byte(SLASH);
      out.byte(GT);
      return;
    }
    out.byte(GT);
    this.text(content, false, at);
    out.byte(LT);
    out.byte(SLASH);
    out.bytes(name, 0, name.length);
    out.byte(GT);
  }

  open(kind: number, pos: number) {
    const parent = this.top();
    if (!parent) {
      if (kind !== KIND_OBJECT)
        throw new OffendingNode(pos, "no-root-element", "the document is not an object");
      this.out.ascii('<?xml version="1.0" encoding="UTF-8"?>');
      this.frames.push({
        kind,
        name: undefined,
        isDocument: true,
        openPos: pos,
        tagOpen: false,
        hasChild: false,
        hasText: false,
        members: 0,
      });
      return;
    }
    const key = this.pendingKey;
    this.pendingKey = undefined;
    if (parent.kind === KIND_OBJECT) {
      if (!key) throw new OffendingNode(pos, "invalid-input", "a value with no key");
      if (key[0] === AT || (key.length === 5 && key[0] === HASH)) {
        throw new OffendingNode(
          pos,
          "nested-value",
          "an attribute or text that holds an object or array",
        );
      }
      if (parent.hasText)
        throw new OffendingNode(pos, "mixed-content", "child elements beside text");
      this.checkName(key, pos);
      if (!parent.isDocument) {
        this.closeTag(parent);
        parent.hasChild = true;
      }
      if (kind === KIND_ARRAY) {
        this.frames.push({
          kind,
          name: key,
          isDocument: false,
          openPos: pos,
          tagOpen: false,
          hasChild: false,
          hasText: false,
          members: 0,
          rootArray: parent.isDocument,
        });
        return;
      }
      this.out.byte(LT);
      this.out.bytes(key, 0, key.length);
      this.frames.push({
        kind,
        name: key,
        isDocument: false,
        openPos: pos,
        tagOpen: true,
        hasChild: false,
        hasText: false,
        members: 0,
      });
      return;
    }
    // In an array: an item.
    parent.members++;
    if (parent.rootArray && parent.members > 1) {
      throw new OffendingNode(pos, "multiple-roots", "a second root element");
    }
    if (kind === KIND_ARRAY)
      throw new OffendingNode(pos, "array-in-array", "an array directly inside an array");
    const name = parent.name as Uint8Array;
    this.out.byte(LT);
    this.out.bytes(name, 0, name.length);
    this.frames.push({
      kind,
      name,
      isDocument: false,
      openPos: pos,
      tagOpen: true,
      hasChild: false,
      hasText: false,
      members: 0,
    });
  }

  close(kind: number, _pos: number) {
    const frame = this.frames.pop();
    if (!frame) return;
    if (frame.isDocument) {
      if (frame.members === 0)
        throw new OffendingNode(
          frame.openPos,
          "no-root-element",
          "an empty object has no root element",
        );
      return;
    }
    if (kind === KIND_ARRAY) {
      if (frame.members === 0)
        throw new OffendingNode(
          frame.openPos,
          "empty-array",
          "XML cannot say a key has no elements",
        );
      return;
    }
    const out = this.out;
    const name = frame.name as Uint8Array;
    if (frame.tagOpen) {
      out.byte(SLASH);
      out.byte(GT);
    } else {
      out.byte(LT);
      out.byte(SLASH);
      out.bytes(name, 0, name.length);
      out.byte(GT);
    }
  }

  key(bytes: Uint8Array, start: number, end: number) {
    const parent = this.top();
    if (parent?.isDocument) {
      if (parent.members > 0) {
        throw new OffendingNode(
          start,
          "multiple-roots",
          "a second member: XML has one root element",
        );
      }
    }
    if (parent) parent.members++;
    this.pendingKey = this.unescape(bytes, start, end).slice();
  }

  string(bytes: Uint8Array, start: number, end: number) {
    this.countItem();
    this.emitScalar(bytes, start, end, 3, true);
  }

  scalar(bytes: Uint8Array, start: number, end: number, kind: number) {
    this.countItem();
    this.emitScalar(bytes, start, end, kind, false);
  }

  private countItem() {
    const parent = this.top();
    if (parent && parent.kind === KIND_ARRAY) parent.members++;
  }
}
