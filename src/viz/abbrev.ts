/**
 * Label abbreviation (spec §7 "A" toggle): "Application Support" → "AS",
 * "node_modules" → "NM". Split on separators; take per-word initials up
 * to `budget`; budget 0 → "".
 *
 * Single-word strategy: multi-word initials stay at `budget` chars, but
 * a lone word abbreviated to the same budget degenerated to ONE letter
 * ("Downloads" → "D…") — pixel clipping on the cell would have kept
 * more. A lone word now keeps a `budget + 3` prefix ("Downloads" →
 * "Downl…"): still visibly denser than the un-abbreviated label, but
 * recognizable.
 */
export function abbreviate(name: string, budget = 2): string {
  if (budget <= 0) return "";
  const words = name.split(/[\s_-]+/).filter(Boolean);
  if (words.length <= 1) {
    const keep = Math.max(2, budget + 3);
    if (name.length <= keep) return name;
    return `${name.slice(0, keep)}…`;
  }
  return words
    .slice(0, Math.max(2, budget))
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}
