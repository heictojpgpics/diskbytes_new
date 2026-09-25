/**
 * CanvasViz (spec §7 rendering performance): the heavy static layer is
 * painted ONCE per layout on one canvas; the hover highlight + selection
 * ring live on a separate overlay canvas driven by refs — mouse moves
 * NEVER re-render React or repaint the static layer. devicePixelRatio
 * and ResizeObserver are handled; hit-testing is local JS geometry.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useArrowNav } from "../lib/useArrowNav";
import { bytes } from "../lib/format";
import { abbreviate } from "./abbrev";
import {
  CELL_KIND, DIR_BIT, cssRgbaTheme, getLayout, getNames, type Cell, type GroupDesc, type LayoutResult,
} from "./layoutIpc";

/** Synthetic regroup ids (by-type/by-age group cells) live at/above this
 * base — they are NOT tree nodes; their display names come from
 * LayoutMeta.groups, never from `get_names` (which resolves them to ""). */
const SYNTH_BASE = 0xffff0000;

/** Resolve label names for a layout: synthetic group ids map from the
 * layout's own group legend (client-side); real ids batch through
 * `get_names`. Keeps group cells labeled AND keeps synthetic ids out of
 * the IPC round trip. */
async function resolveNames(
  generation: number,
  cells: Cell[],
  groups: GroupDesc[],
  mode: string,
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  for (const g of groups) out.set(g.id, g.name);
  const realIds: number[] = [];
  for (const c of cells) {
    if (c.id >= SYNTH_BASE) continue;
    if (out.has(c.id)) continue;
    if (!labelable(c, mode)) continue;
    realIds.push(c.id);
  }
  if (realIds.length > 0) {
    const fetched = await getNames(generation, realIds.slice(0, 400)).catch(
      () => new Map<number, string>(),
    );
    for (const [k, v] of fetched) out.set(k, v);
  }
  return out;
}

export interface CanvasVizProps {
  generation: number;
  node: number;
  mode: "treemap" | "sunburst" | "flame" | "bubbles" | "mind-map";
  colorMode: "by-folder" | "by-type" | "by-age";
  depth: number;
  abbreviateLabels: boolean;
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  onOpen: (id: number) => void;
  onContextMenu: (id: number, x: number, y: number) => void;
  onHover: (id: number | null, x: number, y: number) => void;
}

const ON_PASTEL = "#0F172A";
const ON_PASTEL_2 = "#475569";

interface ThemeColors {
  border: string;
  bg: string;
}

function readTheme(): ThemeColors {
  const cs = getComputedStyle(document.documentElement);
  return {
    border: cs.getPropertyValue("--border").trim() || "#d8d8dd",
    bg: cs.getPropertyValue("--background").trim() || "#ffffff",
  };
}

