/**
 * Tour driver (dev hook §15 extension, CI-only): DISKBYTES_TOUR=1 (or
 * ?tour=1 in browser-dev) auto-cycles through every tab, every mode,
 * popovers and dialogs with ~2.6 s dwell so CI screenshot passes can
 * capture every state of the real app without interactive automation.
 * It sets window.__DB_TOUR_STATE after each step for the harness.
 */
import { useEffect } from "react";
import { useViewStore } from "../state/view";
import { useVizUiStore, MODES } from "../state/vizUi";
import { useScanStore } from "../state/scan";
import { useExploreStore } from "../state/explore";
import { useCleanupStore } from "../state/cleanup";

interface Step {
  name: string;
  apply: () => void;
  /** Dwell multiplier (× DWELL_MS). Theme flips need ≥2 capture passes:
   * the CI harness samples every 2.6 s, so a 1× dwell can fall entirely
   * between captures — round 16's tour never captured dark mode at all
   * (all 26 frames light). 3× guarantees ≥2 samples per theme. */
  dwell?: number;
}

const DWELL_MS = 2600;

export function TourDriver() {
  useEffect(() => {
    let timer: number | null = null;
    let disposed = false;
    void (async () => {
      const hooks = await import("../lib/ipc").then(({ invoke }) =>
        invoke<{ tour: boolean }>("get_dev_hooks").catch(() => ({ tour: false })),
      );
      if (!hooks?.tour || disposed) return;

      const waitScanDone = async (): Promise<void> => {
        for (let i = 0; i < 60; i++) {
          if (useScanStore.getState().status === "done") return;
          await new Promise((r) => window.setTimeout(r, 500));
        }
      };
      await waitScanDone();

      const steps: Step[] = [];
      // every Explore mode
      for (const mode of MODES) {
        steps.push({
          name: `explore-${mode.replace(/\s+/g, "-").toLowerCase()}`,
          apply: () => {
            useViewStore.getState().setTab("explore");
            useVizUiStore.getState().setMode(mode);
          },
        });
      }
      // color modes on treemap
      for (const color of ["by-folder", "by-type", "by-age"] as const) {
        steps.push({
          name: `treemap-color-${color}`,
          apply: () => {
            useViewStore.getState().setTab("explore");
            useVizUiStore.getState().setMode("Treemap");
            useVizUiStore.getState().setColorMode(color);
          },
        });
      }
      // theme flips — 3× dwell (see Step.dwell): guarantees the CI
      // 2.6 s capture cadence samples each theme at least twice
      steps.push({
        name: "dark-theme",
        dwell: 3,
        apply: () => document.documentElement.setAttribute("data-theme", "dark"),
      });
      steps.push({
        name: "light-theme",
        dwell: 3,
        apply: () => document.documentElement.setAttribute("data-theme", "light"),
      });
      // the other tabs
      for (const t of ["duplicates", "applications", "monitor", "snapshots"] as const) {
        steps.push({
          name: `tab-${t}`,
          apply: () => useViewStore.getState().setTab(t),
        });
      }
      // duplicates: RUN the scan (10× dwell = 26 s — the Windows
      // runner's real-time Defender charges ~0.6 s per first-open of
      // the freshly-staged tree, so the real pipeline lands at ~25 s;
      // the dwell must cover it so the RESULT state gets captured,
      // not just the busy row). Switch to the tab,
      // then fire once the view is mounted + subscribed (poll — a fixed
      // delay races the veil swap's mount). The busy row and the group
      // cards are what production screenshots must show — the empty
      // state alone verified nothing about the pipeline.
      steps.push({
        name: "duplicates-run",
        dwell: 10,
        apply: () => {
          useViewStore.getState().setTab("duplicates");
          const fire = () => window.dispatchEvent(new CustomEvent("db-tour-dupes-run"));
          let tries = 0;
          const waitMount = () => {
            const h1 = document.querySelector(".db-main-col h1");
            const heading = [...document.querySelectorAll(".db-main-col h1")].map((h) => h.textContent);
            const mounted = heading.includes("Duplicates") || h1?.textContent === "Duplicates";
            if (mounted || tries > 40) fire();
            else {
              tries += 1;
              window.setTimeout(waitMount, 50);
            }
          };
          window.setTimeout(waitMount, 120);
        },
      });
      // license dialog open + pro posture
      steps.push({
        name: "license-dialog",
        apply: () => {
          useViewStore.getState().setTab("explore");
          window.dispatchEvent(new CustomEvent("db-tour-open-license"));
        },
      });
      // queue with one item (stage the current folder)
      steps.push({
        name: "cleanup-queue",
        apply: () => {
          const folder = useExploreStore.getState().currentFolder;
          useCleanupStore.getState().stage({ id: folder, path: "C:\\Users\\dev\\Downloads", size: 41_900_000_000, reason: "Downloads — Quick win" });
          window.dispatchEvent(new CustomEvent("db-open-queue"));
        },
      });

      let i = 0;
      const advance = () => {
        if (disposed || i >= steps.length) return;
        window.dispatchEvent(new CustomEvent("db-tour-step"));
        const step = steps[i];
        step.apply();
        (window as unknown as Record<string, unknown>).__DB_TOUR_STATE = { step: i, name: step.name, total: steps.length };
        i += 1;
        if (i < steps.length) timer = window.setTimeout(advance, DWELL_MS * (step.dwell ?? 1));
        else (window as unknown as Record<string, unknown>).__DB_TOUR_DONE = true;
      };
      advance();
    })();

    // license/queue open events (dialog state lives in App)
    const onLicense = () => window.dispatchEvent(new CustomEvent("db-open-license"));
    window.addEventListener("db-tour-open-license", onLicense);
    const onQueue = () => window.dispatchEvent(new CustomEvent("db-open-queue"));
    window.addEventListener("db-tour-open-queue", onQueue);
    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
      window.removeEventListener("db-tour-open-license", onLicense);
      window.removeEventListener("db-tour-open-queue", onQueue);
    };
  }, []);
  return null;
}

// App listens for these to open the overlays during a tour.
declare global {
  interface Window {
    __DB_TOUR_STATE?: { step: number; name: string; total: number };
    __DB_TOUR_DONE?: boolean;
  }
}
