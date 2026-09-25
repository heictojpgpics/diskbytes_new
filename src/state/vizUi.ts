/**
 * Explore visualization UI state (spec §7 toolbar): current mode, color
 * mode, depth (2–10, default 7), abbreviate toggle. Per-app-run only
 * (spec doc 05 §4.4: remember last mode/depth per run, not persisted).
 * The dev hook DISKBYTES_MODE seeds the initial mode (spec §15).
 */
import { create } from "zustand";

export const MODES = ["Folders", "Treemap", "Sunburst", "Flame", "Bubbles", "Mind Map", "Top Sizes", "Age Map", "List"] as const;
export type Mode = (typeof MODES)[number];

export const CANVAS_MODES = new Set<Mode>(["Treemap", "Sunburst", "Flame", "Bubbles", "Mind Map"]);
/** Modes that show the color-mode segmented control (spec §7). */
export const COLORED_MODES = new Set<Mode>(["Treemap", "Sunburst", "Flame", "Bubbles", "Mind Map"]);
/** Modes that show the depth slider (spec §7). Mind Map + Bubbles are
 *  depth-driven layouts (rings / nesting = levels) — both engines take
 *  the full 2–10 range; the old exclusion predates their full-depth
 *  ports (the mock used to render only 2 levels regardless). */
export const DEPTH_MODES = new Set<Mode>([
  "Treemap",
  "Sunburst",
  "Flame",
  "Bubbles",
  "Mind Map",
]);

export const MODE_CAPTIONS: Record<Mode, string> = {
  Folders: "Browse folder by folder, sized as you go",
  Treemap: "Every file as a rectangle, sized by bytes",
  Sunburst: "Rings radiating out from the scan root",
  Flame: "Depth top to bottom, size left to right",
  Bubbles: "Nested bubbles, one per folder",
  "Mind Map": "Branches from the root, sized by weight",
  "Top Sizes": "The biggest items, ranked",
  "Age Map": "Where your bytes sit on a timeline",
  List: "Every item as an expandable outline",
};

export type ColorMode = "by-folder" | "by-type" | "by-age";

/** Top Sizes scope (persisted per-run: switching modes/tabs and coming
 * back used to reset it to "In this folder" — the user's chosen lens
 * should survive a round-trip). */
export type TopScope = "in-folder" | "files-anywhere" | "folders-anywhere";

interface VizUiState {
  mode: Mode;
  colorMode: ColorMode;
  depth: number;
  abbreviate: boolean;
  topScope: TopScope;
  /** Depth memory PER MODE: depth semantics differ by engine (depth 9
   * renders hairline sunburst rings but a rich treemap). Switching
   * Sunburst→Treemap used to inherit sunburst's cramped depth — each
   * mode now recalls the depth the user last used with IT. */
  modeDepths: Partial<Record<Mode, number>>;
  setMode: (mode: Mode) => void;
  setColorMode: (colorMode: ColorMode) => void;
  setDepth: (depth: number) => void;
  setAbbreviate: (on: boolean) => void;
  setTopScope: (scope: TopScope) => void;
}

/** Dev-hook seeding (§15 DISKBYTES_MODE). */
function seedMode(): Mode {
  const hook = (window as unknown as { __DB_DEV_MODE__?: string }).__DB_DEV_MODE__;
  if (hook && (MODES as readonly string[]).includes(hook)) return hook as Mode;
  return "Folders";
}

export const useVizUiStore = create<VizUiState>((set, get) => ({
  mode: seedMode(),
  colorMode: "by-folder",
  depth: 7,
  abbreviate: false,
  topScope: "in-folder",
  modeDepths: {},
  setMode: (mode) => {
    // Persist the OUTGOING mode's current depth BEFORE switching: the
    // restore only worked after the user had touched the slider in the
    // target mode once — a first switch to an unvisited mode inherited
    // the previous mode's depth (Sunburst@9 → Treemap still @9).
    const prev = get().mode;
    const modeDepths = { ...get().modeDepths, [prev]: get().depth };
    const remembered = modeDepths[mode];
    set({ mode, modeDepths, ...(remembered != null ? { depth: remembered } : {}) });
  },
  setColorMode: (colorMode) => set({ colorMode }),
  setDepth: (depth) => {
    const d = Math.min(10, Math.max(2, Math.round(depth)));
    set({ depth: d, modeDepths: { ...get().modeDepths, [get().mode]: d } });
  },
  setAbbreviate: (abbreviate) => set({ abbreviate }),
  setTopScope: (topScope) => set({ topScope }),
}));
