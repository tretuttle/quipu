import { getActiveMapController } from "../components/map/mapRegistry";
import type { TreeModel } from "./treeModel.ts";

/**
 * "Decode (or collapse) all values in selection", from the palette or the
 * Decode menu alike: on the map, under its current node (a HAR host or page
 * stands for its requests); in the tree, under the selected row.
 */
export async function decodeInSelection(tree: TreeModel, open: boolean): Promise<void> {
  const scope = getActiveMapController()?.selectionScope() ?? [tree.decodeScope];
  for (const id of scope) await tree.decodeAll(id, open);
}
