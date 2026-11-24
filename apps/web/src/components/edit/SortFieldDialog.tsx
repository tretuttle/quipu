import { useState } from "react";

import { runTransform, useSortFieldPrompt } from "~/documents/documentEdits";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";

/** Asks which field of each element an array is sorted by, then sorts it as one edit. */
export function SortFieldDialog() {
  const open = useSortFieldPrompt((state) => state.open);
  const [field, setField] = useState("");
  const [descending, setDescending] = useState(false);
  const close = () => useSortFieldPrompt.setState({ open: false });
  const submit = () => {
    if (field === "") return;
    close();
    void runTransform("sortArrayByField", field, descending);
  };
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : close())}>
      <DialogPopup data-sort-field-dialog="">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Sort array by field</DialogTitle>
            <DialogDescription>
              Elements are ordered by the value of this field; elements without it go last.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <Input
              aria-label="Field"
              placeholder="Field name, for example startedDateTime"
              font="mono"
              autoFocus
              value={field}
              onChange={(event) => setField(event.currentTarget.value)}
            />
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={descending} onCheckedChange={setDescending} />
              Descending
            </label>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={field === ""}>
              Sort
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
