/**
 * Thrown by a row-level emitter at the first element that starts at or after
 * the end of its region, so the walker stops there. It carries no data: the
 * region driver catches it and reads the output.
 */
export class RegionStop {
  readonly offset: number;
  constructor(offset: number) {
    this.offset = offset;
  }
}