export function CanvasViz(props: CanvasVizProps) {
  const { generation, node, mode, colorMode, depth } = props;
  const shellRef = useRef<HTMLDivElement>(null);
  const staticRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [layout, setLayout] = useState<LayoutResult | null>(null);
  const loadError = useRef<string | null>(null);
  const hoverCell = useRef<Cell | null>(null);
  const theme = useRef<ThemeColors>(readTheme());
  // Paint support refs: layoutRef/namesRef let late repaints (theme
  // flip, DPR migration) draw WITH labels without another IPC pass;
  // paintToken cancels the previous async name-resolution before a new
  // paint starts (an out-of-order .then could otherwise paint an OLD
  // layout over a newer one — the mode-switch race).
  const layoutRef = useRef<LayoutResult | null>(null);
  const namesRef = useRef<Map<number, string>>(new Map());
  const repaintRef = useRef<(() => void) | null>(null);
  const paintTokenRef = useRef<{ cancelled: boolean }>({ cancelled: false });

  // ResizeObserver: SHELL size tracks IMMEDIATELY (every event — the
  // GPU transform below follows the sidebar/inspector transitions
  // frame-perfect); FETCH size trails by a 120 ms settle debounce (IPC
  // churn guard). The first observation applies to both. Gating the
  // mount measurement behind the debounce added ~120 ms of blank
  // canvas to every mode switch (CI tour frames 03/05 caught it).
  const [fetchSize, setFetchSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = shellRef.current;
    if (!el) return;
    let t: number | null = null;
    let first = true;
    const apply = (w: number, h: number) => {
      setSize({ w: Math.floor(w), h: Math.floor(h) });
      setFetchSize({ w: Math.floor(w), h: Math.floor(h) });
    };
    const ro = new ResizeObserver((entries) => {
      const e = entries[0];
      if (!e) return;
      if (first) {
        first = false;
        apply(e.contentRect.width, e.contentRect.height);
        return;
      }
      // Immediate shell tracking (transform/hit geometry stay live):
      setSize({ w: Math.floor(e.contentRect.width), h: Math.floor(e.contentRect.height) });
      if (t !== null) window.clearTimeout(t);
      t = window.setTimeout(
        () => setFetchSize({ w: Math.floor(e.contentRect.width), h: Math.floor(e.contentRect.height) }),
        120,
      );
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (t !== null) window.clearTimeout(t);
    };
  }, []);

  // Theme tracking (repaint when data-theme flips). Subscribes ONCE —
  // reads through refs. (The old effect had no dep array and
  // re-subscribed a fresh MutationObserver on every render.)
  useEffect(() => {
    const obs = new MutationObserver(() => {
      theme.current = readTheme();
      repaintRef.current?.();
    });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);

  // DPR migration: dragging the window across a monitor with a
  // different scale leaves the backing store at the old ratio — every
  // stroke stays blurry until the next layout change. Watch a
  // resolution media query and repaint. The query is REBUILT on every
  // change event: a query matches the CURRENT dppx, so a stale query
  // only fires once (1×→2×) and would miss 2×→3× — re-arming after
  // each event tracks any number of migrations.
  useEffect(() => {
    let mq: MediaQueryList | null = null;
    const arm = () => {
      mq?.removeEventListener("change", onChange);
      mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      mq.addEventListener("change", onChange);
    };
    const onChange = () => {
      repaintRef.current?.();
      arm();
    };
    arm();
    return () => {
      mq?.removeEventListener("change", onChange);
    };
  }, []);

  // Canvas (re)mount repaint: the canvases unmount below 40px and
  // remount above; if the size returns to the EXACT same w×h, the
  // layout cache-hit returns the identical object, `setLayout` bails
  // and the paint effect never re-runs — the fresh canvas would stay
  // blank (pointer hit-testing kept working; only the paint was lost).
  const canvasMounted = size.w >= 40 && size.h >= 40;
  useEffect(() => {
    if (canvasMounted) repaintRef.current?.();
  }, [canvasMounted]);

  // Layout fetch (keyed on the DEBOUNCED size — one IPC per resize
  // settle, not one per intermediate frame).
  const reqKey = `${generation}:${node}:${mode}:${fetchSize.w}x${fetchSize.h}:${depth}:${colorMode}`;
  const [errorText, setErrorText] = useState<string | null>(null);
  useEffect(() => {
    if (fetchSize.w < 40 || fetchSize.h < 40) return;
    let disposed = false;
    loadError.current = null;
    setErrorText(null);
    void (async () => {
      let res: Awaited<ReturnType<typeof getLayout>>;
      try {
        res = await getLayout({
          generation,
          node,
          mode,
          width: fetchSize.w,
          height: fetchSize.h,
          depth,
          color: colorMode,
        });
      } catch (e) {
        // Surface the failure — a silently blank canvas is
        // undiagnosable from CI screenshots (this is exactly how the
        // blank-treemap bug hid for two runs).
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[viz] layout failed:", msg);
        if (!disposed) setErrorText(msg);
        return;
      }
      if (disposed) return;
      if (!res) {
        loadError.current = "stale";
        return;
      }
      // Batch-fetch labels for the biggest cells (spec: get_names batched).
      // Synthetic group cells resolve client-side from the group legend.
      // The resolved map is KEPT (namesRef) so the static paint draws
      // labels in its FIRST pass — no labelless first frame, no label
      // pop-in flicker, no second full-scene paint.
      const names = await resolveNames(generation, res.cells, res.meta.groups, mode).catch(
        () => new Map<number, string>(),
      );
      if (disposed) return;
      namesRef.current = names;
      setLayout(res);
    })();
    return () => {
      disposed = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reqKey, fetchSize.w, fetchSize.h]);

  const cellsById = useMemo(() => {
    const m = new Map<number, Cell>();
    if (layout) for (const c of layout.cells) m.set(c.id, c);
    return m;
  }, [layout]);

  // ── Rescale transform (the buttery resize) ───────────────────────
  // The shell resizes continuously (sidebar/inspector CSS transitions,
  // window edges); the layout data arrives for the DEBOUNCED size. In
  // between, the canvases GPU-scale to follow the shell — no frozen
  // bitmap tearing away from its container, no blank, no flicker — and
  // the fresh layout lands at scale 1. Pointer hits map back through
  // the same factors. `willChange: transform` keeps it compositor-only.
  const kx = layout && layout.meta.width > 0 ? size.w / layout.meta.width : 1;
  const ky = layout && layout.meta.height > 0 ? size.h / layout.meta.height : 1;
  const rescale =
    Math.abs(kx - 1) > 0.003 || Math.abs(ky - 1) > 0.003
      ? { transform: `scale(${kx}, ${ky})`, transformOrigin: "0 0", willChange: "transform" }
      : undefined;

  // ── Static paint (once per layout) ─────────────────────────────────
  // NOT keyed on selectedId: drawCells never reads it — the selection
  // ring lives on the overlay canvas. The old dep triggered a full
  // double-paint (plus a names IPC lookup) on every click.
  useEffect(() => {
    const s = staticRef.current;
    if (!s || !layout || size.w < 40) return;
    layoutRef.current = layout;
    paintTokenRef.current.cancelled = true;
    const token = { cancelled: false };
    paintTokenRef.current = token;
    const run = () => paint(s, layout, props, namesRef.current, token);
    repaintRef.current = run;
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, props.abbreviateLabels]);

  // ── Overlay: hover + selection rings ───────────────────────────────
  // `ringAlpha` powers the 120 ms fade-in: rings used to appear as hard
  // instant cuts — the only surface in the app without a transition.
  // rAF-driven (the overlay is already ref-driven; no React state).
  // The overlay canvas lives in LAYOUT coordinates exactly like the
  // static one (bitmap + CSS at layout dims; the rescale transform in
  // the JSX follows the shell) — rings stay glued to their cells at
  // every shell size, including mid-transition.
  const paintOverlay = useCallback(
    (ringAlpha = 1) => {
      const o = overlayRef.current;
      if (!o || !layout) return;
      const dpr = window.devicePixelRatio || 1;
      const w = layout.meta.width;
      const h = layout.meta.height;
      const bw = Math.round(w * dpr);
      const bh = Math.round(h * dpr);
      // Resize on width OR height change — a height-only change (sidebar
      // wrap, banner) used to leave a stale backing-store height.
      if (o.width !== bw || o.height !== bh) {
        o.width = bw;
        o.height = bh;
      }
      o.style.width = `${w}px`;
      o.style.height = `${h}px`;
      const ctx = o.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      // selection ring (user action): coral outer stroke + a refined thin
      // white inner stroke (reference's selected-cell double-ring).
      const sel = props.selectedId != null ? cellsById.get(props.selectedId) : undefined;
      if (sel) {
        ctx.strokeStyle = `rgba(255,107,74,${0.95 * ringAlpha})`;
        ctx.lineWidth = 2.5;
        ringPath(ctx, sel, layout, mode);
        ctx.strokeStyle = `rgba(255,255,255,${0.85 * ringAlpha})`;
        ctx.lineWidth = 1;
        ringPath(ctx, sel, layout, mode, 3);
      }
      // hover ring (overlay canvas only — never React state): the
      // selection's double-ring language at a neutral tone — white
      // outer + ink inner reads on BOTH themes (the old single
      // near-black ring vanished against the dark canvas background
      // and was confusable with cell hairlines at 1× zoom).
      // Sunburst arcs additionally get a soft WEDGE FILL — a 1.5px ring
      // alone barely registers on a thin arc; the translucent fill
      // makes the whole wedge light up (hover = "this slice", not
      // "this edge").
      const hv = hoverCell.current;
      if (hv && hv !== sel) {
        if (mode === "sunburst" && (hv.flags & 0b111) === CELL_KIND.ARC) {
          const darkOverlay =
            document.documentElement.getAttribute("data-theme") === "dark";
          ringPathTrace(ctx, hv, layout);
          ctx.fillStyle = darkOverlay
            ? `rgba(255,255,255,${0.13 * ringAlpha})`
            : `rgba(29,29,31,${0.09 * ringAlpha})`;
          ctx.fill();
        }
        ctx.strokeStyle = `rgba(255,255,255,${0.9 * ringAlpha})`;
        ctx.lineWidth = 2;
        ringPath(ctx, hv, layout, mode);
        ctx.strokeStyle = `rgba(29,29,31,${0.75 * ringAlpha})`;
        ctx.lineWidth = 1;
        ringPath(ctx, hv, layout, mode, 1.5);
      }
    },
    [layout, props.selectedId, cellsById, mode],
  );

  // Ring fade-in (120 ms, ease-out). Skipped under reduced motion.
  const ringAnim = useRef<number | null>(null);
  const fadeRingsIn = useCallback(() => {
    if (ringAnim.current != null) cancelAnimationFrame(ringAnim.current);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      paintOverlay(1);
      return;
    }
    const start = performance.now();
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / 120);
      paintOverlay(0.2 + 0.8 * (1 - (1 - k) * (1 - k))); // easeOutQuad from 0.2
      if (k < 1) ringAnim.current = requestAnimationFrame(step);
      else ringAnim.current = null;
    };
    ringAnim.current = requestAnimationFrame(step);
  }, [paintOverlay]);
  useEffect(() => {
    fadeRingsIn();
    return () => {
      if (ringAnim.current != null) cancelAnimationFrame(ringAnim.current);
    };
  }, [fadeRingsIn]);

  // ── Pointer events (refs only — no React state on move) ────────────
  // Pointer coordinates arrive in SHELL space; cells live in LAYOUT
  // space. The rescale transform maps layout→shell, so the inverse
  // (÷ kx, ÷ ky) maps the hit back — hover/selection stay accurate at
  // every transient scale, not just at scale 1.
  useEffect(() => {
    const s = staticRef.current;
    if (!s || !layout) return;
    const ikx = kx || 1;
    const iky = ky || 1;
    const hit = (x: number, y: number): Cell | null => hitCell(layout.cells, mode, x / ikx, y / iky, layout.meta.center);
    const onMove = (e: PointerEvent) => {
      const r = s.getBoundingClientRect();
      const cell = hit(e.clientX - r.left, e.clientY - r.top);
      const prev = hoverCell.current;
      if (cell?.id !== prev?.id) {
        hoverCell.current = cell;
        fadeRingsIn();
        props.onHover(cell ? cell.id : null, e.clientX, e.clientY);
      } else if (cell) {
        props.onHover(cell.id, e.clientX, e.clientY);
      }
      s.style.cursor = cell ? "pointer" : "default";
    };
    const onLeave = () => {
      hoverCell.current = null;
      // Cancel any in-flight fade before the full repaint — a pending
      // rAF step would re-dim the selection ring for ~100 ms after.
      if (ringAnim.current != null) {
        cancelAnimationFrame(ringAnim.current);
        ringAnim.current = null;
      }
      paintOverlay(1);
      props.onHover(null, 0, 0);
    };
    const onDown = (e: PointerEvent) => {
      const r = s.getBoundingClientRect();
      const cell = hit(e.clientX - r.left, e.clientY - r.top);
      props.onSelect(cell ? cell.id : null);
    };
    const onDbl = (e: MouseEvent) => {
      const r = s.getBoundingClientRect();
      const cell = hit(e.clientX - r.left, e.clientY - r.top);
      if (cell && (cell.flags & DIR_BIT) !== 0) props.onOpen(cell.id);
    };
    const onCtx = (e: MouseEvent) => {
      const r = s.getBoundingClientRect();
      const cell = hit(e.clientX - r.left, e.clientY - r.top);
      if (cell) {
        e.preventDefault();
        props.onContextMenu(cell.id, e.clientX, e.clientY);
      }
    };
    s.addEventListener("pointermove", onMove);
    s.addEventListener("pointerleave", onLeave);
    s.addEventListener("pointerdown", onDown);
    s.addEventListener("dblclick", onDbl);
    s.addEventListener("contextmenu", onCtx);
    return () => {
      s.removeEventListener("pointermove", onMove);
      s.removeEventListener("pointerleave", onLeave);
      s.removeEventListener("pointerdown", onDown);
      s.removeEventListener("dblclick", onDbl);
      s.removeEventListener("contextmenu", onCtx);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, mode, fadeRingsIn, paintOverlay, kx, ky]);

  // ── Keyboard access (canvas parity with the DOM modes) ─────────────
  // The 5 canvas modes had NO keyboard path — selection/open was
  // pointer-only. Same contract as List/Folders: ↑/↓ walk the biggest
  // cells (size-desc, capped like Top Sizes), Enter opens folders,
  // and useArrowNav already suppresses while overlays are open.
  const navCells = useMemo(() => {
    if (!layout) return [] as Cell[];
    const arr = layout.cells.filter(
      (c) => c.id < SYNTH_BASE && (c.flags & 0b111) !== CELL_KIND.HEADER,
    );
    arr.sort((a, b) => b.size - a.size);
    return arr.slice(0, 200);
  }, [layout]);
  useArrowNav({
    count: navCells.length,
    selectedId: props.selectedId,
    idOf: (i) => navCells[i]?.id ?? -1,
    onMove: (i) => {
      const c = navCells[i];
      if (c) props.onSelect(c.id);
    },
    onActivate: (i) => {
      const c = navCells[i];
      if (c && (c.flags & DIR_BIT) !== 0) props.onOpen(c.id);
    },
  });

  return (
    <div className="db-viz-wrap">
      <div ref={shellRef} className="db-viz-canvas-shell">
        {size.w >= 40 && size.h >= 40 && <canvas ref={staticRef} style={rescale} />}
        {size.w >= 40 && size.h >= 40 && (
          <canvas ref={overlayRef} className="db-overlay-canvas" style={rescale} />
        )}
        {errorText && (
          <div className="db-viz-error" role="alert">
            <strong>Couldn’t load this view.</strong>
            <span>{errorText}</span>
          </div>
        )}
      </div>
      <div className="db-viz-foot">
        <div className="db-viz-groups">
          {layout?.meta.groups.slice(0, 6).map((g) => (
            <span key={g.id}>
              {/* Theme-matched chip: the canvas cells saturate in dark
               * mode (cssRgbaTheme); the chips used the raw pastel and
               * read washed-out next to them. */}
              <i style={{ background: cssRgbaTheme((g.color << 8) | 0xff, document.documentElement.getAttribute("data-theme") === "dark") }} />
              {g.name}
            </span>
          ))}
        </div>
        <span className="tnum">
          {layout ? `${layout.meta.cellCount.toLocaleString()} cells` : "…"}
          {layout?.meta.truncated ? " (truncated)" : ""}
        </span>
      </div>
    </div>
  );
}

