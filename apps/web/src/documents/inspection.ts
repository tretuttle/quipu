import type {
  Decoded,
  Detection,
  FramesPage,
  ImagePreview,
  NodeRef,
  RowsPage,
  TextValue,
} from "@quipu/contracts/engine";

import type { Selection } from "./treeModel.ts";

/** What the Inspector asks of the engine; the app passes the typed client, tests pass a fake. */
export interface InspectSource {
  readonly text: (ref: NodeRef, limit: number) => Promise<TextValue>;
  readonly decode: (ref: NodeRef, kind: Detection["kind"]) => Promise<Decoded>;
  readonly preview: (ref: NodeRef) => Promise<ImagePreview>;
  readonly frames: (ref: NodeRef, from: number, count: number) => Promise<FramesPage>;
  /** A page of a container's members with their keys and previews. */
  readonly rows: (
    ref: NodeRef,
    from: number,
    count: number,
    previewBytes: number,
  ) => Promise<RowsPage>;
}

/** The Inspector shows this much of a value as text. */
export const VALUE_VIEW_BYTES = 16 * 1024;
/** A container shows this many of its members, each previewed in this many bytes. */
const MEMBERS_VIEW_COUNT = 50;
const MEMBER_PREVIEW_BYTES = 120;
/** A frames list shows this many frames at a time. */
const FRAMES_VIEW_COUNT = 100;
export const FRAMES_KEY = "_webSocketMessages";

export interface DecodedEntry {
  readonly detection: Detection;
  readonly decoded: Decoded | null;
  readonly error: string | null;
}

/** Everything the Inspector shows for one selected row. */
export interface Inspection {
  readonly id: string;
  /** The node the value, the decodes and an image preview are read from. */
  readonly ref: NodeRef;
  /** The head of a scalar's text, or null for a container. */
  readonly value: TextValue | null;
  readonly decodes: ReadonlyArray<DecodedEntry>;
  /** WebSocket frames, when the selection is `_webSocketMessages` or one of its frames. */
  readonly frames: FramesPage | null;
  /** The first members of an object or array, whether or not it is open in the tree. */
  readonly members: RowsPage | null;
}

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : "The value could not be decoded.";

/** Reads what the Inspector shows for `selection`: the value, every decode detection offered, and frames. */
export const inspect = async (source: InspectSource, selection: Selection): Promise<Inspection> => {
  const { node } = selection;
  const scalar = node.kind !== "object" && node.kind !== "array";
  const [value, decodes, frames, members] = await Promise.all([
    scalar ? source.text(node.ref, VALUE_VIEW_BYTES) : Promise.resolve(null),
    Promise.all(
      selection.detections.map(async (detection): Promise<DecodedEntry> => {
        try {
          return { detection, decoded: await source.decode(node.ref, detection.kind), error: null };
        } catch (error) {
          return { detection, decoded: null, error: messageOf(error) };
        }
      }),
    ),
    framesOf(source, selection),
    // WebSocket frames have their own list.
    scalar || node.childCount === 0 || showsFrames(selection)
      ? Promise.resolve(null)
      : source.rows(node.ref, 0, MEMBERS_VIEW_COUNT, MEMBER_PREVIEW_BYTES).catch(() => null),
  ]);
  return { id: selection.id, ref: node.ref, value, decodes, frames, members };
};

const isFramesArray = (selection: Selection) =>
  selection.node.kind === "array" && selection.name === FRAMES_KEY;
const isFrame = (selection: Selection) =>
  selection.node.kind === "object" &&
  selection.parent?.key === FRAMES_KEY &&
  selection.index !== null;
const showsFrames = (selection: Selection) => isFramesArray(selection) || isFrame(selection);

const framesOf = async (source: InspectSource, selection: Selection) => {
  try {
    if (isFramesArray(selection)) {
      return await source.frames(selection.node.ref, 0, FRAMES_VIEW_COUNT);
    }
    if (isFrame(selection) && selection.parent !== null && selection.index !== null) {
      return await source.frames(selection.parent.ref, selection.index, 1);
    }
  } catch {
    // The frames are an extra view; the rest of the inspection stands without them.
  }
  return null;
};
