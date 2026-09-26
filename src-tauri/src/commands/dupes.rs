//! Duplicates commands (spec §10; doc 03 M8): the 3-pass flow
//! (size-grouping, 64 KiB prefix SHA-256, full hashing for matches,
//! both hash passes on a DEDICATED bounded pool). Hardlink exclusion
//! via (volume-serial, file-index); cloud placeholders never open
//! (R7.3); wasted-space ranking per the spec.
//!
//! Liveness contract (the "Scanning… forever" fix): a real disk can
//! hold hundreds of GB in same-size buckets, so the command reports
//! honest progress on `dupes-progress` (phase, files, bytes, elapsed
//! — a 200 ms ticker thread samples atomics the workers bump) and
//! accepts cancellation (`cancel_duplicates` bumps a generation
//! counter; the run latches it at start and every per-file check
//! compares against the latch, so a late cancel can never poison a
//! newer run).
//!
//! Speed contract: pass 2 reads only 64 KiB per size-bucket candidate;
//! a tier-2 mid-file fingerprint (1 MiB at +64 KiB + the last 1 MiB)
//! screens same-prefix false positives (identical headers, zero-padded
//! formats) BEFORE the full read; pass 3 full-hashes only survivors.
//! Windows opens every hash read with `FILE_FLAG_SEQUENTIAL_SCAN`.
//! All hash work runs on a 4-worker pool over PATH-SORTED files (the
//! session-5 speed fix — see [`hash_pool`]).
//!
//! State contract (the "page switch killed my scan" fix): the run's
//! live status and sticky result live in `AppState.dupes_status`
//! (`dupes_status` command) so the DuplicatesView can re-attach after
//! any tab switch; a UI-unmount can no longer orphan a running
//! multi-GB hash.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use diskbytes_core::dupes::{self, DupeGroup, HashedFile};
use diskbytes_core::scan::node::Tree;

use rayon::prelude::*;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, State};

use crate::state::AppState;

/// Prefix-hash chunk (64 KiB, spec §10).
const PREFIX: u64 = 64 * 1024;
/// Full-hash read chunk (1 MiB, spec §10).
const CHUNK: usize = 1024 * 1024;
/// Tier-2 sample length: 1 MiB past the prefix + the last 1 MiB.
/// Files larger than `PREFIX + 2 * SAMPLE` get the mid-file screen
/// between prefix and full hash; smaller files are cheap enough to
/// full-hash directly (the screen would read most of the file anyway).
const SAMPLE: u64 = 1024 * 1024;
/// Progress ticker cadence (ms).
const TICK_MS: u64 = 200;
/// Progress `elapsed_ms` cap (10 minutes) — `as_millis` is u128; real
/// scans stay far below this and the UI re-computes from its own clock.
const ELAPSED_CAP_MS: u128 = 600_000_000;
/// Hash-pool worker count (see [`hash_pool`]).
const POOL_THREADS: usize = 4;

/// The dedicated, bounded hash pool (session-5 speed fix).
///
/// The passes used to run on the GLOBAL rayon pool — one thread per
/// logical CPU (16–32 on a modern machine) — which is exactly wrong
/// for disk work: dozens of concurrently-opened files in work-stolen
/// (effectively random) order thrash the queue with seeks and stampede
/// Windows Defender's per-open scan, the two compounding causes of the
/// user-measured "9 MB/s". Four workers reading PATH-SORTED files
/// keep streams near-adjacent on disk (short seeks, warm cache lines,
/// Defender scanning neighbours) and leave the global pool free for
/// CPU-bound work. Four also saturates NVMe queue depth (the full pass
/// streams 1 MiB sequential reads) without tripping over itself on
/// SATA. The parallel iterators are scoped with `ThreadPool::install`
/// (see [`hash_pool`]).
fn hash_pool() -> &'static rayon::ThreadPool {
    static POOL: OnceLock<rayon::ThreadPool> = OnceLock::new();
    POOL.get_or_init(|| {
        let n = std::thread::available_parallelism()
            .map_or(POOL_THREADS, std::num::NonZero::get)
            .clamp(1, POOL_THREADS);
        rayon::ThreadPoolBuilder::new()
            .num_threads(n)
            .thread_name(|i| format!("db-dupes-hash-{i}"))
            .build()
            .expect("dupes hash pool")
    })
}

/// A pass-3 bucket: `((size, prefix digest), candidate indices)` —
/// prefix survivors with ≥ 2 members heading into the full hash. (A
/// type alias because the spelled-out tuple trips
/// `clippy::type_complexity`.)
type Bucket = ((u64, [u8; 32]), Vec<usize>);

/// One collected file heading into the pipeline.
struct Candidate {
    /// Display path (hashed + reported verbatim).
    path: String,
    /// Logical size.
    size: u64,
    /// Tree node id (hardlink-identity fallback).
    id: u32,
}

/// One duplicate-group row for the UI.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DupeGroupView {
    /// Group id (index).
    pub id: usize,
    /// Paths of the group's members.
    pub paths: Vec<String>,
    /// Per-file size.
    pub size: u64,
    /// Member count.
    pub count: u64,
    /// Wasted space = size × (count − 1).
    pub wasted: u64,
}

/// The duplicates response.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DupesResult {
    pub generation: u64,
    pub groups: Vec<DupeGroupView>,
    /// Total wasted bytes.
    pub wasted_total: u64,
    /// Files considered.
    pub files: u64,
}

