import { useEffect } from "react";

import { registerUnsavedChangesHost, useUnsavedPrompt } from "../documents/unsavedChanges";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";

/** Save, Discard or Cancel for a document with unsaved edits that is about to be replaced or closed. */
export function UnsavedChangesDialog() {
  const name = useUnsavedPrompt((state) => state.name);
  const respond = useUnsavedPrompt((state) => state.respond);
  useEffect(() => registerUnsavedChangesHost(), []);
  return (
    <AlertDialog
      open={name !== null}
      onOpenChange={(open) => {
        if (!open && useUnsavedPrompt.getState().name !== null) respond("cancel");
      }}
    >
      <AlertDialogPopup data-unsaved-changes-dialog="">
        <AlertDialogHeader>
          <AlertDialogTitle>Save changes to {name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Your edits are lost if you don't save them.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
          <Button variant="destructive-outline" onClick={() => respond("discard")}>
            Discard
          </Button>
          <Button onClick={() => respond("save")}>Save</Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
