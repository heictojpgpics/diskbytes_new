/**
 * Duplicates tab (spec §10): "Scan for Duplicates" (requires a finished
 * scan), "X could be reclaimed across N groups", group cards with
 * per-file "Keep this, stage the rest" (stages the others with reason
 * "Duplicate").
 *
 * Session-5 redesign: the scan lifecycle lives in the module-level
 * `state/dupes` store (persistent listener + app-lifetime backend
 * status) — switching tabs mid-scan no longer orphans the pipeline or
 * resets the busy row; a remount re-attaches via `refresh()`. The
 * busy row is an ISOLATED component subscribing to the progress slice
 * alone, so 9 Hz ticks repaint one row, not 200 group cards (the
 * "progress bar lagging" fix). The bar follows the engine's monotonic
 * `overall` fraction — one smooth ramp, never a phase-boundary reset.
 */
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { CopyIcon, FileIcon, SearchIcon, CheckIcon, Trash2Icon, XIcon } from "../components/Icon";
import { TailPath } from "../components/TailPath";
import { EmptyState } from "../components/buttons";
import { bytes } from "../lib/format";
import { useScanStore } from "../state/scan";
import { useCleanupStore } from "../state/cleanup";
import { useDupesStore, type DupesProgress, type DupesResult } from "../state/dupes";

const PHASE_LABEL: Record<DupesProgress["phase"], string> = {
  collect: "Collecting candidates",
  prefix: "Hashing 64 KB prefixes",
  screen: "Screening same-prefix files",
  full: "Verifying full contents",
  done: "Done",
  cancelled: "Cancelled",
};

/** "1m 42s" / "about 3 min" — coarse, honest, never jumpy (rounded to
 * the widest bucket the value fits so ticks don't re-render new text). */
function etaText(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 5) return "";
  if (seconds < 90) return `about ${Math.max(5, Math.round(seconds / 10) * 10)} s left`;
  if (seconds < 5400) return `about ${Math.round(seconds / 60)} min left`;
  return `about ${Math.round(seconds / 3600)} h left`;
}

/**
 * The live busy row. Blink-free by construction:
 * - ONE stable structure (phase, counts, rate, ETA, Cancel are always
 *   mounted while busy — no span pops in/out at phase boundaries, the
 *   old "Collecting artifacts… / counts / Collecting artifacts…"
 *   strobe).
 * - The bar reads `overall` (monotonic, engine-weighted) — it can
 *   never snap backwards at a boundary; CSS paces the width so ticks
 *   read as motion, not jumps.
 * - The rate derives from the CUMULATIVE `bytesDoneAll` counter —
 *   phase resets no longer freeze it.
 */
const BusyRow = memo(function BusyRow({ onCancel }: { onCancel: () => void }) {
  const progress = useDupesStore((s) => s.progress);
  const rate = useRef<{ at: number; bytes: number; v: number } | null>(null);

  let mbps = 0;
  let eta = "";
  if (progress) {
    const now = performance.now();
    const r = rate.current;
    if (r && now - r.at > 500 && progress.bytesDoneAll >= r.bytes) {
      const v = (progress.bytesDoneAll - r.bytes) / ((now - r.at) / 1000) / (1024 * 1024);
      if (v > 0) rate.current = { at: now, bytes: progress.bytesDoneAll, v };
    } else if (!r) {
      rate.current = { at: now, bytes: progress.bytesDoneAll, v: 0 };
    }
    mbps = rate.current?.v ?? 0;
    if (mbps > 0.5 && progress.bytesTotal > progress.bytesDone) {
      eta = etaText((progress.bytesTotal - progress.bytesDone) / (mbps * 1024 * 1024));
    }
  }

  const phase = progress?.phase ?? "collect";
  const pct = Math.round((progress?.overall ?? 0) * 1000) / 10;
  const counting = (progress?.filesTotal ?? 0) > 0 || (progress?.filesDoneAll ?? 0) > 0;

  return (
    <div className="db-loading-block db-dupes-busy" role="status">
      <div className="db-dupes-busy-line">
        <span className="db-dupes-phase" data-phase={phase}>
          <i className="db-dupes-phase-dot" aria-hidden="true" />
          {PHASE_LABEL[phase]}
          {counting && progress && progress.filesTotal > 0 && (
            <span className="tnum db-dupes-counts">
              {progress.filesDone.toLocaleString()} / {progress.filesTotal.toLocaleString()} files
              {progress.bytesTotal > 0 && (
                <> · {bytes(progress.bytesDone)} / {bytes(progress.bytesTotal)}</>
              )}
            </span>
          )}
        </span>
        <span className="tnum db-dupes-rate">
          {mbps > 0.5 ? <>{mbps >= 100 ? mbps.toFixed(0) : mbps.toFixed(1)} MB/s{eta ? ` · ${eta}` : ""}</> : "\u00A0"}
        </span>
        <button type="button" className="db-outline compact auto" onClick={onCancel}>
          <XIcon size={12} /> Cancel
        </button>
      </div>
      <div className="db-dupes-bar" aria-hidden="true" style={{ ["--pct" as string]: `${pct}%` }} />
    </div>
  );
});