/// Live progress snapshot for the `dupes-progress` event (camelCase
/// DTO — the UI's busy row renders phase, files, bytes, elapsed).
///
/// The `*_all` counters and `overall` are the session-5 blink fix:
/// per-phase counters reset at every phase boundary (the old bar
/// snapped 100%→0% four times per scan and the MB/s counter froze);
/// `files_done_all` / `bytes_done_all` accumulate across the WHOLE
/// run (monotonic — rate + ETA stay honest through transitions), and
/// `overall` is a weighted global fraction that never moves backwards
/// (the bar animates one smooth ramp).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DupesProgress {
    /// "collect" | "prefix" | "screen" | "full" | "done" | "cancelled".
    pub phase: String,
    /// Files hashed so far in the current phase.
    pub files_done: u64,
    /// Files the current phase will hash.
    pub files_total: u64,
    /// Bytes read so far in the current phase (prefix reads count as
    /// `min(size, PREFIX)` — the honest approximation).
    pub bytes_done: u64,
    /// Bytes the current phase will read (same rule).
    pub bytes_total: u64,
    /// Milliseconds since the scan started (capped, see
    /// [`ELAPSED_CAP_MS`]).
    pub elapsed_ms: u64,
    /// Files finished across ALL phases so far (never resets).
    pub files_done_all: u64,
    /// Bytes read across ALL phases so far (never resets — the rate
    /// source).
    pub bytes_done_all: u64,
    /// Weighted global fraction [0, 1] — the bar source (monotonic).
    pub overall: f32,
}

/// Phase ids for the atomic phase slot.
const PHASE_COLLECT: u8 = 0;
const PHASE_PREFIX: u8 = 1;
const PHASE_SCREEN: u8 = 2;
const PHASE_FULL: u8 = 3;
const PHASE_DONE: u8 = 4;
const PHASE_CANCELLED: u8 = 5;

/// Global-progress weights: [start, span] per phase on a 0..1 axis.
/// Prefix-heavy by design — it touches every same-size candidate and
/// dominates real-disk wall time; the full pass is bounded by actual
/// duplicate bytes. Sums to exactly 1.0 so `done` lands on 100%.
const PHASE_WEIGHTS: [(f32, f32); 6] = [
    (0.0, 0.02),  // collect
    (0.02, 0.45), // prefix
    (0.47, 0.13), // screen
    (0.60, 0.40), // full
    (1.0, 0.0),   // done
    (0.0, 0.0),   // cancelled (bar resets with the view)
];

/// Shared run control: atomics the pool workers bump (cheap — no
/// mutex on the hot path), the cancel latch, and the optional event
/// sink. `app: None` in tests (no Tauri runtime needed).
struct DupesCtl {
    app: Option<AppHandle>,
    files_done: AtomicU64,
    files_total: AtomicU64,
    bytes_done: AtomicU64,
    bytes_total: AtomicU64,
    /// Cumulative across ALL phases (never reset — the rate + overall
    /// sources; see [`DupesProgress`]).
    files_all: AtomicU64,
    bytes_all: AtomicU64,
    phase: AtomicU8,
    /// Cancel generation shared with `AppState` — `cancel_duplicates`
    /// bumps it; this run latched the value it saw at start.
    cancel_gen: Arc<AtomicU64>,
    /// The latched generation: cancelled iff the shared counter moved.
    latch: u64,
    started: Instant,
}

impl DupesCtl {
    /// A quiet control (no events) — the Windows E2E test harness AND
    /// the pure snapshot tests (no Tauri runtime needed).
    #[cfg(test)]
    fn quiet(gen: Arc<AtomicU64>) -> Self {
        Self::with_app(None, gen)
    }

    /// A live control emitting `dupes-progress` on `app`.
    fn live(app: AppHandle, gen: Arc<AtomicU64>) -> Self {
        Self::with_app(Some(app), gen)
    }

    fn with_app(app: Option<AppHandle>, gen: Arc<AtomicU64>) -> Self {
        let latch = gen.load(Ordering::SeqCst);
        Self {
            app,
            files_done: AtomicU64::new(0),
            files_total: AtomicU64::new(0),
            bytes_done: AtomicU64::new(0),
            bytes_total: AtomicU64::new(0),
            files_all: AtomicU64::new(0),
            bytes_all: AtomicU64::new(0),
            phase: AtomicU8::new(PHASE_COLLECT),
            cancel_gen: gen,
            latch,
            started: Instant::now(),
        }
    }

    /// True when `cancel_duplicates` fired after this run latched.
    fn cancelled(&self) -> bool {
        self.cancel_gen.load(Ordering::Relaxed) != self.latch
    }

    /// Enter a phase: per-phase counters RESET (they describe the
    /// upcoming phase), cumulative counters never do. Totals are
    /// written BEFORE the phase id (the ticker reads phase first, so
    /// a boundary-straddling tick can only show the NEW phase with
    /// fresh-zero counters for one 200 ms beat — never the old phase
    /// with the new totals).
    fn set_phase(&self, phase: u8, files_total: u64, bytes_total: u64) {
        self.files_total.store(files_total, Ordering::Relaxed);
        self.bytes_total.store(bytes_total, Ordering::Relaxed);
        self.files_done.store(0, Ordering::Relaxed);
        self.bytes_done.store(0, Ordering::Relaxed);
        self.phase.store(phase, Ordering::Relaxed);
    }

    /// One finished hash target: bump files, and the bytes it cost —
    /// both the per-phase and the cumulative counters.
    fn file_done(&self, bytes: u64) {
        self.files_done.fetch_add(1, Ordering::Relaxed);
        self.bytes_done.fetch_add(bytes, Ordering::Relaxed);
        self.files_all.fetch_add(1, Ordering::Relaxed);
        self.bytes_all.fetch_add(bytes, Ordering::Relaxed);
    }