/** Which cells deserve labels (bounded — spec ≤20k cells, label the big). */
function labelable(c: Cell, mode: string): boolean {
  const kind = c.flags & 0b111;
  // Header strips ARE the treemap's folder labels — the engine reserves
  // the 14px band precisely to carry the name. Width-gated (the engine
  // only emits headers ≥42px wide; the gate keeps group header parity).
  if (kind === CELL_KIND.HEADER) return c.g[2] >= 42;
  if (mode === "treemap" || mode === "flame") {
    return c.g[2] >= 36 && c.g[3] >= 15;
  }
  if (mode === "bubbles" || mode === "mind-map") {
    // Prefetch wider than the render gate (bubbles render labels from
    // r≥12; mind-map dots from r≥13) so the repaint always has names.
    return c.g[2] >= 12;
  }
  if (mode === "sunburst") {
    // Arc labels use the same span/ring gates as the draw paths
    // (along-ring OR radial) — the old blanket `false` left the names
    // map EMPTY, so no arc (or the center disc's root name) ever
    // rendered a label.
    if (kind === CELL_KIND.ARC) return c.g[1] - c.g[0] > 0.04 && c.g[3] - c.g[2] > 13;
    return kind === CELL_KIND.CIRCLE; // the center disc carries the root name
  }
  return false;
}

