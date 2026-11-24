import { assert, describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  ClientSettingsPatch,
  ClientSettingsSchema,
  DEFAULT_CLIENT_SETTINGS,
  MAX_PANEL_ANIMATION_DURATION_MS,
} from "./settings.ts";

const decode = Schema.decodeUnknownSync(ClientSettingsSchema);
const decodeClientSettings = decode;
const decodeClientSettingsPatch = Schema.decodeUnknownSync(ClientSettingsPatch);
const encode = Schema.encodeSync(ClientSettingsSchema);

describe("ClientSettingsSchema", () => {
  it("decodes an empty document to the defaults", () => {
    assert.deepStrictEqual(decode({}), DEFAULT_CLIENT_SETTINGS);
    assert.strictEqual(DEFAULT_CLIENT_SETTINGS.panelAnimationDurationMs, 0);
    assert.strictEqual(DEFAULT_CLIENT_SETTINGS.confirmStorageClear, true);
  });

  it("round-trips a customized document", () => {
    const settings = decode({ panelAnimationDurationMs: 150, confirmStorageClear: false });
    assert.deepStrictEqual(decode(encode(settings)), settings);
  });

  it("rejects a panel animation duration outside 0 to 400", () => {
    assert.throws(() => decode({ panelAnimationDurationMs: -1 }));
    assert.throws(() => decode({ panelAnimationDurationMs: MAX_PANEL_ANIMATION_DURATION_MS + 1 }));
    assert.throws(() => decode({ panelAnimationDurationMs: 12.5 }));
  });

  it("drops keys it does not know", () => {
    const decoded = decode({ confirmStorageClear: false, retiredSetting: 1 });
    assert.isFalse("retiredSetting" in decoded);
    assert.strictEqual(decoded.confirmStorageClear, false);
  });
});

describe("ClientSettingsPatch", () => {
  it("accepts a partial document and nothing out of range", () => {
    const decodePatch = Schema.decodeUnknownSync(ClientSettingsPatch);
    assert.deepStrictEqual(decodePatch({ confirmStorageClear: false }), {
      confirmStorageClear: false,
    });
    assert.throws(() => decodePatch({ panelAnimationDurationMs: 401 }));
  });
});

describe("ClientSettings glass opacity", () => {
  it("defaults to a readable translucent surface", () => {
    expect(decodeClientSettings({}).glassOpacity).toBe(80);
  });

  it.each([39, 101, 72.5])("rejects an invalid glass opacity: %s", (value) => {
    expect(() => decodeClientSettings({ glassOpacity: value })).toThrow();
    expect(() => decodeClientSettingsPatch({ glassOpacity: value })).toThrow();
  });

  it.each([40, 75, 100])("accepts a glass opacity within the supported range: %s", (value) => {
    expect(decodeClientSettings({ glassOpacity: value }).glassOpacity).toBe(value);
    expect(decodeClientSettingsPatch({ glassOpacity: value }).glassOpacity).toBe(value);
  });
});

describe("ClientSettings appearance contrast", () => {
  it("defaults to the theme's original contrast", () => {
    expect(decodeClientSettings({}).appearanceContrast).toBe(100);
  });

  it.each([49, 201, 92.5])("rejects an invalid appearance contrast: %s", (value) => {
    expect(() => decodeClientSettings({ appearanceContrast: value })).toThrow();
    expect(() => decodeClientSettingsPatch({ appearanceContrast: value })).toThrow();
  });

  it.each([50, 100, 150, 200])("accepts an appearance contrast in range: %s", (value) => {
    expect(decodeClientSettings({ appearanceContrast: value }).appearanceContrast).toBe(value);
    expect(decodeClientSettingsPatch({ appearanceContrast: value }).appearanceContrast).toBe(value);
  });
});

describe("ClientSettings panel animations", () => {
  it("defaults to instant changes", () => {
    expect(decodeClientSettings({}).panelAnimationDurationMs).toBe(0);
  });

  it.each([0, 400])("accepts a panel animation duration: %s", (value) => {
    expect(decodeClientSettingsPatch({ panelAnimationDurationMs: value })).toEqual({
      panelAnimationDurationMs: value,
    });
  });

  it.each([-1, 401, 150.5])("rejects an invalid panel animation duration: %s", (value) => {
    expect(() => decodeClientSettingsPatch({ panelAnimationDurationMs: value })).toThrow();
  });
});

describe("ClientSettings fonts", () => {
  it("keeps only the font settings Quipu has a surface for", () => {
    expect(
      Object.keys(decodeClientSettings({}))
        .filter((key) => key.startsWith("font"))
        .sort(),
    ).toEqual([
      "fontFamilyCode",
      "fontFamilySans",
      "fontSizeCode",
      "fontSizeInterface",
      "fontSmoothing",
    ]);
  });

  it("defaults to the stylesheet stacks and sizes", () => {
    const settings = decodeClientSettings({});
    expect(settings.fontSizeInterface).toBe(16);
    expect(settings.fontSizeCode).toBe(13);
    expect(settings.fontFamilySans).toBe("");
    expect(settings.fontFamilyCode).toBe("");
    expect(settings.fontSmoothing).toBe(true);
  });

  it.each([
    ["fontSizeInterface", 11, 21],
    ["fontSizeCode", 9, 19],
  ] as const)("rejects %s outside its range", (key, low, high) => {
    expect(() => decodeClientSettings({ [key]: low })).toThrow();
    expect(() => decodeClientSettings({ [key]: high })).toThrow();
    expect(() => decodeClientSettingsPatch({ [key]: low })).toThrow();
  });

  it("accepts an empty family and a named family", () => {
    expect(decodeClientSettings({ fontFamilyCode: "IBM Plex Mono" }).fontFamilyCode).toBe(
      "IBM Plex Mono",
    );
    expect(decodeClientSettingsPatch({ fontSmoothing: false })).toEqual({ fontSmoothing: false });
  });
});
