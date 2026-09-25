/**
 * Applications store (spec §11): keeps the installed-app list across
 * tab switches, tracks load state and errors. STREAMING: while the
 * Rust measurement pass runs, each completed 16-app chunk arrives as
 * an `applications-batch` event and lands in `partial` — the tab
 * renders those rows live (sorted by total) instead of a full
 * skeleton wait; `apps` is the authoritative snapshot from the
 * command's return (cache semantics unchanged).
 */
import { create } from "zustand";
import { invoke, listen, type UnlistenFn } from "../lib/ipc";

export interface LeftoverPath {
  path: string;
  size: number;
}

export interface LeftoverGroup {
  label: string;
  paths: LeftoverPath[];
  size: number;
}

export interface AppEntry {
  id: string;
  name: string;
  publisher: string;
  version: string;
  source: "registry" | "msix";
  installLocation: string;
  uninstallString: string;
  quietUninstallString: string;
  packageFullName: string;
  lastUsed: number | null;
  icon: string;
  bundleSize: number;
  leftovers: LeftoverGroup[];
  total: number;
}

export interface UninstallResult {
  closedProcesses: string[];
  exitCode: number;
  remainingLeftovers: LeftoverGroup[];
  removedEntry: boolean;
}

interface ApplicationsState {
  apps: AppEntry[] | null;
  /** Progressive rows streamed while the measurement pass runs. */
  partial: AppEntry[];
  busy: boolean;
  error: string | null;
  load: (refresh?: boolean) => Promise<void>;
  uninstall: (id: string) => Promise<UninstallResult>;
  reset: () => void;
}

let streamUnlisten: UnlistenFn | null = null;
let streamRefs = 0;
let streamPending: Promise<UnlistenFn> | null = null;

/** Subscribe (idempotent, ref-counted) to the measurement stream. The
 * in-flight listen() is memoized — two overlapping load() calls both
 * seeing `streamUnlisten === null` would register TWO Tauri listeners
 * and orphan the first unlisten handle (StrictMode's double mount
 * effect hits this exact window in dev). */
async function ensureStreamListener(
  onBatch: (batch: AppEntry[]) => void,
): Promise<() => void> {
  streamRefs += 1;
  if (streamPending === null && streamUnlisten === null) {
    streamPending = listen<AppEntry[]>("applications-batch", (batch) => {
      onBatch(batch);
    });
    streamPending.catch(() => {
      // Listen failed: drop the memo so a later load can retry, and
      // release this caller's ref (no detach will be created).
      streamPending = null;
      streamRefs = Math.max(0, streamRefs - 1);
    });
  }
  const un = await (streamPending ?? Promise.resolve(streamUnlisten!));
  streamUnlisten = un;
  streamPending = null;
  return () => {
    streamRefs -= 1;
    if (streamRefs <= 0 && streamUnlisten) {
      streamUnlisten();
      streamUnlisten = null;
      streamRefs = 0;
    }
  };
}

export const useApplicationsStore = create<ApplicationsState>((set, get) => ({
  apps: null,
  partial: [],
  busy: false,
  error: null,
  load: async (refresh = false) => {
    // Always clear partial (not just on refresh): a failed prior load
    // leaves stale rows that would otherwise merge into the next pass.
    set({ busy: true, error: null, partial: [] });
    let detach: (() => void) | null = null;
    try {
      // Merge streamed rows by id (chunks may arrive from either
      // enumerate path; double-emission under concurrent loads is
      // harmless — the map upserts).
      detach = await ensureStreamListener((batch) => {
        if (get().apps !== null) return; // authoritative list already landed
        const byId = new Map(get().partial.map((a) => [a.id, a]));
        for (const a of batch) byId.set(a.id, a);
        set({ partial: [...byId.values()] });
      });
      const apps = await invoke<AppEntry[]>("list_applications", { refresh });
      set({ apps, partial: [], busy: false });
    } catch (e) {
      set({ apps: null, busy: false, error: String(e) });
    } finally {
      detach?.();
    }
  },
  uninstall: async (id) =>
    invoke<UninstallResult>("uninstall_app", { id }),
  reset: () => set({ apps: null, partial: [], busy: false, error: null }),
}));
