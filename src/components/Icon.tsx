/**
 * DiskBytes icon system.
 *
 * Standard glyphs are re-exported from **lucide-react** — the professional,
 * MIT-licensed icon set (Feather/Lucide, 24×24 grid, stroke 2, round
 * caps/joins, currentColor) — so every generic icon is a pixel-exact,
 * industry-standard render instead of a hand-drawn approximation.
 *
 * Two groups remain purpose-drawn (no lucide equivalent exists):
 *   1. View-mode pictograms (treemap / sunburst / bubbles / mind-map) —
 *      geometric chart glyphs drawn to the same 24-grid / stroke language.
 *   2. Windows caption glyphs (minimize / maximize / restore / close) —
 *      the exact Windows 11 caption geometry (thin 1.7 stroke, square
 *      corners, L-clipped restore square).
 */
import type { ComponentType, SVGProps } from "react";
import {
  Activity as ActivityIcon, AppWindow as AppWindowIcon, Archive as ArchiveIcon,
  ArrowDown as ArrowDownIcon, ArrowUp as ArrowUpIcon, Box as BoxIcon,
  CalendarClock as CalendarClockIcon, Camera as CameraIcon, Check as CheckIcon,
  ChevronDown as ChevronDownIcon, ChevronLeft as ChevronLeftIcon,
  ChevronRight as ChevronRightIcon, ChevronsRightLeft as ChevronsRightLeftIcon,
  CircleDot as CircleDotIcon, Clock3 as Clock3Icon, Cloud as CloudIcon,
  Copy as CopyIcon, Cpu as CpuIcon, Database as DatabaseIcon,
  ExternalLink as ExternalLinkIcon, Eye as EyeIcon,
  File as FileIcon, FileArchive as FileArchiveIcon, FileAudio as FileAudioIcon,
  FileCode2 as FileCode2Icon, FileImage as FileImageIcon, FileText as FileTextIcon,
  FileVideo as FileVideoIcon, Flame as FlameIcon, Folder as FolderIcon,
  FolderOpen as FolderOpenIcon, Gauge as GaugeIcon, Globe as GlobeIcon,
  Grid2x2 as Grid2x2Icon, Hammer as HammerIcon, HardDrive as HardDriveIcon,
  Home as HomeIcon, Key as KeyIcon, List as ListIcon,
  ListTree as ListTreeIcon, LockKeyhole as LockKeyholeIcon, LayoutGrid as LayoutGridIcon,
  Maximize2 as Maximize2Icon, MemoryStick as MemoryStickIcon, Minus as MinusIcon,
  Moon as MoonIcon, Network as NetworkIcon, PackageOpen as PackageOpenIcon,
  PanelRight as PanelRightIcon, Plus as PlusIcon, RefreshCw as RefreshCwIcon,
  ScanLine as ScanLineIcon, Search as SearchIcon, Settings as SettingsIcon,
  Shield as ShieldIcon, Smartphone as SmartphoneIcon, Sparkles as SparklesIcon,
  Square as SquareIcon, Sun as SunIcon, Trash2 as Trash2Icon, Wifi as WifiIcon,
  X as XIcon, Download as DownloadIcon,
} from "lucide-react";

export type IconProps = SVGProps<SVGSVGElement> & { size?: number | string };

/** Anything renderable as `<Icon size={n} />` — lucide glyphs and the
 *  purpose-drawn pictograms alike. */
export type AnyIcon = ComponentType<SVGProps<SVGSVGElement> & { size?: number | string }>;

/* ── View-mode pictograms (no lucide equivalent — drawn to the lucide
 *    grid: 24×24, stroke ~1.9, round caps/joins, currentColor).
 *    Each glyph depicts its VISUALIZATION, not the noun: the sunburst
 *    is segmented arcs (a radial chart, not a target), the flame view
 *    is a flamegraph icicle (stacked rows tapering upward, not fire),
 *    the age map is a heat grid (not a clock). ─────────────────────── */

