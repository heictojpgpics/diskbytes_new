/**
 * DiskBytes app shell (spec §3): 56px top bar (brand, tabs, window drag
 * region, Windows caption buttons / macOS traffic-light reserve) → body
 * (sidebar | main | inspector on Explore only), 1px dividers. Hosts the
 * 5 tabs, the inspector, the preview overlay, the cleanup queue popover,
 * and the license dialog. Also mounts the DISKBYTES_TOUR driver (dev
 * hook §15 — CI screenshot tours).
 */
import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, MotionConfig, motion } from "framer-motion";

import { TopBar } from "./shell/TopBar";
import { Sidebar } from "./sidebar";
import { ExploreView } from "./explore/ExploreView";
import { DuplicatesView } from "./tabs/DuplicatesView";
import { ApplicationsView } from "./tabs/ApplicationsView";
import { MonitorView } from "./tabs/MonitorView";
import { SnapshotsView } from "./tabs/SnapshotsView";
import { InspectorPanel } from "./inspector/InspectorPanel";
import { PreviewOverlay } from "./components/PreviewOverlay";
import { CleanupQueuePopover } from "./components/CleanupQueuePopover";
import { LicenseDialog } from "./components/LicenseDialog";
import { useViewStore } from "./state/view";
import { useScanStore } from "./state/scan";
import { useExploreStore } from "./state/explore";
import { useLicenseStore, attachLicenseEvents } from "./state/license";
import { bootstrapMonitor } from "./state/monitor";
import { preloadApplications } from "./state/applications";
import { getBreadcrumb, type CrumbData } from "./viz/exploreIpc";
import { invoke } from "./lib/ipc";
import { pushRecent } from "./sidebar/RecentSection";
import { TourDriver } from "./shell/TourDriver";
import { AppErrorBoundary } from "./shell/AppErrorBoundary";
import { CheckIcon, ShieldIcon, Trash2Icon } from "./components/Icon";
import { SPRING_TOAST, FADE_SWAP, EXIT_COVERED } from "./lib/motion";
import { listen } from "./lib/ipc";
import "./theme/tokens.css";
import "./styles/base.css";
import "./styles/shell.css";
import "./styles/sidebar.css";
import "./styles/explore.css";
import "./styles/viz.css";
import "./styles/inspector.css";
import "./styles/tabs.css";
import "./styles/overlays.css";

