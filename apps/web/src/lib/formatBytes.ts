const UNITS = ["kB", "MB", "GB", "TB"] as const;

/**
 * A byte count the way people read file sizes: decimal units (1 kB is 1,000
 * bytes) and three significant digits, "13.4 kB", "52.8 MB", "2.15 GB". Every
 * size the app shows goes through here.
 */
export function formatBytes(value: number): string {
  if (value < 999.5) return `${Math.round(value)} B`;
  let scaled = value / 1000;
  let unit = 0;
  // 999.5 kB would round to "1000 kB": it reads as the next unit.
  while (scaled >= 999.5 && unit < UNITS.length - 1) {
    scaled /= 1000;
    unit += 1;
  }
  const digits = scaled >= 99.95 ? 0 : scaled >= 9.995 ? 1 : 2;
  return `${scaled.toFixed(digits)} ${UNITS[unit]}`;
}