/** Paint the static layer.
 *
 * Draws IN ONE PASS with `preloaded` names when available (the layout
 * fetch resolves names before setLayout, so the common path carries
 * every label on the first frame — no labelless flash, no pop-in).
 * When names are missing (cold cache / IPC failure) it falls back to
 * the async resolve + single redraw, guarded by `token` so a superseded
 * paint can never draw an old layout over a newer one.
 */
function paint(
  canvas: HTMLCanvasElement,
  layout: LayoutResult,
  props: CanvasVizProps,
  preloaded: Map<number, string> | null,
  token: { cancelled: boolean },
): void {
  const dpr = window.devicePixelRatio || 1;
  const w = layout.meta.width;
  const h = layout.meta.height;
  const bw = Math.round(w * dpr);
  const bh = Math.round(h * dpr);
  // Resize on width OR height change — height-only changes (banner,
  // sidebar wrap) used to leave a stale backing-store height.
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const mode = layout.meta.mode;
  const cx = layout.meta.center?.[0] ?? w / 2;
  const cy = layout.meta.center?.[1] ?? h / 2;

  const names = preloaded ?? new Map<number, string>();
  drawCells(ctx, layout, props, names, w, h, cx, cy);

  // Cold-cache fallback: any labelable id inside the resolveNames fetch
  // cap still missing → resolve async and redraw once (token-guarded).
  // Count, don't break at the first miss: the cap mirrors resolveNames'
  // slice(0, 400) — a miss BEYOND it will never resolve, so only the
  // first 400 misses trigger the async pass.
  let missing = false;
  let seen = 0;
  for (const c of layout.cells) {
    if (c.id >= SYNTH_BASE) continue;
    if (names.has(c.id)) continue;
    if (!labelable(c, mode)) continue;
    seen++;
    if (seen > 400) break;
    missing = true;
  }
  if (missing) {
    void resolveNames(layout.meta.generation, layout.cells, layout.meta.groups, mode).then(
      (resolved) => {
        if (token.cancelled) return;
        // Sunburst also gets its root name for the center disc.
        if (mode === "sunburst" && !resolved.has(layout.meta.node)) {
          void getNames(layout.meta.generation, [layout.meta.node]).then((root) => {
            if (token.cancelled) return;
            const n = root.get(layout.meta.node);
            if (n) {
              resolved.set(layout.meta.node, n);
              drawCells(ctx, layout, props, resolved, w, h, cx, cy);
            }
          });
        }
        drawCells(ctx, layout, props, resolved, w, h, cx, cy);
      },
    );
  } else if (mode === "sunburst" && !names.has(layout.meta.node)) {
    // Names were complete but the sunburst root id is not labelable by
    // the generic gate — fetch it for the center disc.
    void getNames(layout.meta.generation, [layout.meta.node]).then((root) => {
      if (token.cancelled) return;
      const n = root.get(layout.meta.node);
      if (n) {
        names.set(layout.meta.node, n);
        drawCells(ctx, layout, props, names, w, h, cx, cy);
      }
    });
  }
}

/** The UI font family (canvas text needs it as a string). */
function uiFont(): string {
  return getComputedStyle(document.documentElement).getPropertyValue("--font-ui") || "system-ui";
}

/** Draw text with a soft halo so labels stay legible over ANY pastel
 *  fill (the audit's contrast complaint: dark text on mid-tone pastels
 *  failed the squint test). Halo first, then the ink. */
function haloText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  ink: string,
): void {
  ctx.save();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = "rgba(255,255,255,0.55)";
  ctx.lineJoin = "round";
  ctx.strokeText(text, x, y);
  ctx.fillStyle = ink;
  ctx.fillText(text, x, y);
  ctx.restore();
}

