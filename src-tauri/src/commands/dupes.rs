//! Duplicates commands (spec §10; doc 03 M8): the 3-pass flow
//! (size-grouping, 64 KiB prefix SHA-256, full hashing for matches)
//! streamed in 1 MiB chunks. Hardlink exclusion via
//! (volume-serial, file-index); cloud placeholders never open (R7.3);
//! wasted-space ranking per the spec.

use std::collections::HashMap;
use std::sync::Arc;

use diskbytes_core::dupes::{self, DupeGroup, HashedFile};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, State};

use crate::state::AppState;

/// Prefix-hash chunk (64 KiB, spec §10).
const PREFIX: u64 = 64 * 1024;
/// Full-hash streaming chunk (1 MiB, spec §10).
const CHUNK: usize = 1024 * 1024;

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

/// Hash ONLY the first `PREFIX` bytes (pass 2). `None` = unreadable
/// (skipped honestly). For files ≤ PREFIX this IS the full digest.
fn hash_prefix(path: &std::path::Path) -> Option<[u8; 32]> {
    use std::io::Read;
    let mut f = std::fs::File::open(path).ok()?;
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

/// Full-hash streaming (pass 3, 1 MiB chunks). `None` = unreadable.
fn hash_full(path: &std::path::Path) -> Option<[u8; 32]> {
    use std::io::Read;
    let mut f = std::fs::File::open(path).ok()?;
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

/// Find duplicates in the current tree (spec §10 3-pass).
///
/// # Errors
/// String error when no scan exists or the generation is stale.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // State extraction is the tauri command contract
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
    let result = tauri::async_runtime::spawn_blocking(move || compute_dupes(&tree, &app))
        .await
        .map_err(|e| format!("dupes thread failed: {e}"))?;
    Ok(result)
}

/// The full pipeline (spec §10 3-pass): collect → size groups →
/// prefix/full hashes → hardlink exclusion → wasted-space ranking via
/// the core. Groups STREAM to the UI as `dupes-group` events while
/// full hashing progresses (best-value-first: the largest buckets
/// hash first, so the groups that dominate reclaimable space land
/// first) — the command's return value stays the authoritative,
/// fully-ranked result and replaces the streamed provisional rows.
#[allow(clippy::too_many_lines)] // 3-pass pipeline + streaming emission; the pass structure is the spec
fn compute_dupes(tree: &diskbytes_core::scan::node::Tree, app: &AppHandle) -> DupesResult {
    // Collect live files (cloud placeholders NEVER opened — R7.3).
    struct Candidate {
        path: String,
        size: u64,
        id: u32,
    }
    let mut candidates: Vec<Candidate> = Vec::new();
    tree.walk(tree.root, |id, n| {
        if !n.is_dir() && !n.is_removed() && !n.is_cloud_placeholder() && n.logical > 0 {
            candidates.push(Candidate {
                path: tree.node_path(id),
                size: n.logical,
                id,
            });
        }
    });
    let total_files = candidates.len() as u64;

    // Pass 1: size buckets (candidate level).
    let mut by_size: HashMap<u64, Vec<&Candidate>> = HashMap::new();
    for c in &candidates {
        by_size.entry(c.size).or_default().push(c);
    }

    // Passes 2+3 (spec §10, the REAL 3-pass): 64 KiB prefix hash per
    // size-bucket candidate → group by (size, prefix) → FULL hash only
    // where ≥ 2 prefixes match. The previous code full-hashed every
    // bucket member (two same-size 5 GB videos = 10 GB read; now 128 KiB
    // + nothing — the prefix mismatch screens them out).
    // (size, prefix digest) → candidates sharing it.
    let mut by_prefix: HashMap<(u64, [u8; 32]), Vec<&Candidate>> = HashMap::new();
    for (size, bucket) in &by_size {
        if bucket.len() < 2 {
            continue; // Single size = no duplicate candidates.
        }
        for c in bucket {
            if let Some(digest) = hash_prefix(std::path::Path::new(&c.path)) {
                by_prefix.entry((*size, digest)).or_default().push(c);
            }
        }
    }

    // Pass 3: full hash the prefix survivors only. Files ≤ PREFIX long
    // already have their full digest from pass 2 — reuse it verbatim.
    // BUCKET-ORDERED, BIGGEST ESTIMATED WASTED FIRST: the streaming
    // emission below sends each completed bucket's ranked groups as
    // they land, so ordering by value puts the reclaim-heavy groups on
    // screen first (the "no waiting" experience).
    // (Type written as Vec<_>: the spelled-out tuple trips
    // clippy::type_complexity, which CI denies — inference carries it.)
    let mut prefix_order: Vec<_> = by_prefix
        .into_iter()
        .filter(|(_, g)| g.len() >= 2)
        .collect();
    prefix_order.sort_by_key(|((size, _), g)| {
        std::cmp::Reverse(g.len() as u64 * *size) // estimated upper bound
    });

    let mut hashed: Vec<HashedFile> = Vec::new();
    let mut stream_id: usize = 0;
    for ((size, prefix_digest), group) in prefix_order {
        let bucket_start = hashed.len();
        for c in &group {
            let digest = if size <= PREFIX {
                Some(prefix_digest)
            } else {
                hash_full(std::path::Path::new(&c.path))
            };
            let Some(sha256) = digest else {
                continue;
            };
            let (vs, fi) = hardlink_identity(std::path::Path::new(&c.path))
                .unwrap_or((u64::MAX, u64::from(c.id)));
            hashed.push(HashedFile {
                path: c.path.clone(),
                size,
                volume_serial: vs,
                file_index: fi,
                sha256,
            });
        }
        // STREAM this bucket's ranked groups as soon as its full hashes
        // land (provisional ids; the final result re-ids by global
        // wasted order and replaces them — the UI keys transient state
        // by path list, so the swap is seamless).
        for g in dupes::rank(&hashed[bucket_start..]) {
            let count = g.files.len() as u64;
            let view = DupeGroupView {
                id: stream_id,
                paths: g.files,
                size: g.size,
                count,
                wasted: g.wasted,
            };
            stream_id += 1;
            let _ = app.emit("dupes-group", &view);
        }
    }

    // Core ranking (hardlink exclusion + wasted-space sort).
    let groups: Vec<DupeGroup> = dupes::rank(&hashed);
    let (wasted_total, group_count) = dupes::totals(&groups);
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
    let _ = group_count;
    DupesResult {
        generation: tree.generation,
        groups: views,
        wasted_total,
        files: total_files,
    }
}
