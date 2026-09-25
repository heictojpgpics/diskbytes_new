/**
 * Applications store (spec §11): keeps the installed-app list across
 * tab switches ("Load everything in a background task and keep the
 * result across tab switches"), tracks load state and errors.
 *
 * The list is fetched ONCE (the Rust side caches the enumeration for
 * the app lifetime; `refresh` re-enumerates). A `preload()` call at app
 * boot warms the cache so the first Applications-tab visit renders
 * instantly — no per-mount load flash, no streaming machinery.
 */
import { create } from "zustand";
import { invoke } from "../lib/ipc";

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
  busy: boolean;
  error: string | null;
  load: (refresh?: boolean) => Promise<void>;
  uninstall: (id: string) => Promise<UninstallResult>;
  reset: () => void;
}

export const useApplicationsStore = create<ApplicationsState>((set) => ({
  apps: null,
  busy: false,
  error: null,
  load: async (refresh = false) => {
    set({ busy: true, error: null });
    try {
      const apps = await invoke<AppEntry[]>("list_applications", { refresh });
      set({ apps, busy: false });
    } catch (e) {
      set({ apps: null, busy: false, error: String(e) });
    }
  },
  uninstall: async (id) =>
    invoke<UninstallResult>("uninstall_app", { id }),
  reset: () => set({ apps: null, busy: false, error: null }),
}));

/** Warm the app-lifetime cache at boot (see App.tsx): the enumeration
 * runs once in the background — the first tab visit is a cache hit. */
export function preloadApplications() {
  if (useApplicationsStore.getState().apps === null && !useApplicationsStore.getState().busy) {
    void useApplicationsStore.getState().load();
  }
}