function drawCells(
  ctx: CanvasRenderingContext2D,
  layout: LayoutResult,
  props: CanvasVizProps,
  names: Map<number, string>,
  w: number,
  h: number,
  cx: number,
  cy: number,
): void {
  const mode = layout.meta.mode;
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--border").trim() || "#d8d8dd";
  // Font family read ONCE per pass — the old per-label uiFont() calls
  // each hit getComputedStyle (a style-recalc flush per labelable
  // cell, thousands per repaint on big layouts).
  const fontUi = getComputedStyle(document.documentElement).getPropertyValue("--font-ui") || "system-ui";
  // Mind-map dot labels defer to a collision-aware pass (biggest dot
  // first, overlapping labels dropped — the engine docs' "biggest-first,
  // skipping collisions" promise; the inline draw collided freely).
  const pendingDotLabels: { x: number; y: number; w: number; r: number; text: string }[] = [];
  // Bubble labels defer the same way: mid bubbles cluster tangentially
  // and their centered labels collided across bubbles (VLM merged
  // "Program Files" + "JetBrains" into "Pro Jet..."). Bigger bubbles win.
  const pendingCircleLabels: {
    x: number;
    cy: number;
    w: number;
    h: number;
    r: number;
    draw: () => void;
  }[] = [];
  // Deferred bubble rims (two-pass rendering — see CIRCLE branch).
  const circleRims: number[] = [];

  // mind-map: draw links first — each takes the CHILD's own family color
  // at ~45% opacity (reference: colored bezier links, not uniform gray).
  if (mode === "mind-map") {
    for (const c of layout.cells) {
      if ((c.flags & 0b111) !== CELL_KIND.DOT) continue;
      const [x, y, r, px, py] = c.g;
      const lr = (c.rgba >>> 24) & 0xff;
      const lg = (c.rgba >>> 16) & 0xff;
      const lb = (c.rgba >>> 8) & 0xff;
      ctx.strokeStyle = `rgba(${lr},${lg},${lb},0.55)`;
      // Weight ∝ child dot radius (structure reads at a glance), and
      // links TERMINATE at the dot edges instead of passing through
      // the bodies (trimmed along the parent→child direction).
      ctx.lineWidth = Math.min(3.5, Math.max(0.8, 0.8 + r / 10));
      const dx = x - px;
      const dy = y - py;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      const hub = c.id === layout.meta.node ? 0 : 0;
      const startX = px + ux * 0; // parent trim handled by its own link
      const startY = py + uy * 0;
      const endX = x - ux * (r + 1.5);
      const endY = y - uy * (r + 1.5);
      ctx.beginPath();
      const mx = (x + px) / 2 + (y - py) * 0.12;
      const my = (y + py) / 2 - (x - px) * 0.12;
      ctx.moveTo(startX, startY);
      ctx.quadraticCurveTo(mx, my, endX, endY);
      ctx.stroke();
      void hub;
    }
  }
  // sunburst: subtle ring separators — ONE circle per DISTINCT ring
  // boundary (the old loop drew only the first ARC's outer radius and
  // broke: ring 1 got a separator, every deeper ring had none).
  if (mode === "sunburst") {
    ctx.strokeStyle = bg;
    ctx.lineWidth = 0.8;
    const radii = new Set<number>();
    for (const c of layout.cells) {
      if ((c.flags & 0b111) !== CELL_KIND.ARC) continue;
      if (!radii.has(c.g[3])) {
        radii.add(c.g[3]);
        ctx.beginPath();
        ctx.arc(cx, cy, c.g[3], 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  // Dark theme: enrich the pastel families (saturation boost at
  // constant lightness) — see cssRgbaTheme. Read once per paint.
  const darkCells = document.documentElement.getAttribute("data-theme") === "dark";
  for (const c of layout.cells) {
    const kind = c.flags & 0b111;
    const fill = cssRgbaTheme(c.rgba, darkCells);
    if (kind === CELL_KIND.HEADER) {
      // Treemap folder title strip — the engine reserves a 14px band
      // above the children for exactly this. The renderer used to skip
      // kind 4 entirely, so production showed a BLANK band and folder
      // names never appeared (the browser mock drew a plain RECT there,
      // masking the gap in dev). Draw it like a window title bar: the
      // family fill shaded one step deeper than the children, a
      // hairline bottom edge, and the folder name centered in the band.
      const [x, y, rw, rh] = c.g;
      ctx.fillStyle = fill;
      ctx.fillRect(x, y, rw, rh);
      // Shade: light theme mixes toward ink 10% (a readable title bar);
      // dark theme mixes toward white 8% (lifts the strip off the body).
      ctx.fillStyle = darkCells ? "rgba(255,255,255,0.08)" : "rgba(29,29,31,0.10)";
      ctx.fillRect(x, y, rw, rh);
      // Hairline edge between the strip and the children's body.
      ctx.fillStyle = "rgba(29,29,31,0.16)";
      ctx.fillRect(x, y + rh - 1, rw, 1);
      // Same white separator language as the RECT cells.
      if (rw >= 6) {
        ctx.strokeStyle = "rgba(255,255,255,0.55)";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x + 0.5, y + 0.5, rw - 1, rh - 1);
      }
      const name = names.get(c.id);
      if (name && rw >= 42) {
        const label = props.abbreviateLabels ? abbreviate(name) : name;
        const midY = y + rh / 2 + 0.5;
        ctx.textBaseline = "middle";
        ctx.textAlign = "left";
        ctx.font = `600 10px ${fontUi}`;
        // Name first (clipped to leave breathing room); size follows
        // right-aligned when the strip is wide enough for both.
        const nameText = clipLabel(ctx, label, rw - 10);
        if (nameText) haloText(ctx, nameText, x + 6, midY, ON_PASTEL);
        if (rw >= 176 && c.size > 0) {
          const sizeStr = bytes(c.size);
          ctx.font = `600 9.5px ${fontUi}`;
          const sizeText = clipLabel(ctx, sizeStr, Math.min(rw / 3, 84));
          if (sizeText) {
            const nw = nameText ? ctx.measureText(nameText).width : 0;
            const sw = ctx.measureText(sizeText).width;
            // Only when the two never collide; otherwise the name wins.
            if (x + 6 + nw + 10 + sw <= x + rw - 6) {
              ctx.textAlign = "right";
              ctx.fillStyle = ON_PASTEL_2;
              ctx.fillText(sizeText, x + rw - 6, midY);
              ctx.textAlign = "left";
            }
          }
        }
      }
    } else if (kind === CELL_KIND.RECT) {
      const [x, y, rw, rh] = c.g;
      // FLAME ROOT-ROW TITLE: the depth-0 band (the current folder,
      // full-width at the top) renders as a title bar in the treemap
      // HEADER language — shaded a step deeper than the body, hairline
      // bottom edge, bold name + right-aligned total. Before this the
      // root row was an anonymous gray strip; the chart had no anchor.
      const isFlameRoot = mode === "flame" && c.depth === 0;
      ctx.fillStyle = fill;
      ctx.fillRect(x, y, rw, rh);
      if (isFlameRoot) {
        ctx.fillStyle = darkCells ? "rgba(255,255,255,0.10)" : "rgba(29,29,31,0.14)";
        ctx.fillRect(x, y, rw, rh);
        ctx.fillStyle = "rgba(29,29,31,0.18)";
        ctx.fillRect(x, y + rh - 1, rw, 1);
      }
      // Treemap: white gap separators between the pastel blocks (the
      // reference's look); flame gets a hairline dark stroke — but ONLY
      // on blocks wide enough to carry it: a 1px strokeRect on a 1-3px
      // block degenerates into a dark line that REPLACES the block (the
      // striped "picket fence" the pixel audit measured as 68 one-px
      // background runs in a single row). Narrow blocks render flush
      // and unstroked — the fine texture reads solid.
      if (mode === "treemap" || isFlameRoot) {
        ctx.strokeStyle = "rgba(255,255,255,0.55)";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x + 0.5, y + 0.5, rw - 1, rh - 1);
      } else if (rw >= 4) {
        ctx.strokeStyle = "rgba(29,29,31,0.10)";
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, rw - 1, rh - 1);
      }
      if (isFlameRoot && rw >= 42) {
        // Title-bar label: bold name left, total right — ON the shaded
        // band (ON_PASTEL reads on the anchor gray + shade overlay).
        const name = names.get(c.id);
        if (name) {
          const label = props.abbreviateLabels ? abbreviate(name) : name;
          const midY = y + rh / 2 + 0.5;
          ctx.textBaseline = "middle";
          ctx.textAlign = "left";
          ctx.font = `700 11.5px ${fontUi}`;
          const nameText = clipLabel(ctx, label, rw - 14);
          if (nameText) haloText(ctx, nameText, x + 7, midY, ON_PASTEL);
          if (c.size > 0 && rw >= 190) {
            ctx.font = `600 10px ${fontUi}`;
            const sizeStr = clipLabel(ctx, bytes(c.size), 84);
            if (sizeStr) {
              const nw = nameText ? ctx.measureText(nameText).width : 0;
              const sw = ctx.measureText(sizeStr).width;
              if (x + 7 + nw + 12 + sw <= x + rw - 7) {
                ctx.textAlign = "right";
                ctx.fillStyle = ON_PASTEL_2;
                ctx.fillText(sizeStr, x + rw - 7, midY);
                ctx.textAlign = "left";
              }
            }
          }
        }
      } else if (rw >= 44 && rh >= 16) {
        const name = names.get(c.id);
        if (name) {
          const label = props.abbreviateLabels ? abbreviate(name) : name;
          // Size tiering + halo (design audit: small cells had illegible
          // low-contrast text — bigger cells deserve bigger, bolder
          // labels; the halo keeps them readable on any pastel).
          const big = rw >= 150 && rh >= 46;
          const mid = rw >= 84 && rh >= 26;
          const fontPx = big ? 12.5 : mid ? 11 : 10;
          const weight = big ? 700 : 600;
          ctx.font = `${weight} ${fontPx}px ${fontUi}`;
          // Two-line labels (big cells) anchor top; the SINGLE-line tier
          // (no size row will draw) centers vertically — a lone 10px
          // label hugging the top of an otherwise-empty short cell read
          // as floaty misalignment.
          const twoLine = big && rh >= 64 && c.size > 0;
          ctx.textBaseline = twoLine ? "top" : "middle";
          haloText(
            ctx,
            clipLabel(ctx, label, rw - 10),
            x + 5,
            twoLine ? y + 4 : y + rh / 2 + 0.5,
            ON_PASTEL,
          );
          // Second line — the reference's two-line "name / size" labels
          // on big cells (size arrives via the frame's u64 sizes tail;
          // "600 9px" was dead styling before the tail existed).
          if (twoLine) {
            ctx.font = `600 ${Math.max(9.5, fontPx - 2.5)}px ${fontUi}`;
            haloText(ctx, bytes(c.size), x + 5, y + 6 + fontPx, ON_PASTEL_2);
          }
        }
      }
    } else if (kind === CELL_KIND.ARC) {
      const [a0, a1, r0, r1] = c.g;
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.arc(cx, cy, r1, a0, a1);
      ctx.arc(cx, cy, r0, a1, a0, true);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = "rgba(29,29,31,0.08)";
      ctx.lineWidth = 0.8;
      ctx.stroke();
      // Labels (DaisyDisk reference): RADIAL SPOKES primary — text runs
      // outward along the radius from the ring's inner edge, budget =
      // the ring WIDTH (the old code clipped radial text at the arc
      // LENGTH, letting wide-arc labels run across neighboring rings);
      // TANGENTIAL secondary for wide-but-thin arcs (text along the
      // chord). Never upside-down. Angular room gate: the font height
      // must fit the arc's chord at the label start (neighbor spokes).
      const span = a1 - a0;
      const midA = (a0 + a1) / 2;
      const ringW = r1 - r0;
      const rrMid = (r0 + r1) / 2;
      const name = names.get(c.id);
      if (name) {
        const label = props.abbreviateLabels ? abbreviate(name) : name;
        ctx.fillStyle = ON_PASTEL;
        ctx.font = `600 9px ${fontUi}`;
        ctx.textBaseline = "middle";
        const cosMid = Math.cos(midA);
        // Noise gate: a clipped label of ≤3 chars ("P…", "fi…") carries
        // no information — drop it rather than texture the ring.
        const fit = (budget: number) => {
          const t = clipLabel(ctx, label, budget);
          return t.length > 3 ? t : null;
        };
        if (span * (r0 + 5) > 30 && ringW >= 24) {
          // Radial spoke: from the inner edge outward, left half flips
          // so the text always reads left-to-right. (Chord gate 30px
          // ≈ 4 chars — the old 11px gate admitted 1–2 char fragments.)
          const t = fit(ringW - 10);
          if (t) {
            const flip = cosMid < 0;
            ctx.save();
            ctx.translate(cx + cosMid * (r0 + 5), cy + Math.sin(midA) * (r0 + 5));
            ctx.rotate(midA + (flip ? Math.PI : 0));
            ctx.textAlign = flip ? "right" : "left";
            haloText(ctx, t, flip ? -2 : 2, 0, ON_PASTEL);
            ctx.textAlign = "left";
            ctx.restore();
          }
        } else if (span * rrMid - 6 >= 28 && ringW > 13) {
          // Tangential: text along the chord direction at mid-radius;
          // flip when the chord runs right-to-left (bottom half).
          const t = fit(span * rrMid - 6);
          if (t) {
            const flip = Math.sin(midA) > 0;
            ctx.save();
            ctx.translate(cx + cosMid * rrMid, cy + Math.sin(midA) * rrMid);
            ctx.rotate(midA + Math.PI / 2 + (flip ? Math.PI : 0));
            haloText(ctx, t, flip ? -2 : 2, 0, ON_PASTEL);
            ctx.restore();
          }
        }
      }
    } else if (kind === CELL_KIND.CIRCLE) {
      const [x, y, r] = c.g;
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      // Rim DEFERRED: fill+stroke in one pass let every child fill
      // overpaint its parent's rim (dense centers read as borderless
      // mush). Rims collect here and stroke after the whole cell loop.
      circleRims.push(x, y, r);
      // The sunburst center disc carries the dedicated white center
      // label below — skip the generic dark-ink circle label for it.
      const isSunburstCenter = mode === "sunburst" && c.id === layout.meta.node;
      // Bubble labels: label every circle that can fit one LEGIBLY.
      // 17 — below that not even a two-line 9.5px split fits (the old
      // r=12 gate rendered garbage like "D..."/"P..." — worse than no
      // label; identification falls to hover). Sunburst keeps the wide
      // 30 gate — tiny translucent nested arcs are noise.
      const minLabelR = mode === "sunburst" ? 30 : 17;
      if (r >= minLabelR && !isSunburstCenter) {
        const name = names.get(c.id);
        if (name) {
          const label = props.abbreviateLabels ? abbreviate(name) : name;
          const big = r >= 64;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillStyle = ON_PASTEL;
          ctx.font = `${big ? 700 : 600} ${big ? 11.5 : 9.5}px ${fontUi}`;
          // Big bubbles get the reference's stacked treatment: name over
          // size (the u64 sizes tail) — small ones keep the single line.
          // All bubble labels defer to the collision pass (bigger wins).
          if (big && c.size > 0) {
            const l1 = clipLabel(ctx, label, r * 1.7);
            const w1 = ctx.measureText(l1).width;
            ctx.font = `600 10px ${fontUi}`;
            const sizeStr = bytes(c.size);
            const w2 = ctx.measureText(sizeStr).width;
            pendingCircleLabels.push({
              x,
              cy: y + 0.5,
              w: Math.max(w1, w2) + 2,
              h: 27,
              r,
              draw: () => {
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                ctx.fillStyle = ON_PASTEL;
                ctx.font = `700 11.5px ${fontUi}`;
                ctx.fillText(l1, x, y - 7);
                ctx.fillStyle = ON_PASTEL_2;
                ctx.font = `600 10px ${fontUi}`;
                ctx.fillText(sizeStr, x, y + 8);
                ctx.textAlign = "left";
              },
            });
          } else {
            // Small bubbles: prefer a two-line split at natural break
            // points (space / hyphen / underscore / camelCase) over
            // truncation — "Temp Ca..." becomes "Temp" / "Cache". Falls
            // back to adaptive font (9.5 → 8.5px) then the r×1.8 clip.
            ctx.font = `600 9.5px ${fontUi}`;
            const maxW = r * 1.8;
            let text = clipLabel(ctx, label, maxW);
            let fontPx = 9.5;
            let lines: string[] | null = null;
            if (text.endsWith("…") && r >= 22) {
              const parts = splitLabel(label);
              if (
                parts &&
                ctx.measureText(parts[0]).width <= r * 1.9 &&
                ctx.measureText(parts[1]).width <= r * 1.9
              ) {
                lines = [clipLabel(ctx, parts[0], r * 1.9), clipLabel(ctx, parts[1], r * 1.9)];
              } else {
                ctx.font = `600 8.5px ${fontUi}`;
                fontPx = 8.5;
                const retry = clipLabel(ctx, label, maxW);
                if (!retry.endsWith("…") || retry.length > text.length) text = retry;
              }
            }
            if (lines) {
              const w = Math.max(ctx.measureText(lines[0]).width, ctx.measureText(lines[1]).width);
              pendingCircleLabels.push({
                x,
                cy: y + 0.5,
                w: w + 2,
                h: 22,
                r,
                draw: () => {
                  ctx.textAlign = "center";
                  ctx.textBaseline = "middle";
                  ctx.fillStyle = ON_PASTEL;
                  ctx.font = `600 9.5px ${fontUi}`;
                  ctx.fillText(lines[0], x, y - 5);
                  ctx.fillText(lines[1], x, y + 6);
                  ctx.textAlign = "left";
                },
              });
            } else {
              const w = ctx.measureText(text).width;
              pendingCircleLabels.push({
                x,
                cy: y,
                w: w + 2,
                h: 12,
                r,
                draw: () => {
                  ctx.textAlign = "center";
                  ctx.textBaseline = "middle";
                  ctx.fillStyle = ON_PASTEL;
                  ctx.font = `600 ${fontPx}px ${fontUi}`;
                  ctx.fillText(text, x, y);
                  ctx.textAlign = "left";
                },
              });
            }
          }
          ctx.textAlign = "left";
        }
      }
    } else if (kind === CELL_KIND.DOT) {
      const [x, y, r] = c.g;
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(29,29,31,0.28)";
      ctx.lineWidth = 1.4;
      ctx.stroke();
      if (r >= 13) {
        const name = names.get(c.id);
        if (name) {
          const label = props.abbreviateLabels ? abbreviate(name) : name;
          ctx.fillStyle = ON_PASTEL;
          ctx.font = "600 10px " + fontUi;
          ctx.textBaseline = "middle";
          const left = x > w / 2;
          ctx.textAlign = left ? "right" : "left";
          // In-bounds clamp: dots near an edge used to push their label
          // straight through the canvas boundary (VLM: fragments like
          // "...iberf..."). Resolve to an absolute LEFT edge (the
          // collision pass draws left-anchored) and side-swap when the
          // label would cross back over its own dot.
          const text = clipLabel(ctx, label, 110);
          if (text) {
            const tw = ctx.measureText(text).width;
            let le = left ? x - r - 5 - tw : x + r + 5;
            if (left ? le < 2 : le + tw > w - 2) {
              // Swap sides instead of clipping through the canvas edge.
              le = left ? x + r + 5 : x - r - 5 - tw;
              le = left ? Math.min(w - tw - 2, le) : Math.max(2, le);
            }
            const ly = Math.max(8, Math.min(h - 8, y - 6));
            pendingDotLabels.push({ x: le, y: ly, w: tw, r, text });
          }
          ctx.textAlign = "left";
        }
      }
    }
  }

  // ── Deferred bubble rims (two-pass): all fills done, now the strokes —
  // parent rims survive under nothing. Drawn parent-last (cells iterate
  // parent→child) so big rims sit beneath any later sibling fill is
  // impossible; strokes order among themselves is invisible.
  if (circleRims.length) {
    ctx.strokeStyle = "rgba(29,29,31,0.16)";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (let i = 0; i < circleRims.length; i += 3) {
      ctx.moveTo(circleRims[i] + circleRims[i + 2], circleRims[i + 1]);
      ctx.arc(circleRims[i], circleRims[i + 1], circleRims[i + 2], 0, Math.PI * 2);
    }
    ctx.stroke();
  }

  // ── Flame depth hairlines: rows are flush (y = (depth-1)*row_h); the
  // per-block 0.10-alpha strokes separate blocks but not ROWS — full
  // width bg-colored 1px rules at each distinct row top make the depth
  // ladder read at a glance. (Distinct RECT tops, skip y=0.)
  if (mode === "flame") {
    const rowTops = new Set<number>();
    for (const c of layout.cells) {
      if ((c.flags & 0b111) !== CELL_KIND.RECT) continue;
      const y = c.g[1];
      if (y > 0.5) rowTops.add(y);
    }
    if (rowTops.size) {
      ctx.strokeStyle = bg;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const y of rowTops) {
        ctx.moveTo(0, Math.round(y) + 0.5);
        ctx.lineTo(w, Math.round(y) + 0.5);
      }
      ctx.stroke();
    }
  }

  // ── Mind-map hub emphasis: the root dot renders in cell order like
  // any branch — buried. Redraw LAST with a white+ink double ring so
  // the anchor of the map reads instantly.
  if (mode === "mind-map") {
    for (const c of layout.cells) {
      if (c.id !== layout.meta.node) continue;
      if ((c.flags & 0b111) !== CELL_KIND.DOT) continue;
      const [x, y, r] = c.g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.fill();
      ctx.strokeStyle = "rgba(29,29,31,0.85)";
      ctx.lineWidth = 2;
      ctx.stroke();
      break;
    }
  }

  // Bubble labels: biggest-first with rect-collision skipping —
  // tangent mid bubbles' centered labels collided across bubbles.
  if (pendingCircleLabels.length) {
    pendingCircleLabels.sort((a, b) => b.r - a.r);
    const placed: Array<[number, number, number, number]> = [];
    const pad = 1;
    for (const L of pendingCircleLabels) {
      const rect: [number, number, number, number] = [
        L.x - L.w / 2 - pad,
        L.cy - L.h / 2 - pad,
        L.w + pad * 2,
        L.h + pad * 2,
      ];
      const collide = placed.some(
        ([px, py, pw, ph]) =>
          rect[0] < px + pw && rect[0] + rect[2] > px && rect[1] < py + ph && rect[1] + rect[3] > py,
      );
      if (collide) continue; // smaller bubble loses — hover identifies it
      placed.push(rect);
      L.draw();
    }
  }

  // Mind-map dot labels: biggest-first with rect-collision skipping
  // (dense levels used to render label word-clouds — VLM audits).
  if (pendingDotLabels.length) {
    pendingDotLabels.sort((a, b) => b.r - a.r);
    const placed: Array<[number, number, number, number]> = [];
    const pad = 2;
    ctx.font = "600 10px " + uiFont();
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    for (const L of pendingDotLabels) {
      const rect: [number, number, number, number] = [
        L.x - pad,
        L.y - 7 - pad,
        L.w + pad * 2,
        14 + pad * 2,
      ];
      const collide = placed.some(
        ([px, py, pw, ph]) =>
          rect[0] < px + pw && rect[0] + rect[2] > px && rect[1] < py + ph && rect[1] + rect[3] > py,
      );
      if (collide) continue;
      placed.push(rect);
      haloText(ctx, L.text, L.x, L.y, ON_PASTEL);
    }
  }

  // Sunburst center label: the root folder name + total size in white,
  // centered on the coral disc (reference's center treatment).
  if (mode === "sunburst") {
    let discR = NaN;
    for (const c of layout.cells) {
      if ((c.flags & 0b111) !== CELL_KIND.ARC) continue;
      if (Number.isNaN(discR) || c.g[2] < discR) discR = c.g[2];
    }
    if (Number.isNaN(discR)) discR = Math.min(w, h) * 0.07;
    const rootName = names.get(layout.meta.node);
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    // White ink on coral: a soft dark shadow keeps it crisp without a
    // heavy halo ring.
    ctx.shadowColor = "rgba(0,0,0,0.25)";
    ctx.shadowBlur = 4;
    ctx.fillStyle = "#FFFFFF";
    if (rootName) {
      ctx.font = "600 11px " + uiFont();
      ctx.fillText(clipLabel(ctx, rootName, discR * 1.7), cx, cy - 8);
    }
    ctx.font = "700 15px " + uiFont();
    ctx.fillText(bytes(layout.meta.totalBytes), cx, cy + (rootName ? 7 : 0));
    ctx.restore();
  }
}

