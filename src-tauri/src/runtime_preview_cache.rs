use std::collections::{HashSet, VecDeque};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
#[cfg(not(unix))]
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use crate::app_state::{AppState, RuntimePreviewCache, RuntimePreviewCacheEntry};

const RUNTIME_PREVIEWS_DIR: &str = "runtime-previews";
const RUN_MARKER_FILE: &str = "run.json";
const RUN_MARKER_VERSION: u32 = 1;
#[cfg(not(unix))]
const STALE_RUN_AFTER: Duration = Duration::from_secs(7 * 24 * 60 * 60);
pub const LIBRARY_PREVIEW_VERSION: u32 = 1;
pub const LOUPE_TILE_VERSION: u32 = 1;
pub const LIBRARY_PREVIEW_JPEG_QUALITY: u8 = 90;
pub const LOUPE_TILE_JPEG_QUALITY: u8 = 95;
const MAX_LIBRARY_PREVIEWS: usize = 64;
const MAX_LOUPE_TILES: usize = 40;

#[derive(Clone, Copy)]
pub enum RuntimePreviewKind {
    Library,
    Loupe,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeRunMarker {
    version: u32,
    pid: u32,
    started_at_unix_secs: u64,
}

fn runtime_root_dir(app_handle: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_handle
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join(RUNTIME_PREVIEWS_DIR))
}

fn remove_path(path: &Path) {
    if path.is_dir() {
        let _ = fs::remove_dir_all(path);
    } else {
        let _ = fs::remove_file(path);
    }
}

fn unix_secs_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

#[cfg(not(unix))]
fn marker_is_stale(marker: &RuntimeRunMarker) -> bool {
    unix_secs_now().saturating_sub(marker.started_at_unix_secs) >= STALE_RUN_AFTER.as_secs()
}

