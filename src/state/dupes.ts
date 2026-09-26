/**
 * Duplicates-scan state (spec §10 + the session-5 state-management fix):
 * the scan lifecycle lives HERE — a module-level store with ONE
 * persistent `dupes-progress` listener attached at app boot — so tab
 * switches can no longer orphan a running multi-GB pipeline. The old
 * design kept busy/progress/result in DuplicatesView's component
 * state: leaving the tab dropped the listener and the promise's
 * landing spot, and the remount showed "Start scan" over a scan that
 * was still hashing.
 *
 * The Rust half mirrors this: `AppState.dupes_status` carries the
 * run's live snapshot + sticky result; `refresh()` pulls it so a
 * remounted view re-attaches mid-scan (progress ticks continue via
 * the persistent listener).
 *
 * Blink contract for the busy row: the engine's DTO carries a
 * monotonic `overall` fraction (weighted phases) and cumulative
 * `bytesDoneAll` — the bar and rate never reset at phase boundaries.
 */
import { create } from "zustand";
import { invoke, listen, type UnlistenFn } from "../lib/ipc";
import { EVENTS, track } from "../lib/analytics";

export interface DupeGroup {
  id: number;
  paths: string[];
  size: number;
  count: number;
  wasted: number;
}

export interface DupesResult {
  generation: number;
  groups: DupeGroup[];
  wastedTotal: number;
  files: number;
}

/** The `dupes-progress` event payload (camelCase DTO from Rust). */
export interface DupesProgress {
  phase: "collect" | "prefix" | "screen" | "full" | "done" | "cancelled";
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  bytesTotal: number;
  elapsedMs: number;
  /** Cumulative across phases — the honest rate source (monotonic). */
  filesDoneAll: number;
  /** Cumulative across phases — never resets at boundaries. */
  bytesDoneAll: number;
  /** Weighted global fraction [0..1] — the bar source (monotonic). */
  overall: number;
}

/** The `dupes_status` command payload. */
export interface DupesStatusSnapshot {
  running: boolean;
  generation: number;
  progress: DupesProgress | null;
  result: DupesResult | null;
  error: string | null;
}

interface DupesStore {
  running: boolean;
  progress: DupesProgress | null;
  result: DupesResult | null;
  error: string | null;
  /** Start (or join) a scan against `generation`. Re-entrant safe. */
  start: (generation: number) => void;
  /** Ask the backend for its app-lifetime status (mount re-attach). */
  refresh: () => Promise<void>;
  /** Cooperative cancel (quiet reset — no error banner). */
  cancel: () => void;
  /** Drop a tree-stale result (new disk scan / cleanup commit). */
  invalidate: (generation: number) => void;
  /** Attach the persistent event listener (once, app boot). */
  attach: () => void;
}

let listenersAttached = false;
let unlisten: UnlistenFn | null = null;
/** Throttle: coalesce the ~200 ms engine ticks into ≤ ~9 Hz store
 * writes — the busy row re-renders on store changes only, and every
 * write carries a full object identity anyway. Phase/terminal events
 * flush immediately. */
let pending: DupesProgress | null = null;
let flushTimer: number | null = null;

function flushProgress(): void {
  if (flushTimer !== null) {
    window.clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (pending) {
    // `running` never changes on a tick — the invoke's resolve/reject
    // owns it (the store is the single writer, ticks only mirror).
    useDupesStore.setState({ progress: pending });
    pending = null;
  }
}

export const useDupesStore = create<DupesStore>((set, get) => ({
  running: false,
  progress: null,
  result: null,
  error: null,

  start: (generation) => {
    if (get().running) return; // the engine also rejects ("already running")
    set({ running: true, progress: null, result: null, error: null });
    void invoke<DupesResult>("find_duplicates", { generation })
      .then((res) => {
        set({ running: false, progress: null, result: res, error: null });
        track(EVENTS.duplicatesScanCompleted, { groups: res.groups.length, wasted: res.wastedTotal });
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        // Cancellation is a USER action, not a failure — quiet reset.
        if (!/cancel/i.test(msg)) {
          set({ running: false, progress: null, error: msg });
        } else {
          set({ running: false, progress: null, error: null });
        }
      });
  },

  refresh: async () => {
    try {
      const st = await invoke<DupesStatusSnapshot>("dupes_status");
      set({
        running: st.running,
        progress: st.running ? st.progress : null,
        result: st.result,
        error: st.error,
      });
    } catch {
      // Command missing (older engine) — keep local state.
    }
  },

  cancel: () => {
    void invoke("cancel_duplicates").catch(() => undefined);
  },

  invalidate: (generation) => {
    const s = get();
    if (s.result && s.result.generation !== generation) {
      set({ result: null, error: null, progress: null });
    }
    // A running scan against a dead tree: the backend's start_scan
    // already bumped the cancel generation; the invoke resolves on its
    // own and clears `running`. Nothing to force here.
  },

  attach: () => {
    if (listenersAttached) return;
    listenersAttached = true;
    void listen<DupesProgress>("dupes-progress", (p) => {
      if (!useDupesStore.getState().running) return; // stale tail ticks
      const terminal = p.phase === "done" || p.phase === "cancelled";
      if (terminal || pending === null) {
        pending = p;
        flushProgress();
        return;
      }
      pending = p;
      if (flushTimer === null) {
        flushTimer = window.setTimeout(flushProgress, 110);
      }
    }).then((u) => {
      unlisten = u;
    }).catch(() => undefined);
  },
}));

/** App-boot wiring (idempotent; called once from AppShell). */
export function bootstrapDupes(): void {
  useDupesStore.getState().attach();
}

/** Test seam: detach + reset between vitest cases. */
export function __resetDupesForTests(): void {
  unlisten?.();
  unlisten = null;
  listenersAttached = false;
  pending = null;
  if (flushTimer !== null) window.clearTimeout(flushTimer);
  flushTimer = null;
  useDupesStore.setState({ running: false, progress: null, result: null, error: null });
}
