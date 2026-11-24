// rbush 4.0.1 ships no declarations; this is the part of its API the index uses.
declare module "rbush" {
  export interface BBox {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  }
  export default class RBush<T extends BBox> {
    constructor(maxEntries?: number);
    insert(item: T): this;
    /** Bulk-inserts with STR packing; far cheaper than one insert per item. */
    load(items: ReadonlyArray<T>): this;
    remove(item: T, equals?: (a: T, b: T) => boolean): this;
    search(box: BBox): T[];
    clear(): this;
  }
}