#[cfg(unix)]
fn pid_is_running(pid: u32) -> bool {
    if pid == std::process::id() {
        return true;
    }

    let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

fn read_run_marker(path: &Path) -> Option<RuntimeRunMarker> {
    fs::read_to_string(path.join(RUN_MARKER_FILE))
        .ok()
        .and_then(|json| serde_json::from_str::<RuntimeRunMarker>(&json).ok())
}

#[cfg(unix)]
fn should_remove_run_dir(path: &Path) -> bool {
    let marker = read_run_marker(path);

    !matches!(
        marker,
        Some(marker)
            if marker.version == RUN_MARKER_VERSION
                && marker.started_at_unix_secs > 0
                && pid_is_running(marker.pid)
    )
}

#[cfg(not(unix))]
fn should_remove_run_dir(path: &Path) -> bool {
    let marker = read_run_marker(path);

    match marker {
        Some(marker) if marker.version == RUN_MARKER_VERSION => marker_is_stale(&marker),
        _ => true,
    }
}

fn cleanup_old_runs(root_dir: &Path, current_run_id: &str) -> Result<(), String> {
    if !root_dir.exists() {
        return Ok(());
    }

    for entry in fs::read_dir(root_dir).map_err(|e| e.to_string())? {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        if entry.file_name().to_string_lossy() == current_run_id {
            continue;
        }

        let path = entry.path();
        if should_remove_run_dir(&path) {
            remove_path(&path);
        }
    }

    Ok(())
}

fn write_run_marker(run_dir: &Path) -> Result<(), String> {
    let marker = RuntimeRunMarker {
        version: RUN_MARKER_VERSION,
        pid: std::process::id(),
        started_at_unix_secs: unix_secs_now(),
    };
    let bytes = serde_json::to_vec(&marker).map_err(|e| e.to_string())?;
    write_atomic(&run_dir.join(RUN_MARKER_FILE), &bytes)
}

pub fn initialize(app_handle: &AppHandle, state: &AppState) -> Result<(), String> {
    let mut cache = state.runtime_preview_cache.lock().unwrap();
    if cache.is_some() {
        return Ok(());
    }

    let run_id = Uuid::new_v4().to_string();
    let root_dir = runtime_root_dir(app_handle)?;
    let run_dir = root_dir.join(&run_id);
    let library_dir = run_dir.join("library");
    let loupe_dir = run_dir.join("loupe");

    fs::create_dir_all(&library_dir).map_err(|e| e.to_string())?;
    fs::create_dir_all(&loupe_dir).map_err(|e| e.to_string())?;
    write_run_marker(&run_dir)?;
    cleanup_old_runs(&root_dir, &run_id)?;

    *cache = Some(RuntimePreviewCache {
        run_dir,
        library_dir,
        loupe_dir,
        library_entries: VecDeque::new(),
        loupe_entries: VecDeque::new(),
        active_loupe_jpg_paths: HashSet::new(),
        library_locks: Default::default(),
        loupe_locks: Default::default(),
    });

    Ok(())
}

fn ensure_initialized(app_handle: &AppHandle, state: &AppState) -> Result<(), String> {
    if state.runtime_preview_cache.lock().unwrap().is_some() {
        return Ok(());
    }
    initialize(app_handle, state)
}

pub fn cleanup_current_run(app_handle: &AppHandle) {
    let state = app_handle.state::<AppState>();
    let run_dir = state
        .runtime_preview_cache
        .lock()
        .unwrap()
        .take()
        .map(|cache| cache.run_dir);

    if let Some(run_dir) = run_dir {
        remove_path(&run_dir);
    }
}

pub fn cache_paths(
    app_handle: &AppHandle,
    state: &AppState,
    kind: RuntimePreviewKind,
    key: &str,
) -> Result<(PathBuf, PathBuf), String> {
    ensure_initialized(app_handle, state)?;

    let cache = state.runtime_preview_cache.lock().unwrap();
    let cache = cache
        .as_ref()
        .ok_or_else(|| "Runtime preview cache is unavailable.".to_string())?;
    let dir = match kind {
        RuntimePreviewKind::Library => &cache.library_dir,
        RuntimePreviewKind::Loupe => &cache.loupe_dir,
    };

    Ok((
        dir.join(format!("{}.jpg", key)),
        dir.join(format!("{}.json", key)),
    ))
}

fn get_render_lock(
    app_handle: &AppHandle,
    state: &AppState,
    kind: RuntimePreviewKind,
    key: &str,
) -> Result<Arc<Mutex<()>>, String> {
    ensure_initialized(app_handle, state)?;

    let mut cache = state.runtime_preview_cache.lock().unwrap();
    let cache = cache
        .as_mut()
        .ok_or_else(|| "Runtime preview cache is unavailable.".to_string())?;
    let locks = match kind {
        RuntimePreviewKind::Library => &mut cache.library_locks,
        RuntimePreviewKind::Loupe => &mut cache.loupe_locks,
    };

    Ok(locks
        .entry(key.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone())
}

fn remove_render_lock(
    state: &AppState,
    kind: RuntimePreviewKind,
    key: &str,
    lock: &Arc<Mutex<()>>,
) {
    let mut cache = state.runtime_preview_cache.lock().unwrap();
    let Some(cache) = cache.as_mut() else {
        return;
    };
    let locks = match kind {
        RuntimePreviewKind::Library => &mut cache.library_locks,
        RuntimePreviewKind::Loupe => &mut cache.loupe_locks,
    };

    let should_remove = locks
        .get(key)
        .map(|stored| Arc::ptr_eq(stored, lock) && Arc::strong_count(lock) <= 2)
        .unwrap_or(false);
    if should_remove {
        locks.remove(key);
    }
}

pub fn with_render_lock<T, F>(
    app_handle: &AppHandle,
    state: &AppState,
    kind: RuntimePreviewKind,
    key: &str,
    render: F,
) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String>,
{
    let lock = get_render_lock(app_handle, state, kind, key)?;
    let guard = lock.lock().unwrap();
    let result = render();
    drop(guard);
    remove_render_lock(state, kind, key, &lock);
    result
}

fn tmp_path(path: &Path) -> PathBuf {
    let mut tmp = path.to_path_buf();
    let file_name = path
        .file_name()
        .map(|name| format!("{}.tmp", name.to_string_lossy()))
        .unwrap_or_else(|| "runtime-preview.tmp".to_string());
    tmp.set_file_name(file_name);
    tmp
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let tmp = tmp_path(path);
    let mut file = fs::File::create(&tmp).map_err(|e| e.to_string())?;
    file.write_all(bytes).map_err(|e| e.to_string())?;
    file.flush().map_err(|e| e.to_string())?;
    drop(file);

    match fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(_error) if path.exists() => {
            fs::remove_file(path).map_err(|e| e.to_string())?;
            fs::rename(&tmp, path).map_err(|e| {
                let _ = fs::remove_file(&tmp);
                e.to_string()
            })
        }
        Err(error) => {
            let _ = fs::remove_file(&tmp);
            Err(error.to_string())
        }
    }
}

fn entries_for(
    cache: &mut RuntimePreviewCache,
    kind: RuntimePreviewKind,
) -> &mut VecDeque<RuntimePreviewCacheEntry> {
    match kind {
        RuntimePreviewKind::Library => &mut cache.library_entries,
        RuntimePreviewKind::Loupe => &mut cache.loupe_entries,
    }
}

fn prune_entries(
    entries: &mut VecDeque<RuntimePreviewCacheEntry>,
    max_entries: usize,
    active_jpg_paths: Option<&HashSet<PathBuf>>,
) {
    while entries.len() > max_entries {
        let removable_index = entries.iter().position(|entry| {
            active_jpg_paths
                .map(|active_paths| !active_paths.contains(&entry.jpg_path))
                .unwrap_or(true)
        });

        let Some(index) = removable_index else {
            break;
        };
        if let Some(entry) = entries.remove(index) {
            let _ = fs::remove_file(entry.jpg_path);
            let _ = fs::remove_file(entry.json_path);
        }
    }
}

pub fn track_entry(
    state: &AppState,
    kind: RuntimePreviewKind,
    jpg_path: PathBuf,
    json_path: PathBuf,
) {
    let mut cache = state.runtime_preview_cache.lock().unwrap();
    let Some(cache) = cache.as_mut() else {
        return;
    };

    {
        let entries = entries_for(cache, kind);
        if let Some(index) = entries.iter().position(|entry| entry.jpg_path == jpg_path) {
            entries.remove(index);
        }
        entries.push_back(RuntimePreviewCacheEntry {
            jpg_path,
            json_path,
        });
    }

    match kind {
        RuntimePreviewKind::Library => {
            prune_entries(&mut cache.library_entries, MAX_LIBRARY_PREVIEWS, None);
        }
        RuntimePreviewKind::Loupe => {
            let active_loupe_jpg_paths = cache.active_loupe_jpg_paths.clone();
            prune_entries(
                &mut cache.loupe_entries,
                MAX_LOUPE_TILES,
                Some(&active_loupe_jpg_paths),
            );
        }
    }
}

fn valid_active_loupe_jpg_path(loupe_dir: &Path, path: PathBuf) -> Option<PathBuf> {
    let is_jpg = path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.eq_ignore_ascii_case("jpg"))
        .unwrap_or(false);
    if !is_jpg {
        return None;
    }

    let relative = path.strip_prefix(loupe_dir).ok()?;
    if relative.components().count() == 1 {
        Some(path)
    } else {
        None
    }
}

