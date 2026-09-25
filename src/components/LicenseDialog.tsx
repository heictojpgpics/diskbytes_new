/**
 * License dialog (doc 06): activation key entry with clear Dodo error
 * copy, validate-now, deactivate; the free-tier cap explanation and
 * Pro perks. Demo/test credentials work end-to-end; live keys drop in
 * via the Dodo dashboard without code changes (BASE_TEST/BASE_LIVE).
 */
import { useEffect, useRef, useState } from "react";
import { CheckIcon, KeyIcon, SparklesIcon } from "./Icon";
import { useLicenseStore } from "../state/license";
import { useFocusTrap } from "../lib/useFocusTrap";
import { bytes as fmtBytes } from "../lib/format";

export function LicenseDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const status = useLicenseStore((s) => s.status);
  const activate = useLicenseStore((s) => s.activate);
  const deactivate = useLicenseStore((s) => s.deactivate);
  const validateNow = useLicenseStore((s) => s.validateNow);
  const busy = useLicenseStore((s) => s.busy);
  const error = useLicenseStore((s) => s.error);
  const [key, setKey] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, open);

  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [open, onClose]);

  if (!open) return null;

  const posture = status?.posture ?? "unlicensed";
  const isPro = posture === "pro" || posture === "grace";

  return (
    <div className="db-scrim" role="dialog" aria-modal="true" aria-label="License">
      <div className="db-dialog" ref={dialogRef}>
        <h3>{isPro ? "DiskBytes Pro" : "Activate DiskBytes"}</h3>
        {isPro ? (
          <>
            <p>
              {posture === "grace"
                ? `Pro · offline grace (${status?.graceDaysLeft ?? 0} days left). Reconnecting validates automatically.`
                : "This copy of DiskBytes is activated and validating."}
            </p>
            <div className="db-license-perks">
              <div><CheckIcon size={13} /> Unlimited cleanup queue size</div>
              <div><CheckIcon size={13} /> Duplicates finder</div>
              <div><CheckIcon size={13} /> App uninstaller with leftovers</div>
              <div><CheckIcon size={13} /> Snapshots & live monitor</div>
            </div>
            <div className="db-dialog-actions">
              <button type="button" className="db-outline auto" disabled={busy} onClick={() => void validateNow()}>
                Validate now
              </button>
              <button type="button" className="db-outline danger auto" disabled={busy} onClick={() => void deactivate()}>
                Deactivate
              </button>
              <button type="button" className="db-ink-button auto" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <p>
              Paste the license key from your purchase email. The free tier caps cleanup at{" "}
              {fmtBytes(status?.freeCommitCap ?? 0)} per commit; Pro removes the cap.
            </p>
            <div className="db-license-body">
              <label>
                LICENSE KEY
                <input
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder="db-pro-…"
                  spellCheck={false}
                  autoFocus
                />
              </label>
              {error && <div className="db-license-msg error" role="alert">{error}</div>}
              <div className="db-license-perks">
                <div><SparklesIcon size={13} /> Unlimited queue + every cleaning tool</div>
                <div><CheckIcon size={13} /> 14-day offline grace</div>
                <div><CheckIcon size={13} /> One key, both your PCs</div>
              </div>
            </div>
            <div className="db-dialog-actions">
              <button type="button" className="db-outline auto" onClick={onClose}>
                Later
              </button>
              <button
                type="button"
                className="db-ink-button auto"
                disabled={busy || key.trim().length === 0}
                onClick={() => void activate(key.trim())}
              >
                <KeyIcon size={14} />
                {busy ? "Activating…" : "Activate"}
              </button>
            </div>
          </>
        )}
        <button type="button" className="db-dialog-link" onClick={() => {
          void import("../lib/ipc").then(({ invoke }) =>
            invoke("open_url", { url: "https://diskbytes.app/pricing" }).catch(() => undefined),
          );
        }}>
          Buy a key — Dodo Payments checkout
        </button>
      </div>
    </div>
  );
}
