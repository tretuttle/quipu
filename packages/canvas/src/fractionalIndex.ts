/**
 * Fractional z-order keys. A key is a base-62 string; `keyBetween(a, b)`
 * returns a key that sorts strictly between its arguments, so a reorder
 * touches one element and never renumbers the scene.
 *
 * The scheme is the usual "midpoint in base 62" with one rule that keeps keys
 * finite: a key never ends in the lowest digit, so there is always room below
 * any key by appending digits.
 */
const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE = DIGITS.length;
const LOWEST = DIGITS[0] as string;

function digitValue(char: string): number {
  const value = DIGITS.indexOf(char);
  if (value < 0) throw new Error(`Not a fractional-index digit: ${JSON.stringify(char)}`);
  return value;
}

export function isValidIndexKey(key: string): boolean {
  if (key.length === 0) return false;
  for (const char of key) if (DIGITS.indexOf(char) < 0) return false;
  return !key.endsWith(LOWEST);
}

/** The first key a scene hands out: the middle digit, leaving equal room above and below. */
export const FIRST_INDEX_KEY = "V" as const;

function midpoint(a: string, b: string | null): string {
  // Invariant: a < b (b null means +infinity), neither ends in LOWEST.
  let prefix = "";
  let i = 0;
  for (;;) {
    const da = i < a.length ? digitValue(a[i] as string) : 0;
    const db = b === null ? BASE : i < b.length ? digitValue(b[i] as string) : BASE;
    if (da === db) {
      prefix += a[i] ?? LOWEST;
      i += 1;
      continue;
    }
    if (db - da > 1) {
      return prefix + (DIGITS[Math.floor((da + db) / 2)] as string);
    }
    // Adjacent digits: keep a's digit and keep going down a's tail with b = infinity.
    prefix += DIGITS[da] as string;
    i += 1;
    b = null;
  }
}

/**
 * A key strictly between `a` and `b`. `null` on either side means no bound.
 * Throws when `a >= b`.
 */
export function keyBetween(a: string | null, b: string | null): string {
  if (a !== null && !isValidIndexKey(a)) throw new Error(`Invalid index key ${JSON.stringify(a)}`);
  if (b !== null && !isValidIndexKey(b)) throw new Error(`Invalid index key ${JSON.stringify(b)}`);
  if (a !== null && b !== null && a >= b) {
    throw new Error(`keyBetween needs a < b, got ${JSON.stringify(a)} and ${JSON.stringify(b)}`);
  }
  if (a === null && b === null) return FIRST_INDEX_KEY;
  if (a === null) {
    // Something below b: shorten or decrement.
    const first = b as string;
    const head = digitValue(first[0] as string);
    if (head > 1) return DIGITS[Math.floor(head / 2)] as string;
    return midpoint(LOWEST, first);
  }
  if (b === null) {
    // Something above a: bump the first digit when there is room, else extend.
    const head = digitValue(a[0] as string);
    if (head < BASE - 1) return DIGITS[head + 1] as string;
    return midpoint(a, null);
  }
  return midpoint(a, b);
}

/** `count` keys in ascending order, all strictly between `a` and `b`. */
export function keysBetween(a: string | null, b: string | null, count: number): string[] {
  const keys: string[] = [];
  let lower = a;
  for (let i = 0; i < count; i += 1) {
    const key = keyBetween(lower, b);
    keys.push(key);
    lower = key;
  }
  return keys;
}

export function compareIndexKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