function AppShell() {
  const tab = useViewStore((s) => s.tab);
  const inspectorVisible = useViewStore((s) => s.inspectorVisible);
  const nameFilter = useViewStore((s) => s.nameFilter);
  const setNameFilter = useViewStore((s) => s.setNameFilter);
  const generation = useScanStore((s) => s.generation);
  const status = useScanStore((s) => s.status);
  const licensePosture = useLicenseStore((s) => s.status?.posture ?? null);
  const currentFolder = useExploreStore((s) => s.currentFolder);
  const openFolder = useExploreStore((s) => s.openFolder);
  const goBack = useExploreStore((s) => s.goBack);
  const canGoBack = useExploreStore((s) => s.folderStack.length > 0);

  const [crumbs, setCrumbs] = useState<CrumbData[]>([]);
  const [previewId, setPreviewId] = useState<number | null>(null);
  const [queueOpen, setQueueOpen] = useState(false);
  const [licenseOpen, setLicenseOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [toastIcon, setToastIcon] = useState<"shield" | "trash" | "check">("shield");

  useEffect(() => {
    attachLicenseEvents();
    void useLicenseStore.getState().load();
    useScanStore.getState().ensureListeners(); // scan-progress / scan-done / cleanup-committed (once)
    // Sampler warms at BOOT, not at first Monitor-tab entry: the 2s
    // cadence is app-lifetime, so the tab renders live data the moment
    // it is opened (no mount-then-wait). See state/monitor.ts.
    bootstrapMonitor();
    // Applications warm at BOOT too: one background enumeration fills
    // the Rust app-lifetime cache — the first tab visit is a cache hit
    // (no skeletons, no per-mount IPC round trip).
    preloadApplications();
  }, []);

  // Toast bus: any surface can raise a transient toast via the
  // `db-toast` window event (detail: { text, icon? }). The elevation
  // decline listener below and the cleanup commit both use it.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const showToast = (text: string, icon?: string) => {
      setToast(text);
      if (icon === "shield" || icon === "trash" || icon === "check") setToastIcon(icon);
      else setToastIcon("check");
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setToast(null), 5200);
    };
    const onToast = (e: Event) => {
      const detail = (e as CustomEvent<{ text: string; icon?: string }>).detail;
      if (detail?.text) showToast(detail.text, detail.icon);
    };
    window.addEventListener("db-toast", onToast);
    return () => {
      window.removeEventListener("db-toast", onToast);
      if (timer) clearTimeout(timer);
    };
  }, []);

  // Elevation decline feedback: the Rust side emits `admin-restart-failed`
  // when the UAC prompt is declined or the elevated launch fails — surface
  // it as a transient toast so the click is never silently swallowed.
  useEffect(() => {
    let un: (() => void) | null = null;
    void listen<string>("admin-restart-failed", (reason) => {
      window.dispatchEvent(
        new CustomEvent("db-toast", { detail: { text: reason || "Elevation was declined — administrator restart failed.", icon: "shield" } }),
      );
    }).then((u) => {
      un = u;
    }).catch(() => undefined);
    return () => {
      un?.();
    };
  }, []);

  // Tour-driver overlay events (CI screenshot tours).
  useEffect(() => {
    const openLicense = () => setLicenseOpen(true);
    const openQueue = () => setQueueOpen(true);
    const closeOverlays = () => {
      setLicenseOpen(false);
      setQueueOpen(false);
    };
    window.addEventListener("db-open-license", openLicense);
    window.addEventListener("db-open-queue", openQueue);
    window.addEventListener("db-tour-step", closeOverlays);
    return () => {
      window.removeEventListener("db-open-license", openLicense);
      window.removeEventListener("db-open-queue", openQueue);
      window.removeEventListener("db-tour-step", closeOverlays);
    };
  }, []);

  // Scan lifecycle housekeeping: remember recent + reset navigation.
  useEffect(() => {
    if (status !== "done") return;
    useExploreStore.getState().resetNavigation();
    // First completed scan reveals the inspector (details exist now);
    // an explicit user toggle always wins over this one-time nudge.
    const v = useViewStore.getState();
    if (!v.inspectorTouched) v.setInspectorVisible(true);
    // CI tour hook: the DISKBYTES_SCAN dev-hook target lands in Recents
    // here (user-started scans are pushed on the scanning transition
    // below — the dev hook bypasses the UI click).
    void (async () => {
      try {
        const hooks = await invoke<{ scan: string | null }>("get_dev_hooks").catch(() => null);
        if (hooks?.scan) pushRecent(hooks.scan);
      } catch {
        /* ignore */
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  // Every user-started scan lands in Recents (paths display as-is;
  // "ThisPC" gets its friendly label). Runs on the scanning transition
  // so the entry exists even if the scan is cancelled midway. Reads the
  // store directly — no stale-closure risk on the [status] dep.
  useEffect(() => {
    if (status !== "scanning") return;
    const t = useScanStore.getState().scanTarget;
    if (t && t.length > 0) {
      pushRecent(t.toLowerCase() === "thispc" ? "This PC" : t);
    }
  }, [status]);

  // Breadcrumb chain refreshes on navigation + generation changes.
  useEffect(() => {
    if (status !== "done") {
      setCrumbs([]);
      return;
    }
    let disposed = false;
    void (async () => {
      const chain = await getBreadcrumb(generation, currentFolder).catch(() => null);
      if (!disposed && chain) setCrumbs(chain);
    })();
    return () => {
      disposed = true;
    };
  }, [generation, currentFolder, status]);

  const openPreview = useCallback((id: number) => setPreviewId(id), []);

  return (
    <div className="db-app">
      {licensePosture === "degraded" && (
        <div className="db-degrade-banner" role="alert">
          License couldn’t be validated for over 14 days — scanning works, cleanup is read-only until you reconnect (License in the top bar).
        </div>
      )}
      <TopBar
        crumbs={crumbs}
        onNavigateCrumb={(id) => openFolder(id)}
        onFolderBack={goBack}
        canGoBack={canGoBack}
        query={nameFilter}
        onQueryChange={setNameFilter}
        onOpenQueue={() => setQueueOpen((o) => !o)}
        queueOpen={queueOpen}
        onOpenLicense={() => setLicenseOpen(true)}
      />
      <div className={`db-body ${inspectorVisible && tab === "explore" ? "has-inspector" : ""}`}>
        <div className="db-sidebar-col">
          <Sidebar />
        </div>
        <div className="db-main-col">
          {/* Tab crossfade (cover-style): the entering view fades in
           * OVER the still-fully-visible old one; the old one only
           * fades out AFTER it is covered, then unmounts. The exiting
           * wrapper is lifted out of flow by pure CSS (absolute,
           * :not(:last-child)) — no JS measurement, no injected style
           * rules; a stuck exit can never affect layout. */}
          <AnimatePresence initial={false}>
            <motion.div
              key={tab}
              className="db-tab-swap"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, pointerEvents: "auto", transition: FADE_SWAP }}
              exit={{ opacity: 0, pointerEvents: "none", transition: EXIT_COVERED }}
            >
              {tab === "explore" && <ExploreView onPreview={openPreview} />}
              {tab === "duplicates" && <DuplicatesView />}
              {tab === "applications" && <ApplicationsView />}
              {tab === "monitor" && <MonitorView />}
              {tab === "snapshots" && <SnapshotsView />}
            </motion.div>
          </AnimatePresence>
        </div>
        {/* Mounted whenever Explore is active (the track animates 0px ↔
         * --inspector-w; a conditional mount could only hard-snap) —
         * visibility is the .has-inspector class on .db-body. */}
        {tab === "explore" && (
          <div className="db-inspector-col">
            <InspectorPanel onPreview={openPreview} />
          </div>
        )}
      </div>

      {previewId != null && (
        <PreviewOverlay
          generation={generation}
          id={previewId}
          onClose={() => setPreviewId(null)}
          onOpenDefault={(id) => {
            void invoke("open_node", { generation, id }).catch(() => undefined);
            setPreviewId(null);
          }}
        />
      )}

      <CleanupQueuePopover open={queueOpen} onClose={() => setQueueOpen(false)} anchor="topbar" />
      <LicenseDialog open={licenseOpen} onClose={() => setLicenseOpen(false)} />
      <AnimatePresence>
        {toast && (
          <motion.div
            key="toast"
            className="db-toast"
            role="status"
            initial={{ opacity: 0, y: 18, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.97 }}
            transition={SPRING_TOAST}
          >
            {toastIcon === "trash" ? <Trash2Icon size={15} /> : toastIcon === "shield" ? <ShieldIcon size={15} /> : <CheckIcon size={15} />}
            {toast}
          </motion.div>
        )}
      </AnimatePresence>
      <TourDriver />
    </div>
  );
}


export default function App() {
  return (
    <AppErrorBoundary>
      {/* reducedMotion="user": the CSS kill switch only covers
       * stylesheet animations — every framer spring (tab pill, badge,
       * toast, popover) ran regardless of the OS preference. This makes
       * the JS motion system honor it too (springs become instant). */}
      <MotionConfig reducedMotion="user">
        <AppShell />
      </MotionConfig>
    </AppErrorBoundary>
  );
}
