/**
 * Monitor store (spec §12): the sampler session is APP-LIFETIME, not
 * tab-lifetime. It is started once at boot (App.tsx calls
 * `bootstrapMonitor()` before the first tab renders) so opening the
 * Monitor tab shows live data immediately instead of the old
 * mount-then-wait-2s cadence. MonitorView is a pure consumer of the
 * ring — it no longer owns start/stop, so leaving the tab never stops
 * the sampler (the Rust thread exits with the app anyway, and the
 * 2s cadence at idle is negligible next to a scan).
 *
 * Session semantics are preserved from the Rust engine: a session
 * number is handed back by `monitor_start` and stale stops are
 * ignored. We simply never issue a stop for the app-lifetime session.
 */
import { create } from "zustand";
import { invoke, listen } from "../lib/ipc";

export interface MonitorSample {
  dtMs: number;
  cpuUserPct: number;
  cpuSystemPct: number;
  cpuTotalPct: number;
  threads: number;
  processes: number;
  memTotal: number;
  memAvailable: number;
  kernelPaged: number;
  kernelNonpaged: number;
  systemCache: number;
  commitTotal: number;
  commitLimit: number;
  compressed: number | null;
  netDownBps: number;
  netUpBps: number;
  sessionIn: number;
  sessionOut: number;
  volumes: { root: string; label: string; total: number; free: number }[];
  procs: { pid: number; name: string; cpuPct: number; ws: number }[];
  totalProcs: number;
}

export const MONITOR_RING = 120;

interface MonitorStore {
  ring: MonitorSample[];
  started: boolean;
  error: string | null;
  /** Idempotent boot call — safe under StrictMode double-invoke. */
  start: () => void;
}

let unlisten: (() => void) | null = null;
let starting = false;

export const useMonitorStore = create<MonitorStore>((set, get) => ({
  ring: [],
  started: false,
  error: null,
  start: () => {
    if (starting || get().started) return;
    starting = true;
    void (async () => {
      try {
        // Re-usable (Retry from the error state): detach any listener
        // a failed earlier attempt left behind — a second one would
        // double every sample into the ring.
        unlisten?.();
        unlisten = null;
        const un = await listen<MonitorSample>("monitor-sample", (s) => {
          set({ ring: [...get().ring.slice(-(MONITOR_RING - 1)), s] });
        });
        unlisten = un;
        await invoke<number>("monitor_start");
        // started ONLY on success — the error branch must stay reachable
        // (MonitorView renders its error state when error && !started;
        // setting both made the skeleton run forever on failure).
        set({ started: true, error: null });
      } catch (e) {
        set({ error: String(e) });
      } finally {
        starting = false;
      }
    })();
  },
}));

/** Called once at app boot (see App.tsx). */
export function bootstrapMonitor() {
  useMonitorStore.getState().start();
}

/** Test/teardown hook — production code never stops the app-lifetime session. */
export function teardownMonitor() {
  unlisten?.();
  unlisten = null;
}
