import { create } from "zustand";

/** Whether the export dialog is showing; the command, the palette and the header open it. */
export const useExportDialog = create<{
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
}>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));