function clipLabel(ctx: CanvasRenderingContext2D, label: string, maxW: number): string {
  if (maxW <= 12) return "";
  if (ctx.measureText(label).width <= maxW) return label;
  let out = label;
  while (out.length > 1 && ctx.measureText(`${out}…`).width > maxW) {
    out = out.slice(0, -1);
  }
  return `${out}…`;
}

/**
 * Split a label into two balanced lines at a natural break point
 * (space / hyphen / underscore / camelCase boundary), preferring the
 * split closest to the middle. Returns null when no break point exists
 * or either side would be a single character.
 */
function splitLabel(label: string): [string, string] | null {
  // Candidate split indices (split BEFORE the index).
  const idx: number[] = [];
  for (let i = 1; i < label.length; i++) {
    const a = label[i - 1];
    const b = label[i];
    if (a === " " || a === "-" || a === "_") {
      if (b !== " " && i > 1 && i < label.length) idx.push(i);
    } else if (/[a-z0-9]/.test(a) && /[A-Z]/.test(b)) {
      idx.push(i); // camelCase hump
    }
  }
  if (!idx.length) return null;
  const mid = label.length / 2;
  let best = idx[0];
  let bestD = Math.abs(idx[0] - mid);
  for (const i of idx) {
    const d = Math.abs(i - mid);
    if (d < bestD) {
      best = i;
      bestD = d;
    }
  }
  const l1 = label.slice(0, best).trimEnd();
  const l2 = label.slice(best);
  if (l1.length < 2 || l2.length < 2) return null;
  return [l1, l2];
}

