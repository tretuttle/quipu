/**
 * The XML scanner: elements, attributes and text onto the engine's tape.
 *
 * Mapping. The tape's root is the document, an object with one member: the root
 * element, keyed by the `<` of its start tag. An element is an object whose
 * members, in document order, are its attributes (a string token over the quoted
 * value, keyed by the attribute name's bytes), its child elements (keyed by their
 * `<`), and its text (a string token keyed by TEXT_KEY). Entities are not
 * decoded and CDATA is not unwrapped: a text token is the raw bytes, and
 * `xmlDecode.ts` resolves them when the value is shown. Comments, processing
 * instructions, the declaration and the doctype are not on the tape.
 *
 * Regions. A markup construct (a tag, a comment, a CDATA section) belongs to the
 * region its `<` is in and is read whole from the overhang, so a region boundary
 * only ever cuts text, or a comment/CDATA/PI whose end is farther than the
 * window. That keeps the entry state to a handful of numbers. Entry states are
 * chained region to region by a lexical-only pass (`advanceXml`), then regions
 * are structured in parallel.
 */
import type { TapeBuilder } from "@quipu/core/tape";
import { KIND_OBJECT, KIND_STRING } from "@quipu/core/tape";

/** `keyStart` of a text token (and of a CDATA token). */
export const TEXT_KEY = 0xfffffffd;

const LT = 0x3c;
const GT = 0x3e;
const SLASH = 0x2f;
const BANG = 0x21;
const QMARK = 0x3f;
const DASH = 0x2d;
const EQ = 0x3d;
const DQ = 0x22;
const SQ = 0x27;
const LBRACKET = 0x5b;
const RBRACKET = 0x5d;

export const XML_TEXT = 0;
export const XML_COMMENT = 1;
export const XML_CDATA = 2;
export const XML_PI = 3;

export interface XmlEntry {
  /** What the region starts inside: text, or a comment/CDATA/PI whose end is farther on. */
  readonly mode: number;
  /** Bytes of that construct's end marker already matched at the end of the previous region. */
  readonly progress: number;
  /** Where the construct began (CDATA tokens start there), or -1. */
  readonly constructStart: number;
  /** Bytes at the start of the region that belong to a construct the previous owner finished. */
  readonly skip: number;
  /** Open elements. */
  readonly depth: number;
  /** Absolute offset where the current text node began, or -1 outside text. */
  readonly textStart: number;
  /** A non-whitespace byte has been seen in the current text node. */
  readonly textNonWs: boolean;
}

export const XML_INITIAL_ENTRY: XmlEntry = {
  mode: XML_TEXT,
  progress: 0,
  constructStart: -1,
  skip: 0,
  depth: 0,
  textStart: 0,
  textNonWs: false,
};

export interface XmlStructure {
  /** Elements that were open at region entry and closed here, as triples [token count at that moment, level, absolute end]. */
  readonly closes: number[];
  /** Children counted but not put on the tape for the container that was open at entry at the cut level. */
  readonly cutInherited: number;
  /** Anchors for containers at the cut level: [local token or -1, child ordinal within region, absolute offset]. */
  readonly anchors: number[];
  readonly exit: XmlEntry;
  /** A construct runs past the window; read more bytes and run again. */
  readonly needMore: boolean;
  /** Elements started in this region at any level (for the budget projection). */
  readonly elements: number;
}

const WS = new Uint8Array(256);
WS[0x20] = WS[0x09] = WS[0x0a] = WS[0x0d] = 1;

const isDelimiter = (b: number) => WS[b] === 1 || b === GT || b === SLASH || b === EQ;

const startsWith = (b: Uint8Array, at: number, ascii: string) => {
  if (at + ascii.length > b.length) return false;
  for (let i = 0; i < ascii.length; i++) if (b[at + i] !== ascii.charCodeAt(i)) return false;
  return true;
};

