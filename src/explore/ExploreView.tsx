/**
 * Explore view (spec §7): idle / scanning / done / error states, the
 * big header (folder name + stats + reveal), the unreadable notice,
 * the mode toolbar, and the stage hosting one of the 9 modes. Wires the
 * shared interaction set (select, dblclick-open, context menu, hover
 * chip, preview) into every mode.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, animate, motion, useMotionValue, useTransform } from "framer-motion";
import { ExternalLinkIcon, FolderIcon, HardDriveIcon, ScanLineIcon, SquareIcon } from "../components/Icon";
import { EmptyState } from "../components/buttons";
import { UnreadableNotice } from "../sidebar";
import { ExploreHeader } from "./ExploreHeader";
import { FoldersMode } from "./modes/FoldersMode";
import { CanvasMode } from "./modes/CanvasMode";
import { TopSizesMode } from "./modes/TopSizesMode";
import { AgeMapMode } from "./modes/AgeMapMode";
import { ListMode } from "./modes/ListMode";
import { HoverChip, type HoverChipHandle } from "../components/HoverChip";
import { ItemContextMenu, type ItemMenuState } from "../components/ItemContextMenu";
import { TailPath } from "../components/TailPath";
import { invoke } from "../lib/ipc";
import { bytes } from "../lib/format";
import { useExploreStore } from "../state/explore";
import { useScanStore } from "../state/scan";
import { useViewStore } from "../state/view";
import { useVizUiStore, type Mode } from "../state/vizUi";
import { useCleanupStore } from "../state/cleanup";
import { CANVAS_MODES } from "../state/vizUi";
import { getHoverDetails } from "../viz/layoutIpc";
import { getNodeDetails, type NodeDetailsData } from "../viz/exploreIpc";
import { EVENTS, track } from "../lib/analytics";
import { FADE_SWAP, EXIT_FAST } from "../lib/motion";

/** Smoothly-rolling "N files · X GB" live counter (motion values, no
 * per-tick React re-render churn — the 150 ms IPC ticks TWEEN into each
 * other so the numbers glide instead of jumping). */
function ScanCounter({ files, totalBytes }: { files: number; totalBytes: number }) {
  const filesMv = useMotionValue(files);
  const bytesMv = useMotionValue(totalBytes);
  useEffect(() => {
    void animate(filesMv, files, { duration: 0.5, ease: "easeOut" });
    void animate(bytesMv, totalBytes, { duration: 0.5, ease: "easeOut" });
  }, [files, totalBytes, filesMv, bytesMv]);
  const text = useTransform([filesMv, bytesMv], ([f, b]: number[]) =>
    `${Math.max(0, Math.round(f)).toLocaleString()} files · ${bytes(Math.max(0, b))}`,
  );
  // NOTE: no aria-live on this counter — it updates every 150 ms and
  // would spam assistive tech; the "Scanning…" heading already carries
  // the state, and scan completion announces through the store swap.
  return <motion.span className="db-live-counter tnum">{text}</motion.span>;
}

