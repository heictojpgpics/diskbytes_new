/**
 * Inspector (spec §8): the selected node or current folder — icon +
 * name + kind, full path (selectable mono), big size + % of scan,
 * Details card with the conditional savings (green) / cluster overhead
 * (secondary) rows, Largest Inside ranked list, action buttons
 * (Reveal / Preview / Focus / Copy Path), and the Add-to-Cleanup
 * toggle (disabled + tooltip for protected items).
 */
import { useEffect, useRef, useState } from "react";
import { CopyIcon, EyeIcon, ExternalLinkIcon, FolderIcon, HardDriveIcon, LockKeyholeIcon, SparklesIcon, Trash2Icon, CheckIcon, CloudIcon, TONE_KEYS } from "../components/Icon";
import { categoryIcon } from "../components/Icon";
import { getNodeDetails, type NodeDetailsData } from "../viz/exploreIpc";
import { invoke } from "../lib/ipc";
import { bytes, relativeAge } from "../lib/format";
import { TailPath } from "../components/TailPath";
import { Spinner } from "../components/buttons";
import { useExploreStore } from "../state/explore";
import { useScanStore } from "../state/scan";
import { useCleanupStore } from "../state/cleanup";

// One tone order app-wide (Icon.tsx is the source).
const TONES = TONE_KEYS;

/** Stable tone for an item: hash the PATH (stable across scans and
 * generations). The old id-modulo made the same folder change icon
 * color between scans — node ids are scan-local. */
function toneFor(path: string): string {
  let h = 5381;
  for (let i = 0; i < path.length; i++) h = ((h << 5) + h + path.charCodeAt(i)) | 0;
  return TONES[Math.abs(h) % TONES.length];
}