export function DuplicatesView() {
  const status = useScanStore((s) => s.status);
  const generation = useScanStore((s) => s.generation);
  const startScan = useScanStore((s) => s.startScan);
  const stageMany = useCleanupStore((s) => s.stageMany);
  // The app-lifetime scan lifecycle (survives tab switches):
  const running = useDupesStore((s) => s.running);
  const result = useDupesStore((s) => s.result);
  const error = useDupesStore((s) => s.error);
  const start = useDupesStore((s) => s.start);
  const cancel = useDupesStore((s) => s.cancel);
  const refresh = useDupesStore((s) => s.refresh);
  const invalidate = useDupesStore((s) => s.invalidate);
  const [keeps, setKeeps] = useState<Map<string, string>>(new Map());
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  // Path-join identity: group ids are re-indexed on every scan, so keep
  // marks key by content, not index — a re-scan keeps the UI honest.
  const keyOf = (g: DupesResult["groups"][number]) => g.paths.join("\u0000");

  // Re-attach on mount: adopt a running pipeline (or the sticky last
  // result) from the backend's app-lifetime status. THE page-switch fix
  // — the remounted view continues the scan instead of offering a
  // fresh "Start scan" over a still-hashing pipeline.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Adopt freshly-delivered results into the expand state (the store
  // holds the result; only view sugar resets per mount).
  useEffect(() => {
    if (result) setExpanded(new Set(result.groups.slice(0, 3).map((g) => g.id)));
  }, [result]);

  // Tree-change invalidation: a new scan or a cleanup commit bumps the
  // generation while status stays "done" — the old result's groups are
  // stale (paths may no longer exist). The backend's start_scan also
  // cancels any in-flight dupes run; the store's `running` clears when
  // the pipeline folds.
  useEffect(() => {
    invalidate(generation);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, generation]);

  // Tour hook (CI): run the scan when the tour reaches the duplicates
  // step so production screenshots show the real result state. The
  // store owns the invoke — the event handler is mount-safe either way.
  useEffect(() => {
    const run = () => start(useScanStore.getState().generation);
    window.addEventListener("db-tour-dupes-run", run);
    return () => window.removeEventListener("db-tour-dupes-run", run);
  }, [start]);

  const keepAndStageRest = (g: DupesResult["groups"][number], keepPath: string) => {
    setKeeps((m) => new Map(m).set(keyOf(g), keepPath));
    const rest = g.paths.filter((p) => p !== keepPath);
    // Node ids come from the path → we stage by path with a synthetic id
    // (the Rust commit path handles id 0 = path-only items).
    stageMany(
      rest.map((p) => ({ id: 0, path: p, size: g.size, reason: "Duplicate" })),
    );
  };

  const stageOne = (path: string, size: number) => {
    stageMany([{ id: 0, path, size, reason: "Duplicate" }]);
  };

  const scan = () => start(generation);

  const stale = result != null && result.generation !== generation;

  const subtitle = useMemo(() => {
    if (running) return "Scanning for duplicates — you can keep using the app, this tab updates live.";
    if (!result || stale) return "Byte-identical files, grouped for safe removal.";
    if (result.groups.length === 0) return "No duplicates found.";
    return (
      <>
        <b>{bytes(result.wastedTotal)}</b> could be reclaimed across <b>{result.groups.length.toLocaleString()}</b> groups · {result.files.toLocaleString()} files considered
      </>
    );
  }, [running, result, stale]);

  if (status !== "done") {
    return (
      <div className="db-tab db-scroll">
        <EmptyState
          icon={<CopyIcon size={28} />}
          title="Duplicates"
          body={status === "scanning" ? "Scan in progress — duplicate detection starts once the tree is complete." : "Complete a disk scan to find duplicate files."}
          action={
            status !== "scanning" ? (
              <button type="button" className="db-ink-button auto" onClick={() => void startScan("ThisPC")}>
                <SearchIcon size={15} /> Scan This PC
              </button>
            ) : undefined
          }
        />
      </div>
    );
  }

  return (
    <div className="db-tab db-scroll">
      <div className="db-tab-head">
        <div>
          <h1>Duplicates</h1>
          <span className="db-tab-sub">{subtitle}</span>
        </div>
        {(result || running) && (
          <div className="db-tab-head-actions">
            <button type="button" className="db-ink-button auto" disabled={running} onClick={scan}>
              <SearchIcon size={15} />
              {running ? "Scanning…" : "Scan Again"}
            </button>
          </div>
        )}
      </div>

      {error && (
        <div className="db-pop-failed" style={{ margin: "0 0 14px" }}>
          <strong>Couldn’t scan for duplicates</strong>
          <p style={{ margin: 0, fontSize: 11 }}>{error}</p>
        </div>
      )}

      {running && <BusyRow onCancel={cancel} />}

      {!result && !running && status === "done" && (
        <EmptyState
          icon={<CopyIcon size={28} />}
          title="Find duplicate files"
          body="Three passes — size groups, 64 KB prefix hash, full SHA-256 — group byte-identical files so you can keep one copy and stage the rest."
          action={
            <button type="button" className="db-ink-button auto" onClick={scan}>
              <SearchIcon size={15} /> Scan for Duplicates
            </button>
          }
        />
      )}

      {result && result.groups.length === 0 && !running && (
        <EmptyState icon={<CheckIcon size={28} />} title="No duplicates" body="Every file on this scan is unique — nothing to reclaim." />
      )}

      {result && !stale && result.groups.map((g) => {
        const isOpen = expanded.has(g.id);
        const kept = keeps.get(keyOf(g));

        return (
          <div className="db-dup-group" key={keyOf(g)}>
            <header>
              <strong>
                {g.count.toLocaleString()} copies · {bytes(g.size)} each
              </strong>
              <span className="tnum">{bytes(g.wasted)} wasted</span>
              <button
                type="button"
                className="db-outline compact auto"
                onClick={() => setExpanded((s) => (s.has(g.id) ? new Set([...s].filter((x) => x !== g.id)) : new Set([...s, g.id])))}
              >
                {isOpen ? "Collapse" : "Show files"}
              </button>
            </header>
            {isOpen &&
              g.paths.map((p) => {
                const isKept = kept === p;
                return (
                  <div key={p} className="db-dup-file">
                    <FileIcon size={15} />
                    {/* Path only — the size lives once, in the right
                     * column (it used to repeat under the path too). */}
                    <div>
                      <TailPath path={p} />
                    </div>
                    {isKept ? (
                      <span className="db-keep-tag keep">
                        <CheckIcon size={11} /> Keep
                      </span>
                    ) : (
                      <span
                        className={`db-keep-tag stage${kept ? " is-disabled" : ""}`}
                        role="button"
                        tabIndex={kept ? -1 : 0}
                        aria-disabled={kept ? true : undefined}
                        onClick={() => (kept ? undefined : stageOne(p, g.size))}
                        onKeyDown={(e) => {
                          // WAI button pattern: Enter AND Space activate.
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            if (!kept) stageOne(p, g.size);
                          }
                        }}
                      >
                        <Trash2Icon size={11} /> Stage
                      </span>
                    )}
                    <b className="tnum">{bytes(g.size)}</b>
                  </div>
                );
              })}
            {isOpen && (
              <div style={{ padding: "10px 15px", borderTop: "1px solid var(--divider)" }}>
                <button
                  type="button"
                  className="db-outline"
                  onClick={() => keepAndStageRest(g, kept ?? g.paths[0])}
                >
                  <CheckIcon size={13} /> {kept ? "Stage the rest again" : "Keep this, stage the rest"}
                  {!kept && <span style={{ color: "var(--text-tertiary)" }}> ({bytes(g.wasted)})</span>}
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
