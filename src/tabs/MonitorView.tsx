/**
 * Monitor tab (spec §12): 2×2 cards (CPU big% + sparkline, Memory
 * segmented bar + sparkline, Network, Storage volumes + sparkline) +
 * Top Processes table (CPU/MEM sort, filter, Show-all). The sampler
 * session is app-lifetime and starts at BOOT (state/monitor.ts —
 * App.tsx calls bootstrapMonitor() before the first tab renders), so
 * this view is a pure consumer of the shared ring: no mount/start/stop
 * lifecycle, no first-open wait.
 */
import { useMemo, useState } from "react";
import { ActivityIcon, CpuIcon, HardDriveIcon, MemoryStickIcon, WifiIcon } from "../components/Icon";
import { EmptyState, Skeleton } from "../components/buttons";
import { bytes } from "../lib/format";
import { useMonitorStore, type MonitorSample } from "../state/monitor";

const RING = 120;

function Sparkline({ values, color, height = 44 }: { values: number[]; color: string; height?: number }) {
  const { line, area } = useMemo(() => {
    if (values.length < 2) return { line: "", area: "" };
    const max = Math.max(...values, 1);
    const w = 100;
    const step = w / (RING - 1);
    const start = RING - values.length;
    const pts = values.map(
      (v, i) =>
        `${((start + i) * step).toFixed(1)},${(height - (v / max) * (height - 4) - 2).toFixed(1)}`,
    );
    const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p}`).join(" ");
    const base = height - 2;
    const area = `M${pts[0]} L${pts[pts.length - 1]} L${(start + values.length - 1) * step},${base} L${start * step},${base} Z`;
    return { line, area };
  }, [values, height]);
  return (
    <svg className="db-mon-spark" viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" aria-hidden>
      <line className="spark-base" x1="0" y1={height - 2} x2="100" y2={height - 2} vectorEffect="non-scaling-stroke" />
      {area && <path className="spark-area" d={area} fill={color} />}
      <path d={line} fill="none" stroke={color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function MonitorView() {
  const ring = useMonitorStore((s) => s.ring);
  const monitorError = useMonitorStore((s) => s.error);
  const monitorStarted = useMonitorStore((s) => s.started);
  const [showAll, setShowAll] = useState(false);
  const [sort, setSort] = useState<"cpu" | "mem">("cpu");
  const [filter, setFilter] = useState("");
  const [volsShown, setVolsShown] = useState(3);

  const latest = ring[ring.length - 1] as MonitorSample | undefined;

  if (monitorError && !monitorStarted) {
    return (
      <div className="db-tab db-scroll">
        <EmptyState
          icon={<ActivityIcon size={28} />}
          title="Monitor unavailable"
          body={monitorError}
          action={
            <button
              type="button"
              className="db-ink-button auto"
              onClick={() => useMonitorStore.getState().start()}
            >
              Retry
            </button>
          }
        />
      </div>
    );
  }

  if (!latest) {
    // Structure preview (loading system v2): the 2-column monitor grid
    // fills with card skeletons while the sampler warms up — the tab
    // keeps its footprint instead of collapsing to a centered glyph.
    return (
      <div className="db-tab db-scroll">
        <div className="db-mon-grid" aria-hidden="true">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="db-mon-card db-mon-skeleton">
              <Skeleton w={120} h={10} />
              <Skeleton w={72} h={26} />
              <Skeleton w="100%" h={36} />
            </div>
          ))}
        </div>
        <div className="db-loading-block" role="status">
          <span>Starting sampler (2 s cadence)…</span>
        </div>
      </div>
    );
  }

  const memUsed = latest.memTotal - latest.memAvailable;
  const otherMem = Math.max(0, memUsed - (latest.compressed ?? 0) - latest.kernelPaged - latest.kernelNonpaged);
  // Segment colors all speak tokens now (the amber literal #f59e0b was
  // the one raw hex in the data layer — off-palette in dark mode).
  const segs = [
    { label: "Kernel pool", size: latest.kernelPaged + latest.kernelNonpaged, color: "var(--used)" },
    { label: "Compressed", size: latest.compressed ?? 0, color: "var(--seg-compressed, #f59e0b)" },
    { label: "Other in use", size: otherMem, color: "var(--ink)" },
    { label: "Free", size: latest.memAvailable, color: "var(--free)" },
  ];
  const memSum = Math.max(1, latest.memTotal);

  const procsSorted = [...latest.procs]
    .filter((p) => !filter || p.name.toLowerCase().includes(filter.toLowerCase()))
    .sort((a, b) => (sort === "cpu" ? b.cpuPct - a.cpuPct : b.ws - a.ws));
  const shown = showAll ? procsSorted : procsSorted.slice(0, 14);
  const vols = latest.volumes.slice(0, volsShown);

  return (
    <div className="db-tab db-scroll">
      <div className="db-tab-head">
        <div>
          <h1>Monitor</h1>
          <span className="db-tab-sub">
            live · every 2 seconds · <b>{latest.processes.toLocaleString()}</b> processes · <b>{latest.threads.toLocaleString()}</b> threads
          </span>
        </div>
      </div>

      <div className="db-mon-grid">
        <div className="db-mon-card">
          <header>
            <span>CPU</span>
            <CpuIcon size={13} />
          </header>
          <div className="db-mon-big tnum">
            {latest.cpuTotalPct.toFixed(0)}
            <small>%</small>
          </div>
          <div className="db-mon-sub">
            <span>USER <b className="tnum">{latest.cpuUserPct.toFixed(0)}%</b></span>
            <span>SYSTEM <b className="tnum">{latest.cpuSystemPct.toFixed(0)}%</b></span>
            <span>THREADS <b className="tnum">{latest.threads.toLocaleString()}</b></span>
          </div>
          <Sparkline values={ring.map((s) => s.cpuTotalPct)} color="var(--ink)" />
        </div>

        <div className="db-mon-card">
          <header>
            <span>Memory</span>
            <MemoryStickIcon size={13} />
          </header>
          <div className="db-mon-big tnum">
            {bytes(memUsed)}
          </div>
          <div className="db-mem-segs">
            {segs.map((s) => (
              <i key={s.label} style={{ width: `${(s.size / memSum) * 100}%`, background: s.color }} title={`${s.label}: ${bytes(s.size)}`} />
            ))}
          </div>
          <div className="db-mem-legend">
            {segs.map((s) => (
              <span key={s.label}>
                <i style={{ background: s.color }} /> {s.label}
              </span>
            ))}
          </div>
          <div className="db-mon-sub" style={{ marginTop: 9 }}>
            <span>TOTAL <b className="tnum">{bytes(latest.memTotal)}</b></span>
            <span>COMMIT <b className="tnum">{bytes(latest.commitTotal)}</b></span>
          </div>
          <Sparkline values={ring.map((s) => s.memTotal - s.memAvailable)} color="var(--used)" />
        </div>

        <div className="db-mon-card">
          <header>
            <span>Network</span>
            <WifiIcon size={13} />
          </header>
          <div className="db-mon-big tnum">
            {bytes(latest.netDownBps)}
            <small>/s ↓</small>
          </div>
          <div className="db-mon-sub">
            <span>DOWN <b className="tnum">{bytes(latest.netDownBps)}/s</b></span>
            <span>UP <b className="tnum">{bytes(latest.netUpBps)}/s</b></span>
            <span>SESSION IN <b className="tnum">{bytes(latest.sessionIn)}</b></span>
          </div>
          <Sparkline values={ring.map((s) => s.netDownBps)} color="var(--free)" />
        </div>

        <div className="db-mon-card">
          <header>
            <span>Storage</span>
            <HardDriveIcon size={13} />
          </header>
          {vols.map((v) => (
            <div className="db-vol-row" key={v.root}>
              <span className="db-vol-name">{v.label}</span>
              <i>
                <b style={{ width: `${((v.total - v.free) / Math.max(1, v.total)) * 100}%` }} />
              </i>
              <em className="tnum">{bytes(v.free)} free</em>
            </div>
          ))}
          {latest.volumes.length > volsShown && (
            <button type="button" className="db-vol-more" onClick={() => setVolsShown(latest.volumes.length)}>
              Show {latest.volumes.length - volsShown} more volumes
            </button>
          )}
          <Sparkline values={ring.map((s) => s.volumes[0]?.free ?? 0)} color="var(--ink)" />
        </div>
      </div>

      <div className="db-procs">
        <div className="db-procs-toolbar">
          <div className="db-segmented" role="group" aria-label="Sort processes">
            <button type="button" data-active={sort === "cpu"} onClick={() => setSort("cpu")}>CPU</button>
            <button type="button" data-active={sort === "mem"} onClick={() => setSort("mem")}>Memory</button>
          </div>
          <label className="db-search" style={{ flexBasis: 220 }}>
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter processes…" aria-label="Filter processes" />
          </label>
        </div>
        <div className="db-procs-head">
          <span>Process</span>
          <span style={{ textAlign: "right" }}>PID</span>
          <span style={{ textAlign: "right" }}>CPU</span>
          <span style={{ textAlign: "right" }}>Memory</span>
        </div>
        {shown.map((p) => (
          <div className="db-procs-row" key={p.pid} title={`Working set: ${bytes(p.ws)}`}>
            <strong>{p.name}</strong>
            <span className="tnum">{p.pid}</span>
            <b className="db-proc-cpu tnum">{p.cpuPct.toFixed(1)}%</b>
            <b className="tnum">{bytes(p.ws)}</b>
          </div>
        ))}
        {shown.length === 0 && (
          <div className="db-substate">No processes match “{filter}”.</div>
        )}
        {procsSorted.length > 14 && !showAll && (
          <button type="button" className="db-vol-more" style={{ marginTop: 6 }} onClick={() => setShowAll(true)}>
            Show all {procsSorted.length.toLocaleString()}
          </button>
        )}
        {showAll && procsSorted.length > 14 && (
          <button type="button" className="db-vol-more" style={{ marginTop: 6 }} onClick={() => setShowAll(false)}>
            Show top 14
          </button>
        )}
      </div>
    </div>
  );
}