const COMMENT_END = [DASH, DASH, GT];
const CDATA_END = [RBRACKET, RBRACKET, GT];
const PI_END = [QMARK, GT];

const markerFor = (mode: number) =>
  mode === XML_COMMENT ? COMMENT_END : mode === XML_CDATA ? CDATA_END : PI_END;

/**
 * Index just past the end marker of a construct, searching from `from` with
 * `progress` marker bytes already matched before it; -1 if not in `bytes`.
 */
const findEnd = (
  bytes: Uint8Array,
  from: number,
  marker: readonly number[],
  progress: number,
): number => {
  const n = bytes.length;
  // The marker may complete inside the first bytes using what was matched before.
  if (progress > 0) {
    const need = marker.length - progress;
    let ok = from + need <= n;
    for (let k = 0; ok && k < need; k++) if (bytes[from + k] !== marker[progress + k]) ok = false;
    if (ok) return from + need;
  }
  const last = marker[marker.length - 1] as number;
  let at = bytes.indexOf(last, from);
  while (at >= 0) {
    const start = at - (marker.length - 1);
    if (start >= from) {
      let ok = true;
      for (let k = 0; k < marker.length - 1; k++) if (bytes[start + k] !== marker[k]) ok = false;
      if (ok) return at + 1;
    }
    at = bytes.indexOf(last, at + 1);
  }
  return -1;
};

/** The longest proper prefix of `marker` that `bytes` ends with, looking at most at `upTo`. */
const trailingProgress = (bytes: Uint8Array, upTo: number, marker: readonly number[]): number => {
  for (let len = marker.length - 1; len >= 1; len--) {
    if (upTo - len < 0) continue;
    let ok = true;
    for (let k = 0; k < len; k++) if (bytes[upTo - len + k] !== marker[k]) ok = false;
    if (ok) return len;
  }
  return 0;
};

/**
 * Scans (and with `builder`, structures) the markup that starts in
 * `[regionStart, regionEnd)`. `window` begins at absolute `base` ≤ regionStart.
 * Pass 1 passes no builder and only advances the entry state; pass 2 emits.
 * `maxLevel` is the deepest level that goes on the tape (document = 0).
 */