    fn snapshot(&self) -> DupesProgress {
        let phase = self.phase.load(Ordering::Relaxed);
        let phase_str = match phase {
            PHASE_PREFIX => "prefix",
            PHASE_SCREEN => "screen",
            PHASE_FULL => "full",
            PHASE_DONE => "done",
            PHASE_CANCELLED => "cancelled",
            _ => "collect",
        };
        let files_done = self.files_done.load(Ordering::Relaxed);
        let files_total = self.files_total.load(Ordering::Relaxed);
        let bytes_done = self.bytes_done.load(Ordering::Relaxed);
        let bytes_total = self.bytes_total.load(Ordering::Relaxed);
        let (start, span) = PHASE_WEIGHTS[phase.min(5) as usize];
        let frac = if phase == PHASE_DONE {
            1.0
        } else if bytes_total > 0 {
            (bytes_done as f64 / bytes_total as f64).min(1.0) as f32
        } else if files_total > 0 {
            (files_done as f64 / files_total as f64).min(1.0) as f32
        } else {
            0.0
        };
        DupesProgress {
            phase: phase_str.to_string(),
            files_done,
            files_total,
            bytes_done,
            bytes_total,
            elapsed_ms: self.started.elapsed().as_millis().min(ELAPSED_CAP_MS) as u64,
            files_done_all: self.files_all.load(Ordering::Relaxed),
            bytes_done_all: self.bytes_all.load(Ordering::Relaxed),
            overall: (start + span * frac).clamp(0.0, 1.0),
        }
    }

    /// Emit one progress event (best-effort; the UI ignores events
    /// outside a busy window).
    fn tick(&self) {
        if let Some(app) = &self.app {
            let _ = app.emit("dupes-progress", self.snapshot());
        }
    }
}

/// Open a file for sequential hashing with the platform's sequential
/// hint (`FILE_FLAG_SEQUENTIAL_SCAN` on Windows — Cache Manager
/// read-ahead + Defender's scan pattern). `None` = unreadable.
fn open_seq(path: &std::path::Path) -> Option<std::fs::File> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const SEQ_FLAG: u32 = 0x0800_0000; // FILE_FLAG_SEQUENTIAL_SCAN
        std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(SEQ_FLAG)
            .open(path)
            .ok()
    }
    #[cfg(not(windows))]
    {
        std::fs::File::open(path).ok()
    }
}

/// Hash ONLY the first `PREFIX` bytes (pass 2). `None` = unreadable
/// (skipped honestly). For files ≤ PREFIX this IS the full digest.
fn hash_prefix(path: &std::path::Path) -> Option<[u8; 32]> {
    use std::io::Read;
    let mut f = open_seq(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; PREFIX as usize];
    let mut read = 0u64;
    while read < PREFIX {
        let n = f.read(&mut buf[..(PREFIX as usize - read as usize)]).ok()?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        read += n as u64;
    }
    let digest: [u8; 32] = hasher.finalize().into();
    Some(digest)
}

/// Tier-2 mid-file fingerprint: SHA-256 over the byte range
/// `[PREFIX, PREFIX + SAMPLE)` concatenated with the LAST `SAMPLE`
/// bytes of the file. Same-size files that share a 64 KiB prefix but
/// differ anywhere in these two windows are screened out before the
/// full read; files identical through all three windows are almost
/// certainly identical (the full hash confirms). `None` = unreadable.
fn hash_middle(path: &std::path::Path, size: u64) -> Option<[u8; 32]> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = open_seq(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; SAMPLE as usize];
    // Window A: [PREFIX, PREFIX + SAMPLE) — clamped to the file end.
    let a_len = (size - PREFIX).min(SAMPLE) as usize;
    f.seek(SeekFrom::Start(PREFIX)).ok()?;
    let mut got = 0usize;
    while got < a_len {
        let n = f.read(&mut buf[got..a_len]).ok()?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[got..got + n]);
        got += n;
    }
    if got < a_len {
        return None; // truncated mid-read — treat as unreadable
    }
    // Window B: the last SAMPLE bytes (never overlaps A: the tier only
    // runs when size > PREFIX + 2*SAMPLE).
    let b_start = size - SAMPLE;
    f.seek(SeekFrom::Start(b_start)).ok()?;
    let mut got = 0usize;
    while got < SAMPLE as usize {
        let n = f.read(&mut buf[got..]).ok()?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[got..got + n]);
        got += n;
    }
    if got < SAMPLE as usize {
        return None;
    }
    let digest: [u8; 32] = hasher.finalize().into();
    Some(digest)
}

