/**
 * Cleanup Queue popover (spec §9): 460×520 portal, opaque background,
 * click-outside/Esc; header (staged total, Clear, red Move-to-Recycle-
 * Bin), rows with reason + ✕, tray empty state, confirmation dialog
 * ("Items go to the Recycle Bin. Space is only freed when you empty
 * it." + Open Recycle Bin link) and a per-item failure alert.
 */
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CheckIcon, Trash2Icon, XIcon } from "./Icon";
import { TailPath } from "./TailPath";
import { useCleanupStore } from "../state/cleanup";
import { useLicenseStore } from "../state/license";
import { useScanStore } from "../state/scan";
import { useFocusTrap } from "../lib/useFocusTrap";
import { bytes } from "../lib/format";
import { BIN_NAME, IS_MAC } from "../lib/platform";
import { invoke } from "../lib/ipc";
import { SPRING_POP, EXIT_FAST } from "../lib/motion";

export interface CommitFailure {
  path: string;
  reason: string;
}

export function CleanupQueuePopover({
  open,
  onClose,
  anchor,
}: {
  open: boolean;
  onClose: () => void;
  anchor: "topbar";
}) {
  const items = useCleanupStore((s) => s.items);
  const remove = useCleanupStore((s) => s.remove);
  const clear = useCleanupStore((s) => s.clear);
  const commit = useCleanupStore((s) => s.commitToRecycleBin);
  const license = useLicenseStore((s) => s.status);
  const scanStatus = useScanStore((s) => s.status);
  const [confirming, setConfirming] = useState(false);
  const [committing, setCommitting] = useState(false);
  const confirmRef = useRef<HTMLDivElement>(null);
  useFocusTrap(confirmRef, confirming);
  const [failure, setFailure] = useState<{ count: number; failed: CommitFailure[]; error: string | null } | null>(null);
  const popRef = useRef<HTMLDivElement>(null);
  // Anchor to the toolbar Cleanup button's live position instead of a
  // hardcoded top:96 — the degrade banner shifts the topbar down and a
  // fixed offset leaves the popover floating detached from its button.
  const [anchorPos, setAnchorPos] = useState<{ right: number; top: number } | null>(null);
  useEffect(() => {
    if (!open) {
      setAnchorPos(null);
      return;
    }
    const measure = () => {
      const btn = document.querySelector<HTMLButtonElement>(".db-queue-button");
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      setAnchorPos({ right: Math.max(18, window.innerWidth - r.right), top: r.bottom + 10 });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open]);

  useEffect(() => {
    if (!open) {
      setConfirming(false);
      setFailure(null);
      return;
    }
    // Outside-close (capture phase). While the confirm dialog is open the
    // popover is effectively modal: the dialog renders as a sibling of the
    // popover (not inside popRef), so an unconditional containment check
    // would unmount the tree on the pointerdown that precedes every dialog
    // button click — Cancel and Commit could never fire. Suspend
    // outside-close while confirming; the dialog's own scrim/Esc handles
    // dismissal.
    const onDown = (e: PointerEvent) => {
      if (confirming) return;
      if (popRef.current && !popRef.current.contains(e.target as Node)) onClose();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (confirming) setConfirming(false);
        else onClose();
      }
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", esc);
    };
  }, [open, onClose, confirming]);

  const total = items.reduce((a, i) => a + i.size, 0);
  const freeCap = license?.freeCommitCap ?? 0;
  const overFreeCap = !license?.isPro && freeCap > 0 && total > freeCap;
  // Committing needs a settled tree; during a rescan the generation
  // mismatches and the server would refuse. Disable with a clear
  // reason instead of surfacing a jargon error after the click.
  const scanRunning = scanStatus === "scanning";

  const doCommit = async () => {
    setCommitting(true);
    setFailure(null);
    const committingItems = items;
    try {
      const result = await commit();
      const failed = result.failed;
      if (failed.length > 0) {
        setFailure({ count: failed.length, failed, error: null });
      } else {
        setConfirming(false);
        onClose();
        // Success feedback: the popover closing over an updated tree is
        // too quiet for a destructive-feeling action — confirm WHAT
        // moved and remind that emptying the bin frees the space.
        const moved = result.trashed.length;
        const freed = committingItems
          .filter((i) => result.trashed.some((t) => t.path === i.path))
          .reduce((a, i) => a + i.size, 0);
        window.dispatchEvent(
          new CustomEvent("db-toast", {
            detail: {
              text: `Moved ${moved.toLocaleString()} item${moved === 1 ? "" : "s"} · ${bytes(freed)} to the ${BIN_NAME} — empty it to free the space.`,
              icon: "trash",
            },
          }),
        );
      }
    } catch (e) {
      setFailure({ count: 0, failed: [], error: String(e) });
    } finally {
      setCommitting(false);
    }
  };

  return (
    <>
      <AnimatePresence>
        {open && anchorPos && (
          <motion.div
            ref={popRef}
            className="db-pop"
            style={anchor === "topbar" ? { right: anchorPos.right, top: anchorPos.top } : undefined}
            role="dialog"
            aria-label="Cleanup Queue"
            initial={{ opacity: 0, y: -8, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98, transition: EXIT_FAST }}
            transition={SPRING_POP}
          >
            <div className="db-pop-head">
              <div>
                <h3>Cleanup Queue</h3>
                <span className="db-pop-total tnum">{items.length > 0 ? `${bytes(total)} staged` : "Nothing staged"}</span>
              </div>
              <button type="button" className="db-pop-close" onClick={onClose} aria-label="Close">
                <XIcon size={15} />
              </button>
            </div>
            <div className="db-pop-actions">
              <button type="button" className="db-btn-clear" disabled={items.length === 0} onClick={clear}>
                Clear
              </button>
              <button
                type="button"
                className="db-btn-commit"
                disabled={items.length === 0 || committing || overFreeCap || scanRunning}
                title={
                  overFreeCap
                    ? `Free tier caps cleanup at ${bytes(freeCap)} — activate DiskBytes Pro to clean more`
                    : scanRunning
                      ? "Wait for the scan to finish — cleaning needs a settled map"
                      : undefined
                }
                onClick={() => setConfirming(true)}
              >
                <Trash2Icon size={14} />
                {committing ? "Moving…" : `Move to ${BIN_NAME}…`}
              </button>
            </div>
            {failure && (
              <div className="db-pop-failed" role="alert">
                <strong>{failure.error ? "Commit failed" : `Couldn’t recycle ${failure.count} item(s)`}</strong>
                {failure.error ? (
                  <p style={{ margin: 0, fontSize: 11 }}>{failure.error}</p>
                ) : (
                  <ul>
                    {failure.failed.slice(0, 8).map((f) => (
                      <li key={f.path} title={f.path}>
                        {f.reason} — {f.path}
                      </li>
                    ))}
                  </ul>
                )}
                <button
                  type="button"
                  className="db-outline compact" style={{ marginTop: 8 }}
                  onClick={() => setFailure(null)}
                >
                  Dismiss
                </button>
              </div>
            )}
            {items.length === 0 ? (
              <div className="db-pop-empty">
                <span className="db-pop-empty-icon">
                  <Trash2Icon size={24} />
                </span>
                <p>Nothing staged yet — pick folders or files you want gone, then commit them in one move.</p>
              </div>
            ) : (
              <div className="db-pop-list db-scroll">
                {items.map((i) => (
                  <div key={`${i.id}:${i.path}`} className="db-pop-row">
                    <Trash2Icon size={14} />
                    <div className="db-pop-item">
                      <TailPath path={i.path} className="db-pop-path" />
                      <small>{i.reason}</small>
                    </div>
                    <b className="tnum">{bytes(i.size)}</b>
                    <button
                      type="button"
                      className="db-pop-remove"
                      aria-label={`Remove ${i.path}`}
                      onClick={() => remove(i.id, i.path)}
                    >
                      <XIcon size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {open && confirming && (
        <div className="db-scrim" role="dialog" aria-modal="true">
          <div className="db-dialog" ref={confirmRef}>
            <h3>Move {items.length.toLocaleString()} item{items.length === 1 ? "" : "s"} to the {BIN_NAME}?</h3>
            <p>
              {items.length.toLocaleString()} item{items.length === 1 ? "" : "s"} · {bytes(total)} of data.{" "}
              {IS_MAC
                ? `Items go to the Trash. Space is only freed when you empty it.`
                : `Items go to the Recycle Bin. Space is only freed when you empty it.`}
            </p>
            <button
              type="button"
              className="db-dialog-link"
              onClick={() => void invoke("open_recycle_bin").catch(() => undefined)}
            >
              <CheckIcon size={12} /> Open {BIN_NAME}
            </button>
            <div className="db-dialog-actions">
              <button type="button" className="db-outline auto" onClick={() => setConfirming(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="db-ink-button auto danger"
                disabled={committing}
                onClick={() => void doCommit()}
              >
                <Trash2Icon size={14} />
                {committing ? "Moving…" : `Move to ${BIN_NAME}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