export const scanXml = (
  window: Uint8Array,
  base: number,
  regionEnd: number,
  fileSize: number,
  entry: XmlEntry,
  builder: TapeBuilder | null,
  maxLevel: number,
): XmlStructure => {
  const n = window.length;
  const eof = base + n >= fileSize;
  const limit = Math.min(n, regionEnd - base);
  const closes: number[] = [];
  const anchors: number[] = [];
  let cutInherited = 0;
  let elements = 0;
  let depth = entry.depth;
  const entryDepth = entry.depth;
  /** Levels above this were opened in this region; at or below were open at entry. */
  let floor = entry.depth;
  // Token index of the open element at each level, -1 when inherited or not on the tape.
  let localAt = new Int32Array(Math.max(16, depth + 16)).fill(-1);
  // Children counted but not emitted, per level (local containers only).
  let cutCount = new Uint32Array(0);
  void cutCount;
  let mode = entry.mode;
  let progress = entry.progress;
  let constructStart = entry.constructStart;
  let textStart = entry.textStart;
  let textNonWs = entry.textNonWs;
  let i = Math.max(0, entry.skip);
  const base0 = base;

  const emitting = builder !== null;
  const grow = (level: number) => {
    if (level < localAt.length) return;
    const next = new Int32Array(Math.max(level + 16, localAt.length * 2)).fill(-1);
    next.set(localAt);
    localAt = next;
  };

  /** A child was not put on the tape: count it for the container at the cut level. */
  const countCut = (offset: number) => {
    if (depth !== maxLevel) return;
    const holder = localAt[depth] as number;
    if (holder >= 0 && builder)
      builder.childCounts[holder] = (builder.childCounts[holder] as number) + 1;
    else cutInherited++;
    void offset;
  };

  const emitText = (start: number, end: number) => {
    if (depth === 0) return;
    const level = depth + 1;
    if (level <= maxLevel) {
      if (builder) {
        const t = builder.push(KIND_STRING, start, level, TEXT_KEY);
        builder.ends[t] = end;
      }
    } else countCut(start);
  };

  const endTextNode = (at: number) => {
    if (textStart >= 0 && textNonWs) emitText(textStart, base0 + at);
    textStart = -1;
    textNonWs = false;
  };

  // A construct the previous region's owner finished is skipped; a comment, CDATA
  // section or PI that was still open at the boundary continues until its marker.
  if (mode !== XML_TEXT) {
    const marker = markerFor(mode);
    const end = findEnd(window, i, marker, progress);
    if (end < 0 && !eof) {
      return {
        closes,
        cutInherited,
        anchors,
        needMore: false,
        elements,
        exit: {
          mode,
          progress: trailingProgress(window, limit, marker),
          constructStart,
          skip: 0,
          depth,
          textStart: -1,
          textNonWs: false,
        },
      };
    }
    const stop = end < 0 ? n : end;
    if (mode === XML_CDATA && builder && depth > 0 && end >= 0) {
      const level = depth + 1;
      if (level <= maxLevel) {
        const t = builder.push(KIND_STRING, constructStart, level, TEXT_KEY);
        builder.ends[t] = base0 + stop;
      } else countCut(constructStart);
    }
    mode = XML_TEXT;
    i = stop;
    textStart = base0 + stop;
    textNonWs = false;
  }
  if (i >= limit) {
    return {
      closes,
      cutInherited,
      anchors,
      needMore: false,
      elements,
      exit: {
        mode: XML_TEXT,
        progress: 0,
        constructStart: -1,
        skip: i - limit,
        depth,
        textStart: mode === XML_TEXT && entry.mode === XML_TEXT ? entry.textStart : textStart,
        textNonWs: entry.mode === XML_TEXT ? entry.textNonWs : false,
      },
    };
  }

  const needMore = (): XmlStructure => ({
    closes,
    cutInherited,
    anchors,
    needMore: true,
    elements,
    exit: entry,
  });

  while (i < limit) {
    // Text up to the next '<'.
    let lt = window.indexOf(LT, i);
    if (lt < 0 || lt >= limit) {
      // The rest of the region is text (or the file ends in it).
      const stop = lt < 0 && eof ? n : limit;
      if (!textNonWs) {
        for (let k = i; k < stop; k++) {
          if (WS[window[k] as number] !== 1) {
            textNonWs = true;
            break;
          }
        }
      }
      if (lt < 0 && eof) {
        endTextNode(n);
        i = n;
        break;
      }
      i = limit;
      break;
    }
    if (!textNonWs) {
      for (let k = i; k < lt; k++) {
        if (WS[window[k] as number] !== 1) {
          textNonWs = true;
          break;
        }
      }
    }
    // What starts at lt.
    const c1 = lt + 1 < n ? (window[lt + 1] as number) : -1;
    if (c1 === -1) {
      if (!eof) return needMore();
      i = n;
      break;
    }
    if (c1 === BANG) {
      if (startsWith(window, lt, "<!--")) {
        endTextNode(lt);
        const end = findEnd(window, lt + 4, COMMENT_END, 0);
        if (end < 0) {
          if (eof) {
            i = n;
            break;
          }
          if (n - lt <= MAX_CONSTRUCT_TO_HOLD) return needMore();
          return {
            closes,
            cutInherited,
            anchors,
            needMore: false,
            elements,
            exit: {
              mode: XML_COMMENT,
              progress: trailingProgress(window, limit, COMMENT_END),
              constructStart: base0 + lt,
              skip: 0,
              depth,
              textStart: -1,
              textNonWs: false,
            },
          };
        }
        i = end;
        textStart = base0 + end;
        textNonWs = false;
        continue;
      }
      if (startsWith(window, lt, "<![CDATA[")) {
        endTextNode(lt);
        const end = findEnd(window, lt + 9, CDATA_END, 0);
        if (end < 0) {
          if (eof) {
            i = n;
            break;
          }
          if (n - lt <= MAX_CONSTRUCT_TO_HOLD) return needMore();
          return {
            closes,
            cutInherited,
            anchors,
            needMore: false,
            elements,
            exit: {
              mode: XML_CDATA,
              progress: trailingProgress(window, limit, CDATA_END),
              constructStart: base0 + lt,
              skip: 0,
              depth,
              textStart: -1,
              textNonWs: false,
            },
          };
        }
        if (depth > 0) {
          const level = depth + 1;
          if (level <= maxLevel) {
            if (builder) {
              const t = builder.push(KIND_STRING, base0 + lt, level, TEXT_KEY);
              builder.ends[t] = base0 + end;
            }
          } else countCut(base0 + lt);
        }
        i = end;
        textStart = base0 + end;
        textNonWs = false;
        continue;
      }
      // <!DOCTYPE ...>, possibly with an internal subset in brackets.
      endTextNode(lt);
      let k = lt + 2;
      let bracket = 0;
      let quote = 0;
      let closed = false;
      for (; k < n; k++) {
        const b = window[k] as number;
        if (quote !== 0) {
          if (b === quote) quote = 0;
        } else if (b === DQ || b === SQ) quote = b;
        else if (b === LBRACKET) bracket++;
        else if (b === RBRACKET) bracket--;
        else if (b === GT && bracket <= 0) {
          closed = true;
          break;
        }
      }
      if (!closed) {
        if (eof) {
          i = n;
          break;
        }
        return needMore();
      }
      i = k + 1;
      textStart = base0 + i;
      textNonWs = false;
      continue;
    }
    if (c1 === QMARK) {
      endTextNode(lt);
      const end = findEnd(window, lt + 2, PI_END, 0);
      if (end < 0) {
        if (eof) {
          i = n;
          break;
        }
        if (n - lt <= MAX_CONSTRUCT_TO_HOLD) return needMore();
        return {
          closes,
          cutInherited,
          anchors,
          needMore: false,
          elements,
          exit: {
            mode: XML_PI,
            progress: trailingProgress(window, limit, PI_END),
            constructStart: base0 + lt,
            skip: 0,
            depth,
            textStart: -1,
            textNonWs: false,
          },
        };
      }
      i = end;
      textStart = base0 + end;
      textNonWs = false;
      continue;
    }
    if (c1 === SLASH) {
      // End tag.
      let k = window.indexOf(GT, lt + 2);
      if (k < 0) {
        if (eof) {
          endTextNode(lt);
          i = n;
          break;
        }
        return needMore();
      }
      endTextNode(lt);
      const endAbs = base0 + k + 1;
      if (depth > 0) {
        const holder = localAt[depth] as number;
        if (depth <= floor) {
          // An element that was open at entry: the coordinator sets its end.
          closes.push(builder ? builder.count : 0, depth, endAbs);
          floor = depth - 1;
        } else if (builder && holder >= 0) builder.ends[holder] = endAbs;
        localAt[depth] = -1;
        depth--;
      }
      i = k + 1;
      textStart = base0 + i;
      textNonWs = false;
      continue;
    }
    if (c1 === 0x20 || c1 === 0x0a || c1 === 0x09 || c1 === 0x0d || c1 === EQ || c1 === GT) {
      // A stray '<' in text: part of it.
      i = lt + 1;
      continue;
    }
    // Start tag: <name attributes... > or />
    let k = lt + 1;
    while (k < n && !isDelimiter(window[k] as number)) k++;
    if (k >= n && !eof) return needMore();
    const level = depth + 1;
    const onTape = emitting && level <= maxLevel;
    endTextNode(lt);
    let element = -1;
    if (onTape && builder) {
      element = builder.push(KIND_OBJECT, base0 + lt, level, base0 + lt);
    } else if (depth === maxLevel) countCut(base0 + lt);
    elements++;
    let attrLevel = level + 1;
    let selfClose = false;
    let tagEnd = -1;
    for (;;) {
      while (k < n && WS[window[k] as number] === 1) k++;
      if (k >= n) {
        if (eof) {
          tagEnd = n;
          break;
        }
        return needMore();
      }
      const c = window[k] as number;
      if (c === GT) {
        tagEnd = k + 1;
        break;
      }
      if (c === SLASH) {
        if (k + 1 < n && window[k + 1] === GT) {
          selfClose = true;
          tagEnd = k + 2;
          break;
        }
        if (k + 1 >= n && !eof) return needMore();
        k++;
        continue;
      }
      // An attribute: name [= value].
      const nameStart = k;
      while (k < n) {
        const b = window[k] as number;
        if (WS[b] === 1 || b === EQ || b === GT || b === SLASH) break;
        k++;
      }
      let valueStart = -1;
      let valueEnd = -1;
      let j = k;
      while (j < n && WS[window[j] as number] === 1) j++;
      if (j < n && window[j] === EQ) {
        j++;
        while (j < n && WS[window[j] as number] === 1) j++;
        if (j >= n) {
          if (eof) {
            k = n;
            continue;
          }
          return needMore();
        }
        const q = window[j] as number;
        if (q === DQ || q === SQ) {
          const close = window.indexOf(q, j + 1);
          if (close < 0) {
            if (eof) {
              valueStart = j;
              valueEnd = n;
              k = n;
            } else return needMore();
          } else {
            valueStart = j;
            valueEnd = close + 1;
            k = close + 1;
          }
        } else {
          // Unquoted value: tolerated, up to white space or the end of the tag.
          valueStart = j;
          let e = j;
          while (e < n && WS[window[e] as number] !== 1 && window[e] !== GT) e++;
          valueEnd = e;
          k = e;
        }
      } else {
        // No value: an attribute with an empty value.
        k = Math.max(k, nameStart + 1);
        valueStart = valueEnd = -1;
      }
      if (valueStart >= 0) {
        if (attrLevel <= maxLevel && builder) {
          const t = builder.push(KIND_STRING, base0 + valueStart, attrLevel, base0 + nameStart);
          builder.ends[t] = base0 + valueEnd;
        } else if (level === maxLevel) {
          if (element >= 0 && builder)
            builder.childCounts[element] = (builder.childCounts[element] as number) + 1;
        }
      }
    }
    void attrLevel;
    attrLevel = 0;
    const tagEndAbs = base0 + tagEnd;
    if (selfClose) {
      if (element >= 0 && builder) builder.ends[element] = tagEndAbs;
    } else {
      depth++;
      grow(depth);
      localAt[depth] = element;
    }
    i = tagEnd;
    textStart = tagEndAbs;
    textNonWs = false;
    if (tagEnd > limit) {
      // The tag runs past the region: the next region skips what is left of it.
      break;
    }
  }
  void entryDepth;
  const skip = i > limit ? i - limit : 0;
  const exitStart = textStart;
  return {
    closes,
    cutInherited,
    anchors,
    needMore: false,
    elements,
    exit: {
      mode: XML_TEXT,
      progress: 0,
      constructStart: -1,
      skip,
      depth,
      textStart: exitStart,
      textNonWs,
    },
  };
};

/** How much of a construct the scanner will keep asking the caller to read before it carries state instead. */
const MAX_CONSTRUCT_TO_HOLD = 64 * 1024 * 1024;

/** Pass 1: the entry state of the next region. */
export const advanceXml = (
  window: Uint8Array,
  base: number,
  regionEnd: number,
  fileSize: number,
  entry: XmlEntry,
): { exit: XmlEntry; needMore: boolean } => {
  const r = scanXml(window, base, regionEnd, fileSize, entry, null, 0);
  return { exit: r.exit, needMore: r.needMore };
};
