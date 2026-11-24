/**
 * Short names for the variants of one installed theme set, shown under its
 * card's swatches. The words every variant label starts with are dropped
 * ("Catppuccin Latte", "Catppuccin Mocha" become "Latte", "Mocha"). A variant
 * whose whole label is that shared start keeps its full label, so the set
 * "Tokyo Night", "Tokyo Night Storm" reads "Tokyo Night", "Storm".
 */
export function themeVariantLabels(labels: ReadonlyArray<string>): ReadonlyArray<string> {
  if (labels.length < 2) return labels.map((label) => label.trim());
  const words = labels.map((label) => label.trim().split(/\s+/));
  const shortest = Math.min(...words.map((labelWords) => labelWords.length));
  let shared = 0;
  while (
    shared < shortest &&
    words.every(
      (labelWords) =>
        labelWords[shared]!.toLocaleLowerCase() === words[0]![shared]!.toLocaleLowerCase(),
    )
  ) {
    shared += 1;
  }
  return words.map((labelWords, index) => {
    const rest = labelWords.slice(shared).join(" ");
    return rest || labels[index]!.trim();
  });
}
