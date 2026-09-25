/**
 * Explore header / mode toolbar (spec §7): icon-only mode capsule with
 * the active mode expanding its label (framer layoutId slide), caption,
 * color-mode segmented control (5 canvas modes), depth slider 2–10
 * (treemap/sunburst/flame), "A" abbreviate toggle; responsive degrade
 * via CSS breakpoints (caption → depth → wrap).
 */
import { motion } from "framer-motion";
import { AgeMapIcon, BubblesIcon, FolderIcon, FlamegraphIcon, ListTreeIcon, MindMapIcon, SunburstIcon, TopSizesIcon, TreemapIcon, type AnyIcon } from "../components/Icon";
import {
  COLORED_MODES, DEPTH_MODES, MODES, MODE_CAPTIONS, useVizUiStore, type Mode,
} from "../state/vizUi";
import { EVENTS, track } from "../lib/analytics";
import { SPRING_UI } from "../lib/motion";

const MODE_ICONS: Record<Mode, AnyIcon> = {
  Folders: FolderIcon,
  Treemap: TreemapIcon,
  Sunburst: SunburstIcon,
  Flame: FlamegraphIcon,
  Bubbles: BubblesIcon,
  "Mind Map": MindMapIcon,
  "Top Sizes": TopSizesIcon,
  "Age Map": AgeMapIcon,
  List: ListTreeIcon,
};

export function ExploreHeader() {
  const mode = useVizUiStore((s) => s.mode);
  const setMode = useVizUiStore((s) => s.setMode);
  const colorMode = useVizUiStore((s) => s.colorMode);
  const setColorMode = useVizUiStore((s) => s.setColorMode);
  const depth = useVizUiStore((s) => s.depth);
  const setDepth = useVizUiStore((s) => s.setDepth);
  const abbrev = useVizUiStore((s) => s.abbreviate);
  const setAbbrev = useVizUiStore((s) => s.setAbbreviate);

  return (
    <div className="db-toolbar-row" role="toolbar" aria-label="Visualization controls">
      <div className="db-mode-picker" role="group" aria-label="Mode">
        {MODES.map((m) => {
          const Icon = MODE_ICONS[m];
          return (
            <button
              key={m}
              type="button"
              data-active={mode === m}
              onClick={() => {
                setMode(m);
                track(EVENTS.vizModeSelected, { mode: m });
              }}
              title={m}
              aria-label={m}
            >
              {mode === m && <motion.span layoutId="db-mode-pill" className="db-mode-pill" transition={SPRING_UI} />}
              <Icon size={15} />
              {mode === m && <span>{m}</span>}
            </button>
          );
        })}
      </div>

      {COLORED_MODES.has(mode) && (
        <div className="db-segmented" role="group" aria-label="Color mode">
          {(["by-folder", "by-type", "by-age"] as const).map((c) => (
            <button
              key={c}
              type="button"
              data-active={colorMode === c}
              onClick={() => {
                setColorMode(c);
                track(EVENTS.colorModeChanged, { mode: c });
              }}
            >
              {c === "by-folder" ? "By folder" : c === "by-type" ? "By type" : "By age"}
            </button>
          ))}
        </div>
      )}

      {DEPTH_MODES.has(mode) && (
        <label className="db-depth" aria-label={`Depth ${depth}`}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden focusable="false">
            <path d="M4 14v-2a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2" /><path d="M12 10V6" /><circle cx="12" cy="4" r="2" /><circle cx="6" cy="16" r="2" /><circle cx="18" cy="16" r="2" />
          </svg>
          <input
            type="range"
            min={2}
            max={10}
            value={depth}
            onChange={(e) => {
              setDepth(Number(e.target.value));
              track(EVENTS.depthSliderMoved, { depth: Number(e.target.value) });
            }}
          />
          <b className="tnum">{depth}</b>
        </label>
      )}

      <p className="db-toolbar-caption">{MODE_CAPTIONS[mode]}</p>

      {/* "A" abbreviate is a canvas-label-density feature (spec §7): tiny
       * treemap/sunburst cells collide, so names compress to initials.
       * List / Top Sizes rows are full-width — abbreviating there would
       * destroy information for no space gain, so the toggle is
       * canvas-only (it used to render for lists but did nothing). */}
      {COLORED_MODES.has(mode) && (
        <button
          type="button"
          className="db-abbreviate"
          data-active={abbrev}
          onClick={() => setAbbrev(!abbrev)}
          title="Toggle abbreviated labels"
          aria-pressed={abbrev}
        >
          A
        </button>
      )}
    </div>
  );
}
