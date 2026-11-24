import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";

import {
  KeybindingRule,
  KeybindingsConfig,
  MAX_KEYBINDINGS_COUNT,
  PersistedKeybindingsConfig,
  ResolvedKeybindingRule,
  ResolvedKeybindingsConfig,
} from "./keybindings.ts";

const decode = <S extends Schema.Top>(
  schema: S,
  input: unknown,
): Effect.Effect<Schema.Schema.Type<S>, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(schema as never)(input) as Effect.Effect<
    Schema.Schema.Type<S>,
    Schema.SchemaError,
    never
  >;

const encodeResolvedKeybindings = Schema.encodeEffect(ResolvedKeybindingsConfig);

const shortcut = {
  key: "p",
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  modKey: true,
};

it.effect("parses keybinding rules for the shell commands", () =>
  Effect.gen(function* () {
    for (const command of [
      "sidebar.toggle",
      "navigation.back",
      "navigation.forward",
      "rightPanel.toggle",
      "rightPanel.inspector",
      "rightPanel.source",
      "keybindings.show",
      "commandPalette.toggle",
      "theme.select",
      "appearance.cycle",
      "themeEditor.toggle",
      "document.open",
      "view.tree",
      "view.source",
      "tree.expandAll",
      "tree.collapseAll",
      "search.open",
      "search.next",
      "search.previous",
      "search.path",
      "search.jq",
      "decode.toggle",
    ] as const) {
      const parsed = yield* decode(KeybindingRule, { key: "mod+j", command });
      assert.strictEqual(parsed.command, command);
    }
  }),
);

it.effect("rejects commands that do not exist", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decode(KeybindingRule, { key: "mod+j", command: "example.missing" }),
    );
    assert.strictEqual(result._tag, "Failure");
    // The right panel has no Diff or Schema tab.
    for (const command of ["rightPanel.diff", "rightPanel.schema"]) {
      const removed = yield* Effect.exit(decode(KeybindingRule, { key: "mod+j", command }));
      assert.strictEqual(removed._tag, "Failure");
    }
  }),
);

it.effect("trims keys and rejects empty or oversized ones", () =>
  Effect.gen(function* () {
    const trimmed = yield* decode(KeybindingRule, {
      key: "  mod+k ",
      command: "commandPalette.toggle",
      when: " !editableFocus ",
    });
    assert.strictEqual(trimmed.key, "mod+k");
    assert.strictEqual(trimmed.when, "!editableFocus");

    const empty = yield* Effect.exit(
      decode(KeybindingRule, { key: "  ", command: "sidebar.toggle" }),
    );
    assert.strictEqual(empty._tag, "Failure");
    const tooLong = yield* Effect.exit(
      decode(KeybindingRule, { key: "a".repeat(65), command: "sidebar.toggle" }),
    );
    assert.strictEqual(tooLong._tag, "Failure");
  }),
);

it.effect("caps a config at 256 rules", () =>
  Effect.gen(function* () {
    const rule = { key: "mod+b", command: "sidebar.toggle" };
    const atLimit = yield* Effect.exit(
      decode(
        KeybindingsConfig,
        Array.from({ length: MAX_KEYBINDINGS_COUNT }, () => rule),
      ),
    );
    assert.strictEqual(atLimit._tag, "Success");
    const overLimit = yield* Effect.exit(
      decode(
        KeybindingsConfig,
        Array.from({ length: MAX_KEYBINDINGS_COUNT + 1 }, () => rule),
      ),
    );
    assert.strictEqual(overLimit._tag, "Failure");
  }),
);

it.effect("skips persisted rules written by a newer build", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(PersistedKeybindingsConfig, [
      { key: "mod+b", command: "sidebar.toggle" },
      { key: "mod+t", command: "someFuture.command" },
      "garbage",
      { key: "mod+k", command: "commandPalette.toggle", when: "isDesktop" },
    ]);
    assert.deepEqual(
      parsed.map((rule) => rule.command),
      ["sidebar.toggle", "commandPalette.toggle"],
    );
  }),
);

it.effect("parses a resolved rule with a nested when expression", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(ResolvedKeybindingRule, {
      command: "rightPanel.toggle",
      shortcut,
      whenAst: {
        type: "and",
        left: { type: "identifier", name: "isDesktop" },
        right: { type: "not", node: { type: "identifier", name: "editableFocus" } },
      },
    });
    assert.strictEqual(parsed.shortcut.key, "p");
  }),
);

it.effect("drops resolved rules with commands this build does not know", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(ResolvedKeybindingsConfig, [
      { command: "sidebar.toggle", shortcut },
      { command: "someFuture.toggle", shortcut },
      { command: "commandPalette.toggle", shortcut },
    ]);
    assert.deepEqual(
      parsed.map((rule) => rule.command),
      ["sidebar.toggle", "commandPalette.toggle"],
    );
  }),
);

it.effect("drops resolved rules with unknown when-node types", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(ResolvedKeybindingsConfig, [
      { command: "sidebar.toggle", shortcut, whenAst: { type: "xor", left: 1, right: 2 } },
      { command: "rightPanel.toggle", shortcut },
    ]);
    assert.deepEqual(
      parsed.map((rule) => rule.command),
      ["rightPanel.toggle"],
    );
  }),
);

it.effect("encodes resolved keybindings to the plain stored shape", () =>
  Effect.gen(function* () {
    const rules = [{ command: "sidebar.toggle" as const, shortcut }];
    const encoded = yield* encodeResolvedKeybindings(rules);
    assert.deepEqual(encoded, rules);
    const roundTripped = yield* decode(ResolvedKeybindingsConfig, encoded);
    assert.deepEqual(roundTripped, rules);
  }),
);
