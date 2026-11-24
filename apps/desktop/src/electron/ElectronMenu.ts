import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as Electron from "electron";

export class ElectronMenuOperationError extends Schema.TaggedError<ElectronMenuOperationError>()(
  "ElectronMenuOperationError",
  {
    operation: Schema.Literals(["set-application-menu"]),
    itemCount: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Electron menu operation ${JSON.stringify(this.operation)} failed with ${this.itemCount} items.`;
  }
}

export class ElectronMenu extends Context.Service<
  ElectronMenu,
  {
    readonly setApplicationMenu: (
      template: readonly Electron.MenuItemConstructorOptions[],
    ) => Effect.Effect<void>;
  }
>()("@quipu/desktop/electron/ElectronMenu") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = ElectronMenu.of({
  setApplicationMenu: (template) =>
    Effect.try({
      try: () => {
        Electron.Menu.setApplicationMenu(Electron.Menu.buildFromTemplate([...template]));
      },
      catch: (cause) =>
        new ElectronMenuOperationError({
          operation: "set-application-menu",
          itemCount: template.length,
          cause,
        }),
    }).pipe(Effect.orDie),
});

export const layer = Layer.succeed(ElectronMenu, make);
