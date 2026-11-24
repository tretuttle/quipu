import type { Page } from "playwright-core";

import { board } from "./flows/board.ts";
import { edit } from "./flows/edit.ts";
import { map } from "./flows/map.ts";
import type { FlowContext } from "./record.ts";

export interface Flow {
  readonly id: string;
  readonly title: string;
  readonly run: (context: FlowContext) => Promise<void>;
}

export const FLOWS: ReadonlyArray<Flow> = [map, edit, board];

export const findFlow = (id: string): Flow | undefined => FLOWS.find((flow) => flow.id === id);

/** The app shell is up and nothing is open yet: every flow starts here. */
export const appReady = async (page: Page) => {
  await page.locator("[data-app-sidebar]").waitFor();
  await page.getByText("No document open", { exact: true }).waitFor();
};
