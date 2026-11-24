import type { Locator, Page } from "playwright-core";

/** A step down the tree: an object member's key, or an array element's index. */
export type Step = string | number;

interface RenderedRow {
  readonly id: string;
  readonly level: number;
  readonly expanded: string | null;
  readonly name: string;
}

const CHUNK = /^\[(\d+)…(\d+)\]$/;

const snapshot = (page: Page) =>
  page.evaluate((): RenderedRow[] =>
    [...document.querySelectorAll<HTMLElement>('[data-tree-view] [role="treeitem"]')].map((el) => ({
      id: el.dataset.rowId ?? "",
      level: Number(el.getAttribute("aria-level")),
      expanded: el.getAttribute("aria-expanded"),
      name: el.querySelector("[data-tree-key]")?.textContent ?? "",
    })),
  );

/**
 * Walks the Document tree the way a user does: opens a row, finds the child,
 * and lets the list's type-ahead bring a row that is outside the virtualized
 * window into view. Tree rows carry `aria-level`, so a step is found by name at
 * the level below its parent.
 */
export class TreeNavigator {
  constructor(private readonly page: Page) {}

  row(id: string): Locator {
    return this.page.locator(`[data-tree-view] [data-row-id="${id}"]`);
  }

  async root(): Promise<{ id: string; level: number }> {
    await this.page.locator('[data-tree-view] [role="treeitem"]').first().waitFor();
    const first = (await snapshot(this.page))[0] as RenderedRow;
    return { id: first.id, level: first.level };
  }

  /** Opens the row if it is closed, then waits for a row under it. */
  private async open(id: string): Promise<void> {
    const row = this.row(id);
    await row.waitFor();
    if ((await row.getAttribute("aria-expanded")) === "false")
      await row.locator("[data-tree-toggle]").click();
    await this.page.waitForFunction((parent) => {
      const rows = [
        ...document.querySelectorAll<HTMLElement>('[data-tree-view] [role="treeitem"]'),
      ];
      const at = rows.findIndex((el) => el.dataset.rowId === parent);
      const next = rows[at + 1];
      return (
        at >= 0 &&
        next !== undefined &&
        Number(next.getAttribute("aria-level")) > Number(rows[at]?.getAttribute("aria-level"))
      );
    }, id);
  }

  /** Waits for a row called `name` at `level` after `parentId`'s row; false when it never renders. */
  private async appears(parentId: string, name: string, level: number) {
    try {
      await this.page.waitForFunction(
        ({ parent, wanted, depth }) => {
          const rows = [
            ...document.querySelectorAll<HTMLElement>('[data-tree-view] [role="treeitem"]'),
          ];
          const at = rows.findIndex((el) => el.dataset.rowId === parent);
          if (at < 0) return false;
          const base = Number(rows[at]?.getAttribute("aria-level"));
          for (let i = at + 1; i < rows.length; i++) {
            const el = rows[i] as HTMLElement;
            const l = Number(el.getAttribute("aria-level"));
            if (l <= base) return false;
            if (l === depth && el.querySelector("[data-tree-key]")?.textContent === wanted)
              return true;
          }
          return false;
        },
        { parent: parentId, wanted: name, depth: level },
        { timeout: 3_000 },
      );
      return true;
    } catch {
      return false;
    }
  }

  /** The id of the row named `name` at `level` that follows `parentId`'s row. */
  private async find(parentId: string, name: string, level: number) {
    return this.page.evaluate(
      ({ parent, wanted, depth }) => {
        const rows = [
          ...document.querySelectorAll<HTMLElement>('[data-tree-view] [role="treeitem"]'),
        ];
        const at = rows.findIndex((el) => el.dataset.rowId === parent);
        const base = Number(rows[at]?.getAttribute("aria-level"));
        for (let i = at + 1; i < rows.length; i++) {
          const el = rows[i] as HTMLElement;
          const l = Number(el.getAttribute("aria-level"));
          if (l <= base) break;
          if (l === depth && el.querySelector("[data-tree-key]")?.textContent === wanted)
            return el.dataset.rowId ?? null;
        }
        return null;
      },
      { parent: parentId, wanted: name, depth: level },
    );
  }

  /** The list's type-ahead jumps to the first row starting with what is typed, and scrolls to it. */
  private async typeAhead(fromId: string, text: string, level: number): Promise<string> {
    await this.row(fromId).focus();
    await this.page.keyboard.type(text);
    try {
      await this.page.waitForFunction(
        ({ target, depth }) => {
          const active = document.activeElement as HTMLElement | null;
          return (
            active?.querySelector("[data-tree-key]")?.textContent === target &&
            Number(active.getAttribute("aria-level")) === depth
          );
        },
        { target: text, depth: level },
        { timeout: 5_000 },
      );
    } catch {
      const active = await this.page.evaluate(
        () => document.activeElement?.textContent ?? "(none)",
      );
      throw new Error(`type-ahead to ${text} from ${fromId} left the focus on: ${active}`);
    }
    return this.page.evaluate(() => (document.activeElement as HTMLElement).dataset.rowId ?? "");
  }

  async child(
    parent: { id: string; level: number },
    step: Step,
  ): Promise<{ id: string; level: number }> {
    await this.open(parent.id);
    const name = String(step);
    const level = parent.level + 1;
    if (await this.appears(parent.id, name, level)) {
      const id = await this.find(parent.id, name, level);
      if (id !== null) return { id, level };
    }
    if (typeof step === "number") {
      // A big array lists ranges; open the one that holds the index.
      const rows = await snapshot(this.page);
      const at = rows.findIndex((r) => r.id === parent.id);
      for (let i = at + 1; i < rows.length; i++) {
        if (at < 0) break;
        const candidate = rows[i] as RenderedRow;
        if (candidate.level <= parent.level) break;
        const match = CHUNK.exec(candidate.name);
        if (
          candidate.level === level &&
          match &&
          step >= Number(match[1]) &&
          step <= Number(match[2])
        ) {
          await this.open(candidate.id);
          if (await this.appears(candidate.id, name, level + 1)) {
            const id = await this.find(candidate.id, name, level + 1);
            if (id !== null) return { id, level: level + 1 };
          }
          return { id: await this.typeAhead(candidate.id, name, level + 1), level: level + 1 };
        }
      }
    }
    return { id: await this.typeAhead(parent.id, name, level), level };
  }

  async reveal(path: ReadonlyArray<Step>): Promise<string> {
    // The list may be scrolled away from the root after an earlier reveal.
    await this.page.locator('[data-tree-view] [role="treeitem"]').first().focus();
    await this.page.keyboard.press("Home");
    await this.page.waitForFunction(
      () =>
        document.querySelector('[data-tree-view] [role="treeitem"]')?.getAttribute("aria-level") ===
        "1",
    );
    let at = await this.root();
    for (const step of path) at = await this.child(at, step);
    return at.id;
  }
}
