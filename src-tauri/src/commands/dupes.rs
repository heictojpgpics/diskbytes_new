//! Duplicates commands (spec §10; doc 03 M8): the 3-pass flow
//! (size-grouping, 64 KiB prefix SHA-256, full hashing for matches,
//! both hash passes parallel on rayon). Hardlink exclusion via
//! (volume-serial, file-index); cloud placeholders never open (R7.3);
//! wasted-space ranking per the spec.

use std::collections::HashMap;
use std::sync::Arc;

use diskbytes_core::dupes::{self, DupeGroup, HashedFile};

use rayon::prelude::*;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::State;

use crate::state::AppState;

/// Prefix-hash chunk (64 KiB, spec §10).
const PREFIX: u64 = 64 * 1024;
/// Full-hash read chunk (1 MiB, spec §10).
const CHUNK: usize = 1024 * 1024;

/// A pass-3 group: `((size, prefix digest), candidate indices)` —
/// prefix survivors with ≥ 2 members that need full hashing. (A type
/// alias because the spelled-out tuple trips `clippy::type_complexity`.)
type PrefixBucket = ((u64, [u8; 32]), Vec<usize>);

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

/// Full hash (pass 3, read in 1 MiB chunks). `None` = unreadable.
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
    let result = tauri::async_runtime::spawn_blocking(move || compute_dupes(&tree))
        .await
        .map_err(|e| format!("dupes thread failed: {e}"))?;
    Ok(result)
}

/// The full pipeline (spec §10 3-pass): collect → size groups →
/// prefix/full hashes → hardlink exclusion → wasted-space ranking via
/// the core. BOTH hash passes run in PARALLEL on rayon — the passes are
/// pure I/O, and an NVMe drive serves 4+ concurrent reads at full
/// queue depth; single-threaded hashing left that bandwidth on the
/// table. The prefix screen (pass 2) means two same-size 5 GB videos
/// cost 128 KiB of reads when they differ — the full read only happens
/// for files whose first 64 KiB already match.
#[allow(clippy::too_many_lines)] // 3-pass pipeline; the pass structure is the spec
fn compute_dupes(tree: &diskbytes_core::scan::node::Tree) -> DupesResult {
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
    let digests: Vec<Option<[u8; 32]>> = prefix_targets
        .par_iter()
        .map(|&i| hash_prefix(std::path::Path::new(&candidates[i].path)))
        .collect();

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

    // Pass 3 (parallel): full hash the prefix survivors only — every
    // survivor hashes concurrently; the per-bucket ordering the old
    // streaming path needed is gone, and `rank` re-sorts globally
    // anyway. Files ≤ PREFIX long already have their full digest from
    // pass 2 — reused verbatim, zero re-reads.
    let survivors: Vec<PrefixBucket> = by_prefix
        .into_iter()
        .filter(|(_, g)| g.len() >= 2)
        .collect();
    let hashed: Vec<HashedFile> = survivors
        .par_iter()
        .flat_map(|((size, prefix_digest), group)| {
            group
                .iter()
                .filter_map(|&i| {
                    let c = &candidates[i];
                    let sha256 = if *size <= PREFIX {
                        Some(*prefix_digest)
                    } else {
                        hash_full(std::path::Path::new(&c.path))
                    }?;
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
        .collect();

    // Core ranking (hardlink exclusion + wasted-space sort).
    let groups: Vec<DupeGroup> = dupes::rank(&hashed);
    let (wasted_total, group_count) = dupes::totals(&groups);
    let _ = group_count;
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
    DupesResult {
        generation: tree.generation,
        groups: views,
        wasted_total,
        files: total_files,
    }
}
