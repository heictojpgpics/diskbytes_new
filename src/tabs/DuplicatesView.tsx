/**
 * Duplicates tab (spec §10): "Scan for Duplicates" (requires a finished
 * scan), "X could be reclaimed across N groups", group cards with
 * per-file "Keep this, stage the rest" (stages the others with reason
 * "Duplicate").
 */
import { useEffect, useState } from "react";
import { CopyIcon, FileIcon, SearchIcon, CheckIcon, Trash2Icon } from "../components/Icon";
import { TailPath } from "../components/TailPath";
import { EmptyState } from "../components/buttons";
import { invoke } from "../lib/ipc";
import { bytes } from "../lib/format";
import { useScanStore } from "../state/scan";
import { useCleanupStore } from "../state/cleanup";
import { EVENTS, track } from "../lib/analytics";

interface DupeGroup {
  id: number;
  paths: string[];
  size: number;
  count: number;
  wasted: number;
}

interface DupesResult {
  generation: number;
  groups: DupeGroup[];
  wastedTotal: number;
  files: number;
}

export function DuplicatesView() {
  const status = useScanStore((s) => s.status);
  const generation = useScanStore((s) => s.generation);
  const stageMany = useCleanupStore((s) => s.stageMany);
  const [result, setResult] = useState<DupesResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [keeps, setKeeps] = useState<Map<number, string>>(new Map());
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (status !== "done") {
      setResult(null);
      setKeeps(new Map());
    }
  }, [status, generation]);

  const scan = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await invoke<DupesResult>("find_duplicates", { generation });
      setResult(res);
      setExpanded(new Set(res.groups.slice(0, 3).map((g) => g.id)));
      track(EVENTS.duplicatesScanCompleted, { groups: res.groups.length, wasted: res.wastedTotal });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const keepAndStageRest = (g: DupeGroup, keepPath: string) => {
    setKeeps((m) => new Map(m).set(g.id, keepPath));
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

  if (status !== "done") {
    return (
      <div className="db-tab db-scroll">
        <EmptyState
          icon={<CopyIcon size={28} />}
          title="Duplicates"
          body={status === "scanning" ? "Scan in progress — duplicate detection starts once the tree is complete." : "Complete a disk scan to find duplicate files."}
        />
      </div>
    );
  }

  return (
    <div className="db-tab db-scroll">
      <div className="db-tab-head">
        <div>
          <h1>Duplicates</h1>
          <span className="db-tab-sub">
            {result
              ? result.groups.length > 0
                ? <>
                    <b>{bytes(result.wastedTotal)}</b> could be reclaimed across <b>{result.groups.length.toLocaleString()}</b> groups · {result.files.toLocaleString()} files considered
                  </>
                : "No duplicates found."
              : "Byte-identical files, grouped for safe removal."}
          </span>
        </div>
        {(result || busy) && (
          <div className="db-tab-head-actions">
            <button type="button" className="db-ink-button auto" disabled={busy} onClick={() => void scan()}>
              <SearchIcon size={15} />
              {busy ? "Scanning…" : "Scan Again"}
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

      {busy && (
        <div className="db-loading-block" role="status">
          <span>Hashing candidates (size groups → 64 KB prefix → full)…</span>
        </div>
      )}

      {!result && !busy && status === "done" && (
        <EmptyState
          icon={<CopyIcon size={28} />}
          title="Find duplicate files"
          body="Three passes — size groups, 64 KB prefix hash, full SHA-256 — group byte-identical files so you can keep one copy and stage the rest."
          action={
            <button type="button" className="db-ink-button auto" onClick={() => void scan()}>
              <SearchIcon size={15} />
              Scan for Duplicates
            </button>
          }
        />
      )}

      {result && result.groups.length === 0 && !busy && (
        <EmptyState icon={<CheckIcon size={28} />} title="No duplicates" body="Every file on this scan is unique — nothing to reclaim." />
      )}

      {result?.groups.map((g) => {
        const isOpen = expanded.has(g.id);
        const kept = keeps.get(g.id);

        return (
          <div className="db-dup-group" key={g.id}>
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
