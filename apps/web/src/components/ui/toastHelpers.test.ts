import { assert, describe, it } from "vite-plus/test";

import { hiddenToastActionProps, stackedToast } from "./toastHelpers";

describe("hiddenToastActionProps", () => {
  it("is a defined update payload so Base UI can replace a previous action", () => {
    assert.equal(hiddenToastActionProps.children, null);
    assert.equal("actionProps" in stackedToast({ type: "loading", title: "Updating" }), false);
    assert.deepEqual(
      stackedToast({
        type: "loading",
        title: "Updating",
        actionProps: hiddenToastActionProps,
      }).actionProps,
      hiddenToastActionProps,
    );
  });
});