/** Treemap — squarified nested rectangles of UNEQUAL area (the
 * classic treemap asymmetry: big left cell, stacked right column). */
export const TreemapIcon = ({ size = 16, ...p }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9}
    strokeLinecap="round" strokeLinejoin="round" width={size} height={size}
    aria-hidden focusable="false" {...p}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M10.75 3v18" />
    <path d="M10.75 10h10.25" />
    <path d="M3 14.75h7.75" />
  </svg>
);

/** Sunburst — segmented concentric arcs around a filled hub (a radial
 * chart: staggered arc segments with gaps — full rings would read as a
 * target/radar, not a sunburst). Geometry generated for staggered
 * angles: outer top-major 200°, outer lower-right 85°, inner
 * lower-left 95°. */
export const SunburstIcon = ({ size = 16, ...p }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9}
    strokeLinecap="round" width={size} height={size}
    aria-hidden focusable="false" {...p}>
    <path d="M3.73 13.46A8.4 8.4 0 1 1 20.27 13.46" />
    <path d="M19.27 16.2a8.4 8.4 0 0 1-10.82 3.41" />
    <path d="M9.55 16.24a4.9 4.9 0 0 1-1.56-7.05" />
    <circle cx="12" cy="12" r="1.9" fill="currentColor" stroke="none" />
  </svg>
);

/** Flame — the Flame view's glyph. Design history: an abstract
 * flamegraph/icicle stack was tried twice and failed VLM review at
 * 15 px both times (reads as Wi-Fi signal bars — the call-stack
 * metaphor needs color/labels to land). The mode is LABELED "Flame",
 * so the glyph maps 1:1 to the label; this is a purpose-drawn flame
 * (rounder bowl, shorter tip than lucide's, inner tongue) in the
 * family stroke language. */
export const FlamegraphIcon = ({ size = 16, ...p }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9}
    strokeLinecap="round" strokeLinejoin="round" width={size} height={size}
    aria-hidden focusable="false" {...p}>
    <path d="M12.4 2.9c-1.9 2.7-4.3 5-5.5 7.9-.9 2.2-1 4.6-.1 6.8a6.1 6.1 0 0 0 5.6 3.6h.3a6 6 0 0 0 5.5-3.7c.9-2.2.8-4.4-.2-6.6-.7-1.5-1.8-2.9-2.9-4.2-.7-.8-1.4-1.7-1.9-2.6-.2.6-.5 1.2-.8 1.6" />
    <path d="M12.3 19.7a3.1 3.1 0 0 1-3.1-3.1c0-1.7 1.2-2.6 1.9-3.9.4.9 1.2 1.6 1.9 2.3.7.8 1.4 1.6 1.4 2.7a3 3 0 0 1-2.1 2z" />
  </svg>
);

/** Bubbles — tangent-packed circles (Pythagoras-verified: the big and
 * medium kiss; the small one nestles in the remaining gap). */
export const BubblesIcon = ({ size = 16, ...p }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9}
    strokeLinecap="round" width={size} height={size}
    aria-hidden focusable="false" {...p}>
    <circle cx="9" cy="13.8" r="6.1" />
    <circle cx="17.2" cy="7.6" r="4.15" />
    <circle cx="10.5" cy="4.6" r="2.6" />
  </svg>
);

/** Mind map — organic radial tree: filled hub with curved branches
 * fanning out to leaf dots (asymmetric, like a sketched mind map). */
export const MindMapIcon = ({ size = 16, ...p }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9}
    strokeLinecap="round" strokeLinejoin="round" width={size} height={size}
    aria-hidden focusable="false" {...p}>
    <circle cx="7.2" cy="12" r="2.5" fill="currentColor" stroke="none" />
    <path d="M9.4 10.6c1.8-2 4.6-3.5 7.3-3.9" />
    <path d="M10 12h8.9" />
    <path d="M9.4 13.4c1.8 2 4.6 3.5 7.3 3.9" />
    <circle cx="18.9" cy="5.6" r="1.8" />
    <circle cx="20.3" cy="12" r="1.8" />
    <circle cx="18.9" cy="18.4" r="1.8" />
  </svg>
);