export function InspectorPanel({ onPreview }: { onPreview: (id: number) => void }) {
  // Copy-path transient feedback (mirrors OutlineButton confirm swap);
  // timer-tracked so rapid repeat clicks never cut the feedback short.
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);
  const generation = useScanStore((s) => s.generation);
  const status = useScanStore((s) => s.status);
  const currentFolder = useExploreStore((s) => s.currentFolder);
  const selectedNode = useExploreStore((s) => s.selectedNode);
  const openFolder = useExploreStore((s) => s.openFolder);
  const contains = useCleanupStore((s) => s.contains);
  const stage = useCleanupStore((s) => s.stage);
  const unstage = useCleanupStore((s) => s.unstage);
  const [details, setDetails] = useState<NodeDetailsData | null>(null);

  const target = selectedNode ?? currentFolder;

  useEffect(() => {
    if (status !== "done") {
      setDetails(null);
      return;
    }
    let disposed = false;
    void (async () => {
      const d = await getNodeDetails(generation, target).catch(() => null);
      if (!disposed) setDetails(d);
    })();
    return () => {
      disposed = true;
    };
  }, [status, generation, target]);

  if (status !== "done") {
    if (status === "scanning") {
      return (
        <aside className="db-inspector db-scroll" aria-label="Inspector">
          <div className="db-inspector-empty">
            <span className="db-inspector-scan-badge">
              <Spinner size={15} />
            </span>
            <h3>Scanning…</h3>
            <p>Details for the selected item appear here the moment the scan finishes.</p>
          </div>
        </aside>
      );
    }
    return (
      <aside className="db-inspector db-scroll" aria-label="Inspector">
        <div className="db-inspector-empty db-inspector-welcome">
          <span className="db-inspector-scan-badge">
            <EyeIcon size={17} />
          </span>
          <h3>Inspector</h3>
          <p>
            Select any folder or file — the map, the list, or the tree — and its size, largest
            items and cleanup actions live here.
          </p>
          <div className="db-inspector-hints">
            <span><FolderIcon size={11} /> Double-click a folder to drill in</span>
            <span><SparklesIcon size={11} /> Click to select, inspect, clean</span>
          </div>
        </div>
      </aside>
    );
  }

  if (!details) {
    return (
      <aside className="db-inspector db-scroll" aria-label="Inspector">
        <div className="db-loading-block">
          <Spinner size={16} />
        </div>
      </aside>
    );
  }

  const now = Math.floor(Date.now() / 1000);
  // Drives carry kind "Disk" (backend) — the hard-drive glyph matches the
  // sidebar's drive rows; folders the folder glyph; files the category.
  const KindIcon = details.kind === "Disk"
    ? HardDriveIcon
    : details.isDir
      ? FolderIcon
      : categoryIcon(details.kind);
  const staged = contains(details.id);
  const kindColor = `#${details.kindColor.toString(16).padStart(6, "0")}`;
  // The synthetic This-PC root (multi-drive scan): node_path yields the
  // LABEL "This PC", not a real path. Staging it would hand the shell a
  // nonexistent path — the commit fails with a confusing alert. Real
  // roots always carry a separator/drive marker (C:\, /home/…).
  const isVirtualRoot = details.id === 0 && !/[\\/:]/.test(details.path);

  const doStage = () => {
    if (details.isProtected || isVirtualRoot) return;
    if (staged) unstage(details.id);
    else stage({ id: details.id, path: details.path, size: details.size, reason: "Manual" });
  };

  return (
    <aside className="db-inspector db-scroll" aria-label="Inspector">
      <div className="db-inspector-title">
        <span className={`db-file-icon tone-${toneFor(details.path)}`}>
          <KindIcon size={24} />
        </span>
        <div>
          <h2>{details.name}</h2>
          <span className="db-kind">
            <i style={{ background: kindColor }} />
            {/* Backend kind: "Disk" for drive roots, "Folder" otherwise
                (compute_details / mock nodeDetails parity). */}
            {details.kind}
          </span>
        </div>
      </div>
      <p className="db-path" title={details.path}>
        <TailPath path={details.path} />
      </p>
      <div className="db-big-size">
        <strong className="tnum">{bytes(details.size)}</strong>
        <span className="tnum">{(details.shareOfScan * 100).toFixed(1)}% of scan</span>
      </div>
      {details.isCloud && (
        <div className="db-cloud-note">
          <CloudIcon size={12} /> Stored in the cloud (not downloaded)
        </div>
      )}

      <section className="db-inspector-card">
        <header>
          <span>Details</span>
        </header>
        <div className="db-detail">
          <span>Size on disk</span>
          <b className="tnum">{bytes(details.size)}</b>
        </div>
        <div className="db-detail">
          <span>Logical size</span>
          <b className="tnum">{bytes(details.logical)}</b>
        </div>
        {details.savings > 0 && (
          <div className="db-detail">
            <span>Compressed / sparse savings</span>
            <b className="accent tnum">{bytes(details.savings)}</b>
          </div>
        )}
        {details.overhead > 0 && (
          <div className="db-detail">
            <span>Cluster overhead</span>
            <b className="secondary tnum">{bytes(details.overhead)}</b>
          </div>
        )}
        <div className="db-detail">
          <span>{details.isDir ? "Files" : "Kind"}</span>
          <b className="tnum">{details.isDir ? details.files.toLocaleString() : details.kind}</b>
        </div>
        {details.isDir && (
          <div className="db-detail">
            <span>Folders</span>
            <b className="tnum">{details.folders.toLocaleString()}</b>
          </div>
        )}
        <div className="db-detail">
          <span>Of parent</span>
          <b className="tnum">{(details.ofParent * 100).toFixed(1)}%</b>
        </div>
        <div className="db-detail">
          <span>Modified</span>
          <b>{relativeAge(details.modified, now)}</b>
        </div>
        <div className="db-detail">
          <span>Created</span>
          <b>{details.created > 0 ? relativeAge(details.created, now) : "—"}</b>
        </div>
      </section>

      {details.isDir && details.largest.length > 0 && (
        <section className="db-inspector-card">
          <header>
            <span>Largest inside</span>
            <span>{details.largest.length} items</span>
          </header>
          {details.largest.map((l, i) => (
            <button key={l.id} type="button" className="db-largest" onClick={() => useExploreStore.getState().select(l.id)} title={l.name}>
              <span>
                <i className={`tone-${TONES[(i + 1) % TONES.length]}`} />
                <em>{l.name}</em>
              </span>
              <b className="tnum">{bytes(l.size)}</b>
            </button>
          ))}
        </section>
      )}

      <div className="db-inspector-actions">
        {/* Icon metaphors match the context menu: eye = Preview (look),
         * external-link = Reveal (open in Explorer). The inspector had
         * them SWAPPED — the same two concepts showed opposite icons
         * on two surfaces one click apart. */}
        <button type="button" className="db-outline" onClick={() => void invoke("reveal_in_explorer", { generation, id: details.id }).catch(() => undefined)}>
          <ExternalLinkIcon size={14} /> Reveal
        </button>
        <button type="button" className="db-outline" disabled={details.isCloud} onClick={() => onPreview(details.id)} title={details.isCloud ? "Cloud placeholders are never previewed" : "Preview"}>
          <EyeIcon size={14} /> Preview
        </button>
        <button
          type="button"
          className="db-outline"
          onClick={() => {
            if (details.isDir) openFolder(details.id);
            else openFolder(currentFolder);
          }}
        >
          <SparklesIcon size={14} /> Focus
        </button>
        <button
          type="button"
          className="db-outline"
          onClick={() => {
            void invoke("copy_path", { generation, id: details.id }).catch(() => undefined);
            void navigator.clipboard?.writeText(details.path).catch(() => undefined);
            setCopied(true);
            if (copyTimer.current != null) window.clearTimeout(copyTimer.current);
            copyTimer.current = window.setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />} {" "}{copied ? "Copied" : "Copy Path"}
        </button>
      </div>

      <button
        type="button"
        className={`db-cleanup ${staged ? "is-staged" : ""}`}
        disabled={details.isProtected || isVirtualRoot}
        title={
          details.isProtected
            ? "Windows manages this item"
            : isVirtualRoot
              ? "This PC is a view of all drives — open a drive or folder, then stage what you want to clean"
              : staged
                ? "Staged — click to unstage"
                : "Add to the Cleanup Queue"
        }
        onClick={doStage}
      >
        {staged ? <CheckIcon size={15} /> : <Trash2Icon size={15} />}
        {staged
          ? "Staged for Cleanup"
          : details.isProtected
            ? "Managed by Windows"
            : isVirtualRoot
              ? "Open a drive or folder first"
              : "Add to Cleanup"}
      </button>
      {details.isProtected && (
        <div className="db-cloud-note" style={{ marginTop: 8 }}>
          <LockKeyholeIcon size={12} /> Windows manages this item — it can’t be staged.
        </div>
      )}
    </aside>
  );
}
