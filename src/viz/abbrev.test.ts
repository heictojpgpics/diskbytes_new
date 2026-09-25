/**
 * M4 gates (doc 03): the abbreviate-labels rule — "Application Support"
 * → "AS", "node_modules" → "NM" — and the hover-chip flag constants.
 */
import { describe, expect, it } from "vitest";

import { abbreviate } from "../viz/abbrev";
import { DIR_BIT, CELL_KIND } from "../viz/layoutIpc";

describe("abbreviate labels (spec §7 'A' toggle)", () => {
  it("short words become initials", () => {
    expect(abbreviate("Application Support", 2)).toBe("AS");
    expect(abbreviate("node_modules", 2)).toBe("NM");
    expect(abbreviate("Roaming AppData Local", 3)).toBe("RAL");
  });

  it("fits stay unchanged", () => {
    expect(abbreviate("Downloads", 20)).toBe("Downloads");
  });

  it("single long words truncate with an ellipsis", () => {
    // budget + 3 prefix (a lone word at 2 chars read as one glyph:
    // "D…" — the cell's own pixel clip would have kept more).
    const out = abbreviate("aaaaaaaaaaaaaaaa", 5);
    expect(out).toBe("aaaaaaaa…");
    expect(out.endsWith("…")).toBe(true);
    expect(abbreviate("Downloads", 2)).toBe("Downl…");
  });

  it("zero budget returns empty (tiny cells skip labels)", () => {
    expect(abbreviate("Anything", 0)).toBe("");
  });
});

describe("cell flags mirror the Rust constants", () => {
  it("DIR_BIT is bit 3, kinds occupy bits 0..2", () => {
    expect(DIR_BIT).toBe(8);
    expect(CELL_KIND.HEADER).toBe(4);
    expect(CELL_KIND.DOT).toBe(3);
    // A dir rect cell decodes kind AND dir-ness together.
    const flags = CELL_KIND.RECT | DIR_BIT;
    expect(flags & 0b111).toBe(CELL_KIND.RECT);
    expect((flags & DIR_BIT) !== 0).toBe(true);
  });
});