/** Top Sizes — ranked bars, biggest first (descending heights off a
 *  shared baseline — the reference's "bar chart" metaphor; grid-snap
 *  x positions and a slightly heavier stroke keep it crisp at 15 px). */
export const TopSizesIcon = ({ size = 16, ...p }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.1}
    strokeLinecap="round" width={size} height={size}
    aria-hidden focusable="false" {...p}>
    <path d="M6 19.5V8" /><path d="M12 19.5v-8" /><path d="M18 19.5v-5" />
    <path d="M3.5 19.5h17" />
  </svg>
);

/** Age Map — a heat grid: bold filled cells at STRONGLY graded
 * intensities (a subtle ramp reads as a generic app grid at 15 px —
 * VLM-verified; the diagonal hot pattern is the heatmap signature). */
export const AgeMapIcon = ({ size = 16, ...p }: IconProps) => (
  <svg viewBox="0 0 24 24" width={size} height={size}
    aria-hidden focusable="false" {...p}>
    <rect x="1.6" y="5" width="6.2" height="6.2" rx="1.6" fill="currentColor" opacity="1" />
    <rect x="8.9" y="5" width="6.2" height="6.2" rx="1.6" fill="currentColor" opacity="0.4" />
    <rect x="16.2" y="5" width="6.2" height="6.2" rx="1.6" fill="currentColor" opacity="0.8" />
    <rect x="1.6" y="12.2" width="6.2" height="6.2" rx="1.6" fill="currentColor" opacity="0.55" />
    <rect x="8.9" y="12.2" width="6.2" height="6.2" rx="1.6" fill="currentColor" opacity="1" />
    <rect x="16.2" y="12.2" width="6.2" height="6.2" rx="1.6" fill="currentColor" opacity="0.3" />
  </svg>
);

/* ── Windows caption glyphs (Windows 11 geometry: thin square-corner
 *    strokes on the 24 grid; sized/centered like Segoe Fluent caption
 *    icons so the chrome reads native) ───────────────────────────────── */

export const CaptionMinimizeIcon = ({ size = 16, ...p }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}
    strokeLinecap="round" width={size} height={size} aria-hidden focusable="false" {...p}>
    <path d="M5.5 12h13" />
  </svg>
);

export const CaptionMaximizeIcon = ({ size = 16, ...p }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}
    width={size} height={size} aria-hidden focusable="false" {...p}>
    <rect x="5.5" y="5.5" width="13" height="13" />
  </svg>
);

export const CaptionRestoreIcon = ({ size = 16, ...p }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}
    width={size} height={size} aria-hidden focusable="false" {...p}>
    {/* back square, clipped to the L visible around the front square */}
    <path d="M14.5 5H5v9.5h5" />
    {/* front square */}
    <rect x="10" y="10" width="9" height="9" />
  </svg>
);

export const CaptionCloseIcon = ({ size = 16, ...p }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}
    strokeLinecap="round" width={size} height={size} aria-hidden focusable="false" {...p}>
    <path d="M6 6l12 12" /><path d="M18 6L6 18" />
  </svg>
);

/* ── Windows system glyphs ────────────────────────────────────────── */

/** UAC shield — the Windows 11 "administrator rights" mark (the four
 * quadrant security shield from imageres.dll, Fluent flat style). Any
 * elevation affordance ("Restart as administrator") wears THIS icon:
 * it is the shape Windows users have been trained to read as
 * "this will show a UAC prompt". Drawn quadrant-by-quadrant (no
 * clipPath — no duplicate-id hazard across instances). */