/// Full hash (pass 3, read in 1 MiB chunks). `None` = unreadable.
fn hash_full(path: &std::path::Path) -> Option<[u8; 32]> {
    use std::io::Read;
    let mut f = open_seq(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; CHUNK];
    loop {
        let n = f.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let digest: [u8; 32] = hasher.finalize().into();
    Some(digest)
}

/// Hardlink identity via the platform seam `win::hardlink_identity`
/// (spec §10: hardlinks are NOT duplicates). None = unavailable
/// (treated unique). Non-Windows builds have no hardlinks to detect.
#[cfg(windows)]
fn hardlink_identity(path: &std::path::Path) -> Option<(u64, u64)> {
    crate::platform::os::hardlink_identity(path)
}

#[cfg(not(windows))]
fn hardlink_identity(_path: &std::path::Path) -> Option<(u64, u64)> {
    None
}

/// Find duplicates in the current tree (spec §10 3-pass) with live
/// progress, cooperative cancellation, and an APP-LIFETIME state
/// record (page switches can no longer orphan the run: the UI
/// re-attaches via [`dupes_status`]).
///
/// # Errors
/// String error when no scan exists, the generation is stale, a run
/// is already in flight ("already running" — the UI no-ops), the
/// pipeline was cancelled, or the blocking thread failed.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // State extraction is the tauri command contract
#[allow(clippy::print_stderr)] // liveness tracing (doc 07 perf-watchdog pattern)
pub async fn find_duplicates(
    generation: u64,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<DupesResult, String> {
    let tree = {
        let guard = state.tree.read();
        let Some(tree) = guard.as_ref() else {
            return Err("no scan yet".into());
        };
        if tree.generation != generation {
            return Err(format!(
                "stale generation {} (current {})",
                generation, tree.generation
            ));
        }
        Arc::clone(tree)
    };
    // The run-state gate: mark running BEFORE spawning so a same-tick
    // second click (or a stale view's invoke) is rejected cleanly
    // instead of stacking a second pipeline. The sticky result dies
    // with the new run — a fresh scan means a fresh page.
    {
        let mut st = state.dupes_status.lock();
        if st.running {
            return Err("already running".into());
        }
        st.running = true;
        st.generation = generation;
        st.progress = None;
        st.result = None;
        st.error = None;
    }
    eprintln!("[dupes] start gen={generation} tree_nodes={}", tree.len());
    let t_start = Instant::now();
    let ctl = Arc::new(DupesCtl::live(app, Arc::clone(&state.dupes_cancel)));
    let status_out = Arc::clone(&state.dupes_status);
    // The ticker also mirrors every snapshot into the app-lifetime
    // status record — `dupes_status` queries never observe a stale
    // phase, and a mid-scan page switch re-attaches to LIVE counters.
    let ticker_ctl = Arc::clone(&ctl);
    let ticker_status = Arc::clone(&state.dupes_status);
    let finished = Arc::new(AtomicBool::new(false));
    let finished_t = Arc::clone(&finished);
    std::thread::spawn(move || {
        while !finished_t.load(Ordering::Relaxed) {
            std::thread::sleep(Duration::from_millis(TICK_MS));
            if finished_t.load(Ordering::Relaxed) {
                break;
            }
            let snap = ticker_ctl.snapshot();
            ticker_ctl.tick();
            let mut st = ticker_status.lock();
            if st.running {
                st.progress = Some(snap);
            }
        }
    });
    let compute_ctl = Arc::clone(&ctl);
    let started = ctl.started; // Instant is Copy

    // The join is a DOUBLE Result: outer = JoinError (thread failure),
    // inner = the pipeline's own Ok/Err. The session-4 code flattened
    // with an early `?` — which also early-returned on a join failure,
    // skipping `finished.store` (the ticker thread leaked) and leaving
    // `dupes_status.running` stuck true. Matching BOTH layers in one
    // place (below) settles the record for every outcome.
    let joined = tauri::async_runtime::spawn_blocking(move || {
        eprintln!("[dupes] spawn_blocking task ENTERED");
        let out = compute_dupes(&tree, compute_ctl.as_ref());
        eprintln!("[dupes] compute finished at {:?}", started.elapsed());
        out
    })
    .await
    .map_err(|e| format!("dupes thread failed: {e}"));
    eprintln!("[dupes] await resolved at {:?}", t_start.elapsed());
    finished.store(true, Ordering::Relaxed);
    // Terminal resolution: settle the app-lifetime record + the event
    // stream in ONE place (cancel is a quiet reset — no error banner;
    // a failure — pipeline OR join — records the message for the
    // re-attached view). The or-pattern binds `msg: &String` on both
    // the pipeline error and the join error.
    let terminal = match &joined {
        Ok(Ok(res)) => {
            ctl.set_phase(PHASE_DONE, 0, 0);
            let mut st = status_out.lock();
            st.running = false;
            st.progress = Some(ctl.snapshot());
            st.result = Some(res.clone());
            st.error = None;
            Ok(res.clone())
        }
        Ok(Err(msg)) | Err(msg) => {
            let cancelled = msg.contains("cancelled");
            if cancelled {
                ctl.phase.store(PHASE_CANCELLED, Ordering::Relaxed);
            }
            let mut st = status_out.lock();
            st.running = false;
            st.progress = Some(ctl.snapshot());
            if !cancelled {
                st.error = Some(msg.clone());
            }
            Err(msg.clone())
        }
    };
    // Terminal event: the busy row settles on "done" (or the invoke's
    // Err lands first — either way the window closes).
    ctl.tick();
    terminal
}

/// Read the app-lifetime duplicates status (the page-switch fix's
/// query half): a freshly-mounted DuplicatesView adopts the running
/// pipeline's live progress or the sticky last result instead of
/// showing "Start scan" over a scan that is still hashing.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // State extraction is the tauri command contract
pub fn dupes_status(state: State<'_, AppState>) -> DupesStatusView {
    let st = state.dupes_status.lock();
    DupesStatusView {
        running: st.running,
        generation: st.generation,
        progress: st.progress.clone(),
        result: st.result.clone(),
        error: st.error.clone(),
    }
}

/// Serializable mirror of [`crate::state::DupesStatus`] (camelCase).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DupesStatusView {
    pub running: bool,
    pub generation: u64,
    pub progress: Option<DupesProgress>,
    pub result: Option<DupesResult>,
    pub error: Option<String>,
}

/// Cancel the running duplicates scan. Idempotent; safe when nothing
/// is running (the bump only affects runs that latched an older
/// value). Returns the bumped generation.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // State extraction is the tauri command contract
pub fn cancel_duplicates(state: State<'_, AppState>) -> u64 {
    state.dupes_cancel.fetch_add(1, Ordering::SeqCst) + 1
}

/// The full pipeline (spec §10 3-pass + tier-2 screen): collect →
/// size groups → parallel prefix hashes → parallel mid-file screens →
/// parallel full hashes → hardlink exclusion → wasted-space ranking.
/// All hash passes run on the bounded [`hash_pool`] over PATH-SORTED
/// work — disk-locality ordering (short seeks, warm caches, Defender
/// scanning neighbours) instead of the global pool's work-stolen
/// random order; see [`hash_pool`] for the throughput story.
///
/// # Errors
/// `Err("cancelled")` when the user cancelled mid-pipeline.
#[allow(clippy::too_many_lines)] // 3-pass pipeline; the pass structure is the spec
#[allow(clippy::print_stderr)] // liveness tracing
fn compute_dupes(tree: &Tree, ctl: &DupesCtl) -> Result<DupesResult, String> {
    // Pass 0: collect live files. Cloud placeholders NEVER open (R7.3)
    // and Windows-managed (protected) files never hash or stage (§4 —
    // pagefile.sys is not a "duplicate" anyone should reclaim).
    ctl.set_phase(PHASE_COLLECT, 0, 0);
    let mut candidates: Vec<Candidate> = Vec::new();
    tree.walk(tree.root, |id, n| {
        if !n.is_dir()
            && !n.is_removed()
            && !n.is_cloud_placeholder()
            && !n.is_protected()
            && n.logical > 0
        {
            candidates.push(Candidate {
                path: tree.node_path(id),
                size: n.logical,
                id,
            });
        }
    });
    // Disk-locality order for every subsequent pass: the tree walk
    // order is traversal-dependent, not on-disk order — one sort here
    // and each pass's work list starts near where the last one seeks.
    candidates.sort_unstable_by(|a, b| a.path.cmp(&b.path));
    let total_files = candidates.len() as u64;
    eprintln!(
        "[dupes] collected {total_files} candidates at {:?}",
        ctl.started.elapsed()
    );

    // Pass 1: size buckets (candidate level).
    let mut by_size: HashMap<u64, Vec<usize>> = HashMap::new();
    for (i, c) in candidates.iter().enumerate() {
        if c.size == 0 {
            continue; // Empty files all "match" each other — spec §10 skips them.
        }
        by_size.entry(c.size).or_default().push(i);
    }

    // Pass 2 (parallel): 64 KiB prefix hash per size-bucket candidate.
    // Single-size buckets cannot contain duplicates — screened out
    // before a single byte is read. Candidates hash concurrently; the
    // (size, digest) grouping happens after the join.
    let prefix_targets: Vec<usize> = by_size
        .values()
        .filter(|bucket| bucket.len() >= 2)
        .flat_map(|bucket| bucket.iter().copied())
        .collect();
    let prefix_bytes: u64 = prefix_targets
        .iter()
        .map(|&i| candidates[i].size.min(PREFIX))
        .sum();
    ctl.set_phase(PHASE_PREFIX, prefix_targets.len() as u64, prefix_bytes);
    let digests: Vec<Option<[u8; 32]>> = hash_pool().install(|| {
        prefix_targets
            .par_iter()
            .map(|&i| {
                let read = candidates[i].size.min(PREFIX);
                let d = hash_prefix(std::path::Path::new(&candidates[i].path));
                // Counted even when unreadable — the attempt is the work
                // the user waits on.
                ctl.file_done(read);
                d
            })
            .collect()
    });
    if ctl.cancelled() {
        return Err("cancelled".into());
    }

    eprintln!(
        "[dupes] prefix pass done: {} targets at {:?}",
        prefix_targets.len(),
        ctl.started.elapsed()
    );

    // (size, prefix digest) → candidates sharing it.
    let mut by_prefix: HashMap<(u64, [u8; 32]), Vec<usize>> = HashMap::new();
    for (slot, &i) in prefix_targets.iter().enumerate() {
        if let Some(digest) = digests[slot] {
            by_prefix
                .entry((candidates[i].size, digest))
                .or_default()
                .push(i);
        }
    }

    // Tier 2 (parallel): mid-file fingerprint for same-prefix buckets
    // whose files are big enough for the screen to save real reads
    // (identical headers / zero-padded formats die HERE, at 2 MiB per
    // file, instead of a full multi-GB read).
    let mid_candidates: Vec<usize> = by_prefix
        .iter()
        .filter(|((size, _), g)| g.len() >= 2 && *size > PREFIX + 2 * SAMPLE)
        .flat_map(|(_, g)| g.iter().copied())
        .collect();
    if mid_candidates.is_empty() {
        // No screen work: prefix survivors pass straight to full hash.
        let survivors: Vec<Bucket> = by_prefix
            .into_iter()
            .filter(|(_, g)| g.len() >= 2)
            .collect();
        return finish_pipeline(tree, ctl, &candidates, total_files, &survivors);
    }
    let mid_bytes: u64 = mid_candidates.len() as u64 * 2 * SAMPLE;
    ctl.set_phase(PHASE_SCREEN, mid_candidates.len() as u64, mid_bytes);
    let mids: Vec<Option<[u8; 32]>> = hash_pool().install(|| {
        mid_candidates
            .par_iter()
            .map(|&i| {
                let d = hash_middle(
                    std::path::Path::new(&candidates[i].path),
                    candidates[i].size,
                );
                ctl.file_done(2 * SAMPLE);
                d
            })
            .collect()
    });
    if ctl.cancelled() {
        return Err("cancelled".into());
    }
    // Re-bucket by (size, MID digest); a member whose mid read failed
    // drops out (unreadable NOW — was readable at prefix time; honest
    // skip). Survivors = members of ≥2-member mid buckets.
    let mut by_mid: HashMap<(u64, [u8; 32]), Vec<usize>> = HashMap::new();
    for (slot, &i) in mid_candidates.iter().enumerate() {
        if let Some(digest) = mids[slot] {
            by_mid
                .entry((candidates[i].size, digest))
                .or_default()
                .push(i);
        }
    }
    let screened: std::collections::HashSet<usize> = by_mid
        .values()
        .filter(|g| g.len() >= 2)
        .flat_map(|g| g.iter().copied())
        .collect();
    // Per prefix bucket: big files keep only screened members; small
    // files (never ran the screen) keep all. The full hash remains the
    // authority — a mid collision across different prefixes just costs
    // one full read, never a wrong group.
    let survivors: Vec<Bucket> = by_prefix
        .into_iter()
        .filter(|(_, g)| g.len() >= 2)
        .filter_map(|((size, digest), g)| {
            let kept: Vec<usize> = if size > PREFIX + 2 * SAMPLE {
                g.iter().copied().filter(|i| screened.contains(i)).collect()
            } else {
                g
            };
            (kept.len() >= 2).then_some(((size, digest), kept))
        })
        .collect();
    finish_pipeline(tree, ctl, &candidates, total_files, &survivors)
}

/// Pass 3 + ranking: shared tail for both routes (with/without the
/// tier-2 screen). Files ≤ PREFIX already have their full digest from
/// pass 2 — reused verbatim, zero re-reads.
///
/// # Errors
/// `Err("cancelled")` when the user cancelled mid-hash.
#[allow(clippy::print_stderr)] // liveness tracing
fn finish_pipeline(
    tree: &Tree,
    ctl: &DupesCtl,
    candidates: &[Candidate],
    total_files: u64,
    survivors: &[Bucket],
) -> Result<DupesResult, String> {
    let full_files: u64 = survivors
        .iter()
        .flat_map(|((_, _), g)| g.iter())
        .filter(|&&i| candidates[i].size > PREFIX)
        .count() as u64;
    let full_bytes: u64 = survivors
        .iter()
        .flat_map(|((_, _), g)| g.iter())
        .filter(|&&i| candidates[i].size > PREFIX)
        .map(|&i| candidates[i].size)
        .sum();
    ctl.set_phase(PHASE_FULL, full_files, full_bytes);
    eprintln!(
        "[dupes] full pass: {} buckets / {} bytes",
        survivors.len(),
        full_bytes
    );
    // Path-order the full pass too: buckets sorted by first member
    // path, members sorted within the bucket — four streams walk the
    // disk in the same forward direction instead of bouncing between
    // distant extents.
    let mut ordered: Vec<Bucket> = survivors.to_vec();
    for ((_, _), g) in &mut ordered {
        g.sort_unstable_by(|&a, &b| candidates[a].path.cmp(&candidates[b].path));
    }
    ordered.sort_unstable_by(|a, b| {
        candidates[*a.1.first().unwrap_or(&0)]
            .path
            .cmp(&candidates[*b.1.first().unwrap_or(&0)].path)
    });
    let hashed: Vec<HashedFile> = hash_pool().install(|| {
        ordered
            .par_iter()
            .flat_map(|((size, prefix_digest), group)| {
                group
                    .iter()
                    .filter_map(|&i| {
                        if ctl.cancelled() {
                            return None;
                        }
                        let c = &candidates[i];
                        let (sha256, read) = if *size <= PREFIX {
                            (*prefix_digest, 0)
                        } else {
                            match hash_full(std::path::Path::new(&c.path)) {
                                Some(d) => (d, *size),
                                None => return None,
                            }
                        };
                        ctl.file_done(read);
                        let (vs, fi) = hardlink_identity(std::path::Path::new(&c.path))
                            .unwrap_or((u64::MAX, u64::from(c.id)));
                        Some(HashedFile {
                            path: c.path.clone(),
                            size: *size,
                            volume_serial: vs,
                            file_index: fi,
                            sha256,
                        })
                    })
                    .collect::<Vec<_>>()
            })
            .collect()
    });
    if ctl.cancelled() {
        return Err("cancelled".into());
    }

    // Core ranking (hardlink exclusion + wasted-space sort).
    let groups: Vec<DupeGroup> = dupes::rank(&hashed);
    let (wasted_total, _) = dupes::totals(&groups);
    let views: Vec<DupeGroupView> = groups
        .into_iter()
        .take(200)
        .enumerate()
        .map(|(id, g)| {
            let count = g.files.len() as u64;
            DupeGroupView {
                id,
                paths: g.files,
                size: g.size,
                count,
                wasted: g.wasted,
            }
        })
        .collect();
    ctl.set_phase(PHASE_DONE, 0, 0);
    Ok(DupesResult {
        generation: tree.generation,
        groups: views,
        wasted_total,
        files: total_files,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mid_sample_windows_never_overlap() {
        // The tier only runs when size > PREFIX + 2*SAMPLE; at the
        // boundary the windows touch exactly (A ends at PREFIX+SAMPLE,
        // B starts at size-SAMPLE = PREFIX+SAMPLE).
        let size = PREFIX + 2 * SAMPLE;
        assert_eq!(PREFIX + SAMPLE, size - SAMPLE);
    }

    #[test]
    fn phase_dto_is_camelcased() {
        // The UI reads phase/filesDone/bytesDone + the session-5
        // cumulative fields — serde must camelCase all of them.
        let p = DupesProgress {
            phase: "prefix".into(),
            files_done: 1,
            files_total: 2,
            bytes_done: 3,
            bytes_total: 4,
            elapsed_ms: 5,
            files_done_all: 6,
            bytes_done_all: 7,
            overall: 0.5,
        };
        let s = serde_json::to_string(&p).expect("serialize");
        assert!(s.contains("\"filesDone\""), "camelCase DTO: {s}");
        assert!(s.contains("\"bytesDone\""), "camelCase DTO: {s}");
        assert!(s.contains("\"elapsedMs\""), "camelCase DTO: {s}");
        assert!(s.contains("\"filesDoneAll\""), "camelCase DTO: {s}");
        assert!(s.contains("\"bytesDoneAll\""), "camelCase DTO: {s}");
        assert!(s.contains("\"overall\""), "camelCase DTO: {s}");
    }

    #[test]
    fn phase_weights_partition_the_axis() {
        // The bar must land on exactly 100% at `done` and never exceed 1.
        // The first FIVE entries form the sequential ramp; the cancelled
        // entry (index 5) is a reset marker OUTSIDE the ramp — a cancel
        // clears the bar with the view, it does not continue the ramp
        // (contiguity through it is meaningless and the ramp must still
        // sum to exactly 1.0 on its own).
        let mut acc = 0.0f32;
        for (start, span) in PHASE_WEIGHTS.iter().take(5) {
            assert!((0.0..=1.0).contains(start), "weight start in range");
            assert!(*span >= 0.0, "weight span non-negative");
            assert!((start - acc).abs() < 1e-6, "weights are contiguous");
            acc = start + span;
        }
        assert!((acc - 1.0).abs() < 1e-6, "ramp sums to 1.0 (got {acc})");
        assert_eq!(
            PHASE_WEIGHTS[usize::from(PHASE_CANCELLED)],
            (0.0, 0.0),
            "cancelled resets, it does not ramp"
        );
    }

    #[test]
    fn overall_is_monotonic_across_a_full_run() {
        // The blink fix's core promise: no phase boundary can move the
        // global bar backwards (the old per-phase bar snapped to 0%
        // four times per scan and read as blinking/lagging).
        let ctl = DupesCtl::quiet(Arc::new(AtomicU64::new(0)));
        let mut last = 0.0f32;
        // (no `mut`: the closure captures `ctl` by shared reference —
        // `unused_mut` is a hard error under CI's `-D warnings`.)
        let check = |last: &mut f32| {
            let s = ctl.snapshot();
            assert!(
                s.overall >= *last - 1e-6,
                "overall regressed: {} -> {} ({})",
                *last,
                s.overall,
                s.phase
            );
            *last = s.overall;
        };
        check(&mut last); // collect (empty)
        ctl.set_phase(PHASE_PREFIX, 100, 100 * 1024);
        for i in 1..=100u64 {
            ctl.file_done(1024);
            if i % 25 == 0 {
                check(&mut last);
            }
        }
        ctl.set_phase(PHASE_SCREEN, 10, 10 * 2 * SAMPLE);
        check(&mut last); // boundary: 47% must be >= 47%
        for _ in 0..10 {
            ctl.file_done(2 * SAMPLE);
        }
        check(&mut last);
        ctl.set_phase(PHASE_FULL, 4, 4 * 1024 * 1024 * 1024);
        check(&mut last);
        for i in 1..=4u64 {
            ctl.file_done(1024 * 1024 * 1024);
            if i % 2 == 0 {
                check(&mut last);
            }
        }
        ctl.set_phase(PHASE_DONE, 0, 0);
        check(&mut last);
        assert!((ctl.snapshot().overall - 1.0).abs() < 1e-6, "done = 100%");
        // Cumulative counters survived every boundary (rate/ETA source).
        let s = ctl.snapshot();
        assert_eq!(s.files_done_all, 114, "cumulative files");
        assert!(s.bytes_done_all > 0, "cumulative bytes");
    }

    #[cfg(windows)]
    mod windows_e2e {
        use super::*;
        use diskbytes_core::scan::scanner::{scan, Progress, ScanOutcome, ScanTarget};
        use parking_lot::Mutex;
        use std::fs;
        use std::os::windows::fs::OpenOptionsExt;
        use std::path::PathBuf;

        /// Unique scratch dir under %TEMP% (no tempfile dep).
        fn scratch(name: &str) -> PathBuf {
            let d =
                std::env::temp_dir().join(format!("db-dupes-e2e-{}-{}", std::process::id(), name));
            let _ = fs::remove_dir_all(&d); // R7.1-allow: test-scratch (own %TEMP% dir, test-only)
            fs::create_dir_all(&d).expect("scratch dir");
            d
        }

        /// Deterministic pseudo-random content (xorshift64) — fast and
        /// good enough that SHA-256 collides only for identical inputs.
        fn blob(seed: u64, size: usize) -> Vec<u8> {
            let mut s = seed | 1;
            let mut v = Vec::with_capacity(size);
            while v.len() < size {
                s ^= s << 13;
                s ^= s >> 7;
                s ^= s << 17;
                v.extend_from_slice(&s.to_le_bytes());
            }
            v.truncate(size);
            v
        }

        /// Keeps the scratch dir alive for the test body.
        struct TempTree(PathBuf);
        impl Drop for TempTree {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0); // R7.1-allow: test-scratch (own %TEMP% dir, test-only)
            }
        }

        /// Scan a REAL folder with the REAL Windows platform, then run
        /// the exact production pipeline over it. Planted content:
        /// - 3 identical 8 MiB files → one group, 3 copies
        /// - 2 same-size 8 MiB files with an IDENTICAL 64 KiB prefix but
        ///   differences inside the mid windows → screened at tier 2
        /// - 2 identical 300 KiB files → small-file path, one group
        /// - 3 zero-byte files → ignored (spec §10)
        /// - 1 file held open with share_mode(0) → unreadable, skipped
        #[test]
        fn pipeline_finds_planted_groups_and_screens_false_positives() {
            let root = scratch("main");
            let _keep = TempTree(root.clone());
            let mib = 1024 * 1024u64;
            let big = blob(0xC0FF_EEEE, 8 * mib as usize);
            // Same 64 KiB prefix, one flipped byte INSIDE window A
            // (+512 KiB) and one INSIDE window B (size - 512 KiB) —
            // the screen must kill this pair before the full read.
            let mut fp_a = blob(1, 8 * mib as usize);
            let mut fp_b = blob(1, 8 * mib as usize);
            fp_a[..PREFIX as usize].copy_from_slice(&big[..PREFIX as usize]);
            fp_b[..PREFIX as usize].copy_from_slice(&big[..PREFIX as usize]);
            fp_a[(PREFIX + mib / 2) as usize] ^= 0xFF;
            fp_b[(8 * mib - mib / 2) as usize] ^= 0xFF;
            let small = blob(0xABCD_CDEF, 300 * 1024);

            fs::write(root.join("dup-a.bin"), &big).unwrap();
            fs::write(root.join("dup-b.bin"), &big).unwrap();
            fs::write(root.join("dup-c.bin"), &big).unwrap();
            fs::write(root.join("fp-a.bin"), &fp_a).unwrap();
            fs::write(root.join("fp-b.bin"), &fp_b).unwrap();
            fs::write(root.join("small-1.bin"), &small).unwrap();
            fs::write(root.join("small-2.bin"), &small).unwrap();
            fs::write(root.join("z1.dat"), b"").unwrap();
            fs::write(root.join("z2.dat"), b"").unwrap();
            fs::write(root.join("z3.dat"), b"").unwrap();
            // Locked file (same size as the small pair → would group if
            // readable): hold it open with NO sharing for the whole test.
            fs::write(root.join("small-locked.bin"), &small).unwrap();
            let _locked = std::fs::OpenOptions::new()
                .read(true)
                .share_mode(0)
                .open(root.join("small-locked.bin"))
                .expect("open locked");

            // REAL scan of the folder.
            let platform: Arc<crate::platform::HostPlatform> =
                Arc::new(crate::platform::HostPlatform);
            let cancel = Arc::new(AtomicBool::new(false));
            let progress = Arc::new(Mutex::new(Progress::default()));
            let tree = match scan(
                platform,
                &ScanTarget::Folder(root.to_string_lossy().into_owned()),
                1,
                &cancel,
                &progress,
            ) {
                ScanOutcome::Done(t) => Arc::new(t),
                other => panic!("scan failed: {other:?}"),
            };
            assert!(
                tree.len() >= 12,
                "scan must see the planted tree (got {})",
                tree.len()
            );

            // The exact production pipeline (quiet ctl, no events).
            let t0 = Instant::now();
            let ctl = DupesCtl::quiet(Arc::new(AtomicU64::new(0)));
            let result = compute_dupes(&tree, &ctl).expect("pipeline");
            let elapsed = t0.elapsed();

            // Exactly 2 groups: the 8 MiB triple and the 300 KiB pair.
            assert_eq!(result.groups.len(), 2, "groups: {result:#?}");
            let mut by_size: Vec<(u64, u64, u64)> = result
                .groups
                .iter()
                .map(|g| (g.size, g.count, g.wasted))
                .collect();
            by_size.sort_unstable();
            assert_eq!(
                by_size,
                vec![(300 * 1024, 2, 300 * 1024), (8 * mib, 3, 2 * 8 * mib),],
                "groups: {result:#?}"
            );
            // Neither the screened pair, the locked file, nor the
            // zero-size files may appear anywhere.
            for g in &result.groups {
                for p in &g.paths {
                    assert!(!p.contains("fp-a"), "false positive leaked: {p}");
                    assert!(!p.contains("fp-b"), "false positive leaked: {p}");
                    assert!(!p.contains("locked"), "locked file leaked: {p}");
                    assert!(!p.contains("z1"), "zero-size leaked: {p}");
                }
            }
            // Candidate census: 8 sizeable files (3 dup + 2 fp + 2
            // small + 1 locked); the 3 zero-byte files never collect.
            assert_eq!(result.files, 8, "files considered");
            println!(
                "dupes E2E: 2 groups in {} ms (26 MiB staged)",
                elapsed.as_millis()
            );
        }

        /// The screen primitive itself: same 64 KiB prefix + a flipped
        /// byte inside either mid window must change the fingerprint.
        #[test]
        fn mid_fingerprint_detects_window_differences() {
            let root = scratch("mid");
            let _keep = TempTree(root.clone());
            let mib = 1024 * 1024u64;
            let base = blob(7, 3 * mib as usize);
            let mut a = base.clone();
            let mut b = base.clone();
            a[(PREFIX + mib / 2) as usize] ^= 0xFF; // window A
            b[(3 * mib - mib / 2) as usize] ^= 0xFF; // window B
            fs::write(root.join("base.bin"), &base).unwrap();
            fs::write(root.join("a.bin"), &a).unwrap();
            fs::write(root.join("b.bin"), &b).unwrap();
            let p = |n: &str| root.join(n);
            let h0 = hash_middle(&p("base.bin"), 3 * mib).expect("readable");
            let ha = hash_middle(&p("a.bin"), 3 * mib).expect("readable");
            let hb = hash_middle(&p("b.bin"), 3 * mib).expect("readable");
            assert_ne!(h0, ha, "window A flip must change the mid digest");
            assert_ne!(h0, hb, "window B flip must change the mid digest");
        }

        /// Cancellation: bump the shared generation after the run
        /// latched → the pipeline reports Err("cancelled").
        #[test]
        fn cancellation_mid_pipeline_is_reported() {
            let root = scratch("cancel");
            let _keep = TempTree(root.clone());
            for i in 0..6u64 {
                // Two content groups of 3 files each, all 4 MiB.
                let b = blob(i / 3, 4 * 1024 * 1024);
                fs::write(root.join(format!("c{i}.bin")), &b).unwrap();
            }
            let platform: Arc<crate::platform::HostPlatform> =
                Arc::new(crate::platform::HostPlatform);
            let cancel = Arc::new(AtomicBool::new(false));
            let progress = Arc::new(Mutex::new(Progress::default()));
            let tree = match scan(
                platform,
                &ScanTarget::Folder(root.to_string_lossy().into_owned()),
                1,
                &cancel,
                &progress,
            ) {
                ScanOutcome::Done(t) => Arc::new(t),
                other => panic!("scan failed: {other:?}"),
            };
            let gen = Arc::new(AtomicU64::new(0));
            let ctl = DupesCtl::quiet(Arc::clone(&gen));
            // Simulate a cancel landing after collect: bump before the
            // prefix pass checks it.
            gen.fetch_add(1, Ordering::SeqCst);
            let out = compute_dupes(&tree, &ctl);
            assert_eq!(out.err(), Some("cancelled".to_string()));
        }
    }
}