/** Hit-test a point against the mode's geometry. */
function hitCell(cells: Cell[], _mode: string, x: number, y: number, center: [number, number] | null): Cell | null {
  // topmost = last drawn → iterate reversed.
  const cx = center?.[0] ?? 0;
  const cy = center?.[1] ?? 0;
  for (let i = cells.length - 1; i >= 0; i--) {
    const c = cells[i];
    const kind = c.flags & 0b111;
    if (kind === CELL_KIND.RECT || kind === CELL_KIND.HEADER) {
      // HEADER strips are 14px rects (g = x,y,w,h) — the old loop had
      // no kind-4 branch, so clicks on a folder's title band fell
      // through to an ANCESTOR's cell instead of selecting the folder.
      if (x >= c.g[0] && x <= c.g[0] + c.g[2] && y >= c.g[1] && y <= c.g[1] + c.g[3]) return c;
    } else if (kind === CELL_KIND.CIRCLE || kind === CELL_KIND.DOT) {
      const dx = x - c.g[0];
      const dy = y - c.g[1];
      // DOTs pad their hit radius to a 7px floor: mind-map dots run
      // 2.5-6px — sub-pointer targets that hover probes kept missing.
      const hr = kind === CELL_KIND.DOT ? Math.max(c.g[2], 7) : c.g[2];
      if (dx * dx + dy * dy <= hr * hr) return c;
    } else if (kind === CELL_KIND.ARC) {
      const dx = x - cx;
      const dy = y - cy;
      const r = Math.sqrt(dx * dx + dy * dy);
      if (r >= c.g[2] && r <= c.g[3]) {
        const a0 = c.g[0];
        const a1 = c.g[1];
        // normalize into [a0, a0 + 2π)
        let norm = Math.atan2(dy, dx);
        while (norm < a0) norm += Math.PI * 2;
        while (norm > a0 + Math.PI * 2) norm -= Math.PI * 2;
        if (norm <= a1) return c;
      }
    }
  }
  return null;
}

