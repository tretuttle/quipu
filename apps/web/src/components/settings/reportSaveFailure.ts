import { toastManager, stackedToast } from "../ui/toast";

/** Surfaces a rejected client-settings write; the control keeps its last saved value. */
export function reportSaveFailure(error: unknown): void {
  toastManager.add(
    stackedToast({
      type: "error",
      title: "Couldn't save the setting",
      description: error instanceof Error ? error.message : "Try again.",
    }),
  );
}