export const UacShieldIcon = ({ size = 16, ...p }: IconProps) => (
  <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden focusable="false" {...p}>
    {/* shield silhouette: center peak, sloped shoulders, curved V bottom */}
    <path d="M12 1.6 4.1 4.2 V11 C4.1 16 7.5 20.2 12 22.3 C16.5 20.2 19.9 16 19.9 11 V4.2 Z"
      fill="#39424E" fillOpacity="0.28" />
    <path d="M12 2.3 4.8 4.6 V11 C4.8 15.6 7.8 19.3 12 21.2 Z" fill="#0078D4" />
    <path d="M12 2.3 19.2 4.6 V11 C19.2 15.6 16.2 19.3 12 21.2 Z" fill="#7FBA00" />
    <path d="M5.2 11.4 C5.9 15 8.4 18 12 19.3 V11.4 Z" fill="#FFB900" />
    <path d="M18.8 11.4 C18.1 15 15.6 18 12 19.3 V11.4 Z" fill="#E81123" />
    <path d="M12 1.6 4.1 4.2 V11 C4.1 16 7.5 20.2 12 22.3 C16.5 20.2 19.9 16 19.9 11 V4.2 Z"
      fill="none" stroke="#39424E" strokeWidth="1.1" strokeLinejoin="round" />
  </svg>
);

/** Legacy composite (kept for the Snapshots header art) — a copy square. */
export const CopySquareIcon = ({ size = 16, ...p }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
    strokeLinecap="round" strokeLinejoin="round" width={size} height={size}
    aria-hidden focusable="false" {...p}>
    <path d="M10 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6c0-1.1.9-2 2-2h2" />
    <rect width="8" height="8" x="8" y="8" rx="1" />
  </svg>
);

export {
  ActivityIcon, AppWindowIcon, ArchiveIcon, ArrowDownIcon, ArrowUpIcon,
  BoxIcon, CalendarClockIcon, CameraIcon, CheckIcon, ChevronDownIcon,
  ChevronLeftIcon, ChevronRightIcon, ChevronsRightLeftIcon, CircleDotIcon,
  Clock3Icon, CloudIcon, CopyIcon, CpuIcon, DatabaseIcon, DownloadIcon,
  ExternalLinkIcon, EyeIcon, FileArchiveIcon, FileAudioIcon, FileCode2Icon,
  FileIcon, FileImageIcon, FileTextIcon, FileVideoIcon, FlameIcon,
  FolderIcon, FolderOpenIcon, GaugeIcon, GlobeIcon, Grid2x2Icon, HammerIcon,
  HardDriveIcon, HomeIcon, KeyIcon, LayoutGridIcon, ListIcon, ListTreeIcon,
  LockKeyholeIcon, Maximize2Icon, MemoryStickIcon, MinusIcon, MoonIcon,
  NetworkIcon, PackageOpenIcon, PanelRightIcon, PlusIcon, RefreshCwIcon,
  ScanLineIcon, SearchIcon, SettingsIcon, ShieldIcon, SmartphoneIcon,
  SparklesIcon, SquareIcon, SunIcon, Trash2Icon, WifiIcon, XIcon,
};

/** Category label (Rust `FileCategory::label`) → icon component. */
export function categoryIcon(label: string): AnyIcon {
  switch (label) {
    case "Video": return FileVideoIcon;
    case "Audio": return FileAudioIcon;
    case "Images": return FileImageIcon;
    case "Documents": return FileTextIcon;
    case "Developer": return FileCode2Icon;
    case "Archives": return FileArchiveIcon;
    case "Applications": return AppWindowIcon;
    case "System": return CpuIcon;
    default: return FileIcon;
  }
}

/** By-folder tone key from the layout color (index into the 8 families). */
export const TONE_KEYS = ["blue", "mint", "violet", "amber", "rose", "green", "sky", "slate"] as const;
export type ToneKey = (typeof TONE_KEYS)[number];
