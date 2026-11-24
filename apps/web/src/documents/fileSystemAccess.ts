/**
 * The File System Access API as far as Quipu uses it. TypeScript's DOM library
 * does not carry it, and the browsers that lack it (Firefox, Safari) fall back
 * to an `<input type=file>`.
 */
export type PermissionMode = "read" | "readwrite";

export interface FileHandle {
  readonly kind: "file";
  readonly name: string;
  getFile(): Promise<File>;
  isSameEntry(other: FileHandle): Promise<boolean>;
  queryPermission(descriptor?: { mode: PermissionMode }): Promise<PermissionState>;
  requestPermission(descriptor?: { mode: PermissionMode }): Promise<PermissionState>;
}

/** A picker filter: a description and the extensions it offers per media type. */
export interface PickerType {
  readonly description: string;
  readonly accept: Readonly<Record<string, ReadonlyArray<string>>>;
}

interface PickerWindow {
  showOpenFilePicker?: (options?: {
    multiple?: boolean;
    types?: ReadonlyArray<PickerType>;
  }) => Promise<FileHandle[]>;
}

export const supportsFilePicker = () =>
  typeof (window as PickerWindow).showOpenFilePicker === "function";

/**
 * Shows the browser's open dialog, offering `types` first; "All files" stays
 * offered, since any file opens. Throws `AbortError` when the user cancels.
 */
export async function pickFileHandle(types: ReadonlyArray<PickerType> = []): Promise<FileHandle> {
  const handles = await (window as PickerWindow).showOpenFilePicker!({ multiple: false, types });
  const first = handles[0];
  if (first === undefined) throw new DOMException("No file was chosen.", "AbortError");
  return first;
}

/** The handle behind a dropped item, when the browser gives one. */
export async function handleOfDroppedItem(item: DataTransferItem | undefined) {
  const withHandle = item as
    | (DataTransferItem & { getAsFileSystemHandle?: () => Promise<unknown> })
    | undefined;
  if (typeof withHandle?.getAsFileSystemHandle !== "function") return null;
  try {
    const handle = (await withHandle.getAsFileSystemHandle()) as FileHandle | null | undefined;
    return handle?.kind === "file" ? handle : null;
  } catch {
    return null;
  }
}
