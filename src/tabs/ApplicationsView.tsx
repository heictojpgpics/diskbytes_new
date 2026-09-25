/**
 * Applications tab (spec §11): installed apps sorted by total footprint,
 * rows expandable to "Program files" + leftover groups; uninstall
 * dialog (Run uninstaller / Stage leftovers only / Cancel); failure
 * alert with Restart-as-administrator.
 */
import { useEffect, useRef, useState } from "react";
import { AppWindowIcon, CheckIcon, PackageOpenIcon, RefreshCwIcon, Trash2Icon, ShieldIcon } from "../components/Icon";
import { TailPath } from "../components/TailPath";
import { EmptyState, SkeletonRows } from "../components/buttons";
import { useFocusTrap } from "../lib/useFocusTrap";
import { bytes, relativeAge } from "../lib/format";
import { invoke } from "../lib/ipc";
import { useApplicationsStore, type AppEntry, type UninstallResult } from "../state/applications";
import { useCleanupStore } from "../state/cleanup";
import { useScanStore } from "../state/scan";
import { EVENTS, track } from "../lib/analytics";

export function ApplicationsView() {
  const status = useScanStore((s) => s.status);
  const apps = useApplicationsStore((s) => s.apps);
  const busy = useApplicationsStore((s) => s.busy);
  const error = useApplicationsStore((s) => s.error);
  const load = useApplicationsStore((s) => s.load);
  const uninstall = useApplicationsStore((s) => s.uninstall);
  const stageMany = useCleanupStore((s) => s.stageMany);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<AppEntry | null>(null);
  const [uninstalling, setUninstalling] = useState(false);
  const [failPaths, setFailPaths] = useState<string[] | null>(null);
  const confirmRef = useRef<HTMLDivElement>(null);
  useFocusTrap(confirmRef, confirm !== null);

  // Esc closes the uninstall confirm — every other dialog (license,
  // preview, queue) closes on Esc; this one was the lone exception.
  useEffect(() => {
    if (!confirm) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setConfirm(null);
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [confirm]);

  useEffect(() => {
    if (apps === null && !busy) {
      void load();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (status === "idle" || status === "scanning") {
    return (
      <div className="db-tab db-scroll">
        <EmptyState icon={<AppWindowIcon size={28} />} title="Applications" body={status === "scanning" ? "Scan in progress — app footprints land here after the tree is ready." : "Every installed app, its leftovers, and one-click cleanup."} />
      </div>
    );
  }

  const sorted = [...(apps ?? [])].sort((a, b) => b.total - a.total);
  const totalFootprint = sorted.reduce((a, x) => a + x.total, 0);
  const now = Math.floor(Date.now() / 1000);

  const runUninstall = async (app: AppEntry) => {
    setUninstalling(true);
    track(EVENTS.uninstallRun, { app: app.id });
    try {
      const result: UninstallResult = await uninstall(app.id);
      if (result.remainingLeftovers.length > 0 || !result.removedEntry) {
        setFailPaths(result.remainingLeftovers.flatMap((g) => g.paths.map((p) => p.path)));
      } else {
        setConfirm(null);
        void load(true);
      }
    } catch (e) {
      setFailPaths([String(e)]);
    } finally {
      setUninstalling(false);
    }
  };

  const stageLeftovers = (app: AppEntry) => {
    const items = app.leftovers.flatMap((g) =>
      g.paths.map((p) => ({ id: 0, path: p.path, size: p.size, reason: `Leftovers: ${app.name} — ${g.label}` })),
    );
    if (items.length > 0) stageMany(items);
    setConfirm(null);
  };

  return (
    <div className="db-tab db-scroll">
      <div className="db-tab-head">
        <div>
          <h1>Applications</h1>
          <span className="db-tab-sub">
            {busy ? "Measuring bundles & leftovers…" : <><b>{sorted.length.toLocaleString()}</b> installed · <b>{bytes(totalFootprint)}</b> total</>}
          </span>
        </div>
        <div className="db-tab-head-actions">
          <button type="button" className="db-outline auto" disabled={busy} onClick={() => void load(true)}>
            <RefreshCwIcon size={14} /> Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="db-pop-failed" style={{ margin: "0 0 14px" }}>
          <strong>Couldn’t list applications</strong>
          <p style={{ margin: 0, fontSize: 11 }}>{error}</p>
        </div>
      )}

      {failPaths && (
        <div className="db-pop-failed" role="alert" style={{ margin: "0 0 14px" }}>
          <strong>Some locations need administrator rights</strong>
          <ul>
            {failPaths.slice(0, 6).map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
          <button
            type="button"
            className="db-outline compact danger" style={{ marginTop: 8 }}
            onClick={() => void invoke("restart_as_admin", { scanTarget: "ThisPC", turbo: false }).catch(() => undefined)}
          >
            <ShieldIcon size={13} /> Restart as administrator
          </button>
        </div>
      )}

      {busy && !apps && (
        // Structure preview (loading system v2): app-row skeletons keep
        // the table's rhythm instead of collapsing to a spinner-in-a-void.
        <>
          <SkeletonRows rows={7} className="db-tab-skeleton" />
          <div className="db-loading-block" role="status">
            <span>Listing registry + Store apps, measuring sizes…</span>
          </div>
        </>
      )}

      {sorted.map((app) => {
        const isOpen = expanded.has(app.id);
        const leftoversTotal = app.leftovers.reduce((a, g) => a + g.size, 0);
        return (
          <div key={app.id} className="db-app-row" style={{ display: "block" }}>
            <div style={{ display: "grid", gridTemplateColumns: "44px minmax(0,1fr) auto auto", alignItems: "center", gap: 14 }}>
              {app.icon ? (
                <img className="db-app-icon" src={app.icon} alt="" />
              ) : (
                <span className="db-app-icon-fallback">
                  <AppWindowIcon size={20} />
                </span>
              )}
              <div>
                <strong>{app.name}</strong>
                <div className="db-app-meta">
                  <em>{app.publisher || "—"}</em>
                  <span>v{app.version || "—"}</span>
                  <span>{app.lastUsed ? relativeAge(app.lastUsed, now) : "Last used: —"}</span>
                  {app.leftovers.length > 0 && (
                    <span className="db-leftover-count">+{app.leftovers.length} leftovers</span>
                  )}
                </div>
              </div>
              <b className="tnum">{bytes(app.total)}</b>
              <button
                type="button"
                className="db-outline compact db-app-uninstall"
                onClick={() => setConfirm(app)}
              >
                Uninstall
              </button>
            </div>
            <button
              type="button"
              className="db-outline compact" style={{ marginTop: 9, padding: "0 10px" }}
              onClick={() => setExpanded((s) => (s.has(app.id) ? new Set([...s].filter((x) => x !== app.id)) : new Set([...s, app.id])))}
            >
              {isOpen ? "Hide" : "Show"} breakdown{leftoversTotal > 0 ? ` · ${bytes(leftoversTotal)} leftovers` : ""}
            </button>
            {isOpen && (
              <div className="db-app-detail">
                {app.installLocation && (
                  <div className="db-app-detail-row">
                    <span>Program files</span>
                    <div><TailPath path={app.installLocation} /></div>
                    <b className="tnum">{bytes(app.bundleSize)}</b>
                  </div>
                )}
                {app.packageFullName && (
                  <div className="db-app-detail-row">
                    <span>Store package</span>
                    <div><TailPath path={app.packageFullName} /></div>
                    <b className="tnum">{bytes(app.bundleSize)}</b>
                  </div>
                )}
                {app.leftovers.map((g) => (
                  <div className="db-app-detail-row" key={g.label}>
                    <span>{g.label}</span>
                    {/* One TailPath line per path — a joined "p1 · p2"
                     * string would blunt-clip with no ellipsis (the
                     * container has overflow:hidden; nowrap). */}
                    <div>
                      {g.paths.map((p) => (
                        <TailPath key={p.path} path={p.path} />
                      ))}
                    </div>
                    <b className="tnum">{bytes(g.size)}</b>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {!busy && sorted.length === 0 && (
        <EmptyState icon={<PackageOpenIcon size={28} />} title="No applications found" body="Registry and Store enumeration found nothing — try Refresh." />
      )}

      {confirm && (
        <div className="db-scrim" role="dialog" aria-modal="true">
          <div className="db-dialog" ref={confirmRef}>
            <h3>Uninstall {confirm.name}?</h3>
            <p>
              <b>{bytes(confirm.bundleSize)}</b> program files · <b>{bytes(confirm.leftovers.reduce((a, g) => a + g.size, 0))}</b> leftovers.
              {" "}Running the app’s own uninstaller keeps the registry and installer state intact — program files are never trashed directly.
            </p>
            <div className="db-dialog-actions">
              <button type="button" className="db-outline auto" onClick={() => setConfirm(null)}>
                Cancel
              </button>
              {confirm.leftovers.length > 0 && (
                <button type="button" className="db-outline auto" onClick={() => stageLeftovers(confirm)}>
                  <Trash2Icon size={13} /> Stage leftovers only
                </button>
              )}
              <button
                type="button"
                className="db-ink-button auto"
                disabled={uninstalling}
                onClick={() => void runUninstall(confirm)}
              >
                <CheckIcon size={14} /> {uninstalling ? "Running…" : "Run uninstaller"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