/** Ring/outline path for selection + hover. `inset > 0` strokes an
 *  inner variant (rect inset by `inset` px, circle r - inset, arc radii
 *  pulled in by `inset`) — used for the white inner selection ring. */
function ringPath(
  ctx: CanvasRenderingContext2D,
  c: Cell,
  layout: LayoutResult,
  _mode: string,
  inset = 0,
): void {
  ringPathTrace(ctx, c, layout, inset);
  ctx.stroke();
}

/** Trace a cell's ring/wedge geometry WITHOUT stroking — callers can
 * fill it (sunburst hover-wedge) or stroke with their own style. */
function ringPathTrace(
  ctx: CanvasRenderingContext2D,
  c: Cell,
  layout: LayoutResult,
  inset = 0,
): void {
  const kind = c.flags & 0b111;
  ctx.beginPath();
  if (kind === CELL_KIND.RECT || kind === CELL_KIND.HEADER) {
    const i = inset > 0 ? inset : 1;
    if (c.g[2] - 2 * i > 1 && c.g[3] - 2 * i > 1) {
      ctx.rect(c.g[0] + i, c.g[1] + i, c.g[2] - 2 * i, c.g[3] - 2 * i);
    }
  } else if (kind === CELL_KIND.CIRCLE || kind === CELL_KIND.DOT) {
    const r = inset > 0 ? c.g[2] - inset : c.g[2] + 1.5;
    if (r > 0.5) ctx.arc(c.g[0], c.g[1], r, 0, Math.PI * 2);
  } else if (kind === CELL_KIND.ARC) {
    const [cx, cy] = layout.meta.center ?? [0, 0];
    const ro = inset > 0 ? c.g[3] - inset : c.g[3] + 1;
    const ri = inset > 0 ? c.g[2] + inset : c.g[2] - 1;
    if (ro > ri && ri > 0.5) {
      ctx.arc(cx, cy, ro, c.g[0], c.g[1]);
      ctx.arc(cx, cy, ri, c.g[1], c.g[0], true);
      ctx.closePath();
    }
  }
}
