/**
 * Sidebar §4 (spec §6.6): current view — folder name + scan duration,
 * full path in monospace (middle-truncated), Reveal + Copy Path
 * (Copied ✓ transient). Shows a live progress strip while scanning.
 */
import { useEffect, useState } from "react";
import { CopyIcon, EyeIcon } from "../components/Icon";
import { OutlineButton, SectionCaption, Spinner } from "../components/buttons";
import { TailPath } from "../components/TailPath";
import { invoke } from "../lib/ipc";
import { bytes, duration } from "../lib/format";
import { REVEAL_NAME } from "../lib/platform";
import { useExploreStore } from "../state/explore";
import { useScanStore } from "../state/scan";

export function CurrentViewSection() {
  const status = useScanStore((s) => s.status);
  const progress = useScanStore((s) => s.progress);
  const generation = useScanStore((s) => s.generation);
  const scanDurationMs = useScanStore((s) => s.scanDurationMs);
  const currentFolder = useExploreStore((s) => s.currentFolder);
  const [view, setView] = useState<{ name: string; path: string; ms: number } | null>(null);

  useEffect(() => {
    if (status !== "done") {
      setView(null);
      return;
    }
    let disposed = false;
    void (async () => {
      try {
        const crumbs = await invoke<{ id: number; name: string }[]>("get_breadcrumb", {
          generation,
          node: currentFolder,
        });
        if (disposed) return;
        const name = crumbs.length > 0 ? crumbs[crumbs.length - 1].name : "This PC";
        const details = await invoke<{ path: string }>("node_details", { generation, id: currentFolder }).catch(
          () => null,
        );
        if (disposed) return;
        const ms = scanDurationMs ?? 0;
        setView({ name, path: details?.path ?? "", ms });
      } catch {
        /* stale generation — silently drop (spec §9) */
      }
    })();
    return () => {
      disposed = true;
    };
  }, [status, generation, currentFolder, scanDurationMs]);

  const reveal = () => {
    void invoke("reveal_in_explorer", { generation, id: currentFolder }).catch(() => undefined);
  };

  const copy = () => {
    void invoke("copy_path", { generation, id: currentFolder }).catch(() => undefined);
    // Browser-dev fallback: put the path on the clipboard ourselves.
    if (view?.path) void navigator.clipboard?.writeText(view.path).catch(() => undefined);
  };

  return (
    <>
      <SectionCaption right={view?.ms ? `${duration(view.ms)} scan` : undefined}>Current view</SectionCaption>
      {status === "scanning" && progress && (
        <div className="db-scan-strip" data-testid="scan-strip">
          <div className="db-scan-row">
            <Spinner size={16} />
            <span className="tnum">
              {progress.files.toLocaleString()} files · {bytes(progress.bytes)}
            </span>
          </div>
          <div className="db-scan-row db-scan-path" title={progress.currentPath}>
            {progress.currentPath}
          </div>
          <div className="db-scan-bar">
            <i />
          </div>
        </div>
      )}
      {view && (
        <div className="db-current">
          <strong>{view.name}</strong>
          {view.path ? (
            <TailPath path={view.path} className="db-current-path" />
          ) : (
            <span className="db-current-path">—</span>
          )}
          <div className="db-sidebar-actions" style={{ marginTop: 9 }}>
            <OutlineButton onClick={reveal} title={REVEAL_NAME}>
              <EyeIcon size={14} /> Reveal
            </OutlineButton>
            <OutlineButton confirmText="Copied ✓" onConfirm={copy}>
              <CopyIcon size={14} /> Copy Path
            </OutlineButton>
          </div>
        </div>
      )}
    </>
  );
}
