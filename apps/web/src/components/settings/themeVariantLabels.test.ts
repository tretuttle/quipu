import { describe, expect, it } from "vite-plus/test";

import { themeVariantLabels } from "./themeVariantLabels";

describe("themeVariantLabels", () => {
  it("names the Dracula variants after what sets them apart", () => {
    expect(themeVariantLabels(["Dracula Theme", "Dracula Theme Soft"])).toEqual([
      "Dracula Theme",
      "Soft",
    ]);
  });

  it("drops the shared family name", () => {
    expect(
      themeVariantLabels([
        "Catppuccin Latte",
        "Catppuccin Frappé",
        "Catppuccin Macchiato",
        "Catppuccin Mocha",
      ]),
    ).toEqual(["Latte", "Frappé", "Macchiato", "Mocha"]);
  });

  it("keeps the base variant's full name next to its siblings", () => {
    expect(themeVariantLabels(["Tokyo Night", "Tokyo Night Storm", "Tokyo Night Light"])).toEqual([
      "Tokyo Night",
      "Storm",
      "Light",
    ]);
  });

  it("keeps labels that share nothing, and a lone label, as they are", () => {
    expect(themeVariantLabels(["Nord", "Polar Night"])).toEqual(["Nord", "Polar Night"]);
    expect(themeVariantLabels([" Solo "])).toEqual(["Solo"]);
  });

  it("never names a variant with an empty string", () => {
    expect(themeVariantLabels(["Same", "same"])).toEqual(["Same", "same"]);
  });
});
