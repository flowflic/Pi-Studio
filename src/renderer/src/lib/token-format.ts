/** Compact token counts without changing the numeric scale. */
export function formatTokens(tokens: number): string {
  const value = Number.isFinite(tokens) ? Math.max(0, tokens) : 0;
  for (const [scale, unit] of [[1_000_000_000, "B"], [1_000_000, "M"], [1_000, "K"]] as const) {
    // Promote a rounded 1000K/1000M to the next unit as well.
    if (value >= scale || scale > 1_000 && value >= scale - scale / 200_000) return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value / scale)}${unit}`;
  }
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}