pub fn set_active_loupe_preview_paths(state: &AppState, paths: Vec<String>) {
    let mut cache = state.runtime_preview_cache.lock().unwrap();
    let Some(cache) = cache.as_mut() else {
        return;
    };

    cache.active_loupe_jpg_paths = paths
        .into_iter()
        .filter_map(|path| valid_active_loupe_jpg_path(&cache.loupe_dir, PathBuf::from(path)))
        .collect();
    let active_loupe_jpg_paths = cache.active_loupe_jpg_paths.clone();
    prune_entries(
        &mut cache.loupe_entries,
        MAX_LOUPE_TILES,
        Some(&active_loupe_jpg_paths),
    );
}

pub fn write_entry<T: Serialize>(
    state: &AppState,
    kind: RuntimePreviewKind,
    jpg_path: &Path,
    jpg_bytes: &[u8],
    json_path: &Path,
    sidecar: &T,
) -> Result<(), String> {
    let json_bytes = serde_json::to_vec(sidecar).map_err(|e| e.to_string())?;

    if let Err(error) = write_atomic(jpg_path, jpg_bytes) {
        let _ = fs::remove_file(jpg_path);
        let _ = fs::remove_file(tmp_path(jpg_path));
        return Err(error);
    }

    if let Err(error) = write_atomic(json_path, &json_bytes) {
        let _ = fs::remove_file(jpg_path);
        let _ = fs::remove_file(json_path);
        let _ = fs::remove_file(tmp_path(jpg_path));
        let _ = fs::remove_file(tmp_path(json_path));
        return Err(error);
    }

    track_entry(state, kind, jpg_path.to_path_buf(), json_path.to_path_buf());
    Ok(())
}

pub fn hash_cache_parts(parts: &[&str]) -> String {
    let mut hasher = blake3::Hasher::new();
    for part in parts {
        hasher.update(part.as_bytes());
        hasher.update(&[0]);
    }
    hasher.finalize().to_hex().to_string()
}

pub fn file_modified_key(path: &Path) -> String {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos().to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

pub fn file_identity_key(path: &Path) -> String {
    fs::metadata(path)
        .map(|metadata| {
            let modified = metadata
                .modified()
                .ok()
                .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_nanos().to_string())
                .unwrap_or_else(|| "unknown".to_string());
            format!("{}:{}", metadata.len(), modified)
        })
        .unwrap_or_else(|_| "missing".to_string())
}