export function ExploreView({ onPreview }: { onPreview: (id: number) => void }) {
  const status = useScanStore((s) => s.status);
  const progress = useScanStore((s) => s.progress);
  const error = useScanStore((s) => s.error);
  const scanTarget = useScanStore((s) => s.scanTarget);
  const cancelScan = useScanStore((s) => s.cancelScan);
  const generation = useScanStore((s) => s.generation);
  const currentFolder = useExploreStore((s) => s.currentFolder);
  const selectedNode = useExploreStore((s) => s.selectedNode);
  const openFolder = useExploreStore((s) => s.openFolder);
  const select = useExploreStore((s) => s.select);
  const nameFilter = useViewStore((s) => s.nameFilter);
  const mode = useVizUiStore((s) => s.mode);
  const stage = useCleanupStore((s) => s.stage);

  const chip = useRef<HoverChipHandle>(null);
  const hoverSeq = useRef(0);
  const [menu, setMenu] = useState<ItemMenuState | null>(null);
  const [folderView, setFolderView] = useState<NodeDetailsData | null>(null);

  // Throttled path ticker: the raw currentPath changes every 150 ms
  // (unreadable strobe); display it at ~600 ms with a soft crossfade.
  const [displayPath, setDisplayPath] = useState("");
  const lastPathSwap = useRef(0);
  useEffect(() => {
    if (status !== "scanning" || !progress?.currentPath) return;
    const now = performance.now();
    if (now - lastPathSwap.current < 600) return;
    lastPathSwap.current = now;
    setDisplayPath(progress.currentPath);
  }, [status, progress]);

  // Folder header info (name + stats for the current folder)
  useEffect(() => {
    if (status !== "done") {
      setFolderView(null);
      return;
    }
    let disposed = false;
    void (async () => {
      const d = await getNodeDetails(generation, currentFolder).catch(() => null);
      if (!disposed) setFolderView(d);
    })();
    return () => {
      disposed = true;
    };
  }, [status, generation, currentFolder]);

  // ── Hover chip controller (refs; never re-renders on pointer moves) ─
  // A view change orphans a pinned chip: programmatic navigation (mode
  // switch, folder open, new generation) never fires pointerleave, so
  // the chip kept floating over the NEW view (CI tour frames showed it
  // stuck over treemap/top-sizes). Hide on every transition.
  useEffect(() => {
    chip.current?.hide();
  }, [mode, currentFolder, status, generation, nameFilter]);

  const hoverFetch = useCallback(
    (id: number | null, x: number, y: number) => {
      if (id == null || id < 0) {
        hoverSeq.current += 1; // in-flight fetches are now stale
        chip.current?.hide();
        return;
      }
      chip.current?.move(x, y);
      // Sequence guard: hovering A→B quickly lets A's async details
      // resolve LAST and paint A's data under B's pointer. Only the
      // NEWEST hover may show.
      const seq = ++hoverSeq.current;
      void (async () => {
        const d = await getHoverDetails(generation, id).catch(() => null);
        if (seq !== hoverSeq.current) return; // superseded by a newer hover/hide
        if (d) chip.current?.show(
          {
            name: d.name,
            size: d.size,
            shareOfScan: d.shareOfScan,
            fileCount: d.fileCount,
            isDir: d.isDir,
            category: d.category,
            categoryColor: d.categoryColor,
            isCloud: d.isCloud,
            isProtected: d.isProtected,
          },
          x,
          y,
        );
      })();
    },
    [generation],
  );

  const menuResolver = useCallback(
    async (id: number) => {
      const d = await getHoverDetails(generation, id).catch(() => null);
      if (!d) return null;
      const details = await getNodeDetails(generation, id).catch(() => null);
      return {
        id,
        name: details?.name ?? "",
        isDir: d.isDir,
        isProtected: d.isProtected,
        isCloud: d.isCloud,
      };
    },
    [generation],
  );

  // ── Shared actions ──────────────────────────────────────────────────
  const actions = useMemo(
    () => ({
      open: (id: number) => {
        track(EVENTS.searchUsed, { mode });
        openFolder(id);
      },
      preview: (id: number) => onPreview(id),
      reveal: (id: number) => void invoke("reveal_in_explorer", { generation, id }).catch(() => undefined),
      copyPath: (id: number) => {
        void invoke("copy_path", { generation, id }).catch(() => undefined);
      },
      stage: (id: number) => {
        void (async () => {
          const d = await getNodeDetails(generation, id).catch(() => null);
          if (d) {
            stage({ id, path: d.path, size: d.size, reason: "Manual" });
          }
        })();
      },
    }),
    [generation, mode, onPreview, openFolder, stage],
  );

  // Dev-hook auto-start (spec §15 DISKBYTES_SCAN / --scan)
  useEffect(() => {
    if (status !== "idle") return;
    void (async () => {
      const hooks = await invoke<{ scan: string | null; mode: string | null }>("get_dev_hooks").catch(() => null);
      if (hooks?.scan) {
        const startScan = useScanStore.getState().startScan;
        void startScan(hooks.scan);
      }
      if (hooks?.mode) {
        useVizUiStore.getState().setMode(hooks.mode as Mode);
      }
    })();
    // Only on mount — the hook fires once per process.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const revealCurrent = () => {
    void invoke("reveal_in_explorer", { generation, id: currentFolder }).catch(() => undefined);
  };

  // ── Render by state ────────────────────────────────────────────────
  if (status === "idle") {
    return (
      <div className="db-main">
        <div className="db-state">
          <span className="db-idle-art">
            <FolderIcon size={34} />
          </span>
          <h2>Map every byte on your PC</h2>
          <p>Scan your whole PC, your Home folder, or any folder — DiskBytes builds a complete tree and shows you exactly where the space went.</p>
          <div className="db-state-actions">
            <button
              type="button"
              className="db-ink-button auto"
              onClick={() => {
                track(EVENTS.scanStarted, { target: "ThisPC" });
                void useScanStore.getState().startScan("ThisPC");
              }}
            >
              <ScanLineIcon size={16} /> Scan This PC
            </button>
            <button
              type="button"
              className="db-outline auto"
              onClick={async () => {
                try {
                  const { open } = await import("@tauri-apps/plugin-dialog");
                  const picked = await open({ directory: true, multiple: false, title: "Scan" });
                  if (typeof picked === "string" && picked.length > 0) {
                    track(EVENTS.scanStarted, { target: "folder" });
                    void useScanStore.getState().startScan(picked);
                  }
                } catch {
                  const home = await invoke<string>("get_home_path").catch(() => null);
                  if (home) void useScanStore.getState().startScan(home);
                }
              }}
            >
              <ExternalLinkIcon size={14} /> Choose Folder…
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (status === "scanning") {
    return (
      <div className="db-main">
        <div className="db-state db-scanning">
          {/* Premium radial disk sweep v2 (transform-only CSS, 60 fps):
           * main orbit + faint counter-rotating outer tail + breathing core. */}
          <div className="db-scan-visual" aria-hidden="true">
            {/* Two guide rings (anchor + texture); a third at r=30 sat
             * inside the core's pulse-glow radius and shimmered every
             * 2.4 s cycle — removed rather than crowded. */}
            <span className="db-scan-ring r1" />
            <span className="db-scan-ring r2" />
            <span className="db-scan-sweep2" />
            <span className="db-scan-sweep" />
            <span className="db-scan-core">
              <HardDriveIcon size={22} />
            </span>
          </div>
          <h2>Scanning…</h2>
          <ScanCounter files={progress?.files ?? 0} totalBytes={progress?.bytes ?? 0} />
          <TailPath path={displayPath} className="db-current-path" />
          <button type="button" className="db-outline db-cancel-scan" onClick={() => void cancelScan()}>
            <SquareIcon size={13} /> Stop scan
          </button>
        </div>
      </div>
    );
  }

  if (status === "error") {
    const elevation = error?.includes("ELEVATION_REQUIRED");
    return (
      <div className="db-main">
        <div className="db-state db-error">
          <h2>{elevation ? "Administrator rights needed" : "Scan failed"}</h2>
          <p>{elevation ? "This scan target needs elevation. Restart as administrator and it re-runs automatically." : (error ?? "Something went wrong.")}</p>
          <div className="db-state-actions">
            <button
              type="button"
              className="db-ink-button auto"
              onClick={() => {
                if (elevation) {
                  void invoke("restart_as_admin", { scanTarget, turbo: true }).catch(() => undefined);
                } else {
                  void useScanStore.getState().startScan("ThisPC");
                }
              }}
            >
              {elevation ? "Restart as administrator" : "Try again"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // status === "done"
  const st = folderView;
  return (
    <div className="db-main">
      <div className="db-content-head">
        <div className="db-title-row">
          <div>
            <h1>{st?.name ?? "Scan"}</h1>
            <span className="db-stat size tnum">{st ? bytes(st.size) : ""}</span>
            <i className="db-dot-sep" />
            <span className="db-stat tnum">{(st?.files ?? 0).toLocaleString()} files</span>
            <i className="db-dot-sep" />
            <span className="db-stat tnum">{(st?.folders ?? 0).toLocaleString()} folders</span>
          </div>
          <div className="db-title-actions">
            <button
              type="button"
              className="db-icon-button"
              onClick={revealCurrent}
              aria-label="Show in Explorer"
              title="Show in Explorer"
            >
              <ExternalLinkIcon size={15} />
            </button>
          </div>
        </div>
        <ExploreHeader />
        <UnreadableNotice />
      </div>
      <section className="db-visual-stage db-scroll" aria-label={`${mode} visualization`}>
        {/* Mode-swap CROSSFADE (popLayout): the old view fades out OVER
         * the entering one, which covers the new canvas's layout-IPC
         * window (mount → blank → fetch → paint was the reported
         * "blink"). The exiting wrapper is popped absolute inside the
         * relative stage, so no layout shift and no blank frame.
         * `initial={false}` keeps the very first mount static. */}
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div
            key={`${generation}:${currentFolder}:${mode}`}
            className="db-stage-swap"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: FADE_SWAP }}
            exit={{ opacity: 0, transition: EXIT_FAST }}
          >
          {mode === "Folders" && (
            <FoldersMode
              generation={generation}
              folder={currentFolder}
              filter={nameFilter}
              selectedId={selectedNode}
              onSelect={select}
              onOpen={actions.open}
              onPreview={onPreview}
              onContextMenu={(id, x, y) => setMenu({ id, x, y })}
              onHover={hoverFetch}
            />
          )}
          {CANVAS_MODES.has(mode) && (
            <CanvasMode
              generation={generation}
              folder={currentFolder}
              mode={mode}
              selectedId={selectedNode}
              onSelect={select}
              onOpen={actions.open}
              onContextMenu={(id, x, y) => setMenu({ id, x, y })}
              onHover={hoverFetch}
            />
          )}
          {mode === "Top Sizes" && (
            <TopSizesMode
              generation={generation}
              folder={currentFolder}
              filter={nameFilter}
              selectedId={selectedNode}
              onSelect={select}
              onOpen={actions.open}
              onContextMenu={(id, x, y) => setMenu({ id, x, y })}
              onHover={hoverFetch}
            />
          )}
          {mode === "Age Map" && (
            <AgeMapMode
              generation={generation}
              folder={currentFolder}
              onSelect={select}
              onHover={hoverFetch}
              onContextMenu={(id, x, y) => setMenu({ id, x, y })}
            />
          )}
          {mode === "List" && (
            <ListMode
              generation={generation}
              folder={currentFolder}
              filter={nameFilter}
              selectedId={selectedNode}
              onSelect={select}
              onOpen={actions.open}
              onContextMenu={(id, x, y) => setMenu({ id, x, y })}
              onHover={hoverFetch}
            />
          )}
        </motion.div>
        </AnimatePresence>
      </section>

      <HoverChip ref={chip} sizeFmt={bytes} />
      <ItemContextMenu target={menu} actions={actions} resolver={menuResolver} onClose={() => setMenu(null)} />
    </div>
  );
}

export { EmptyState };
