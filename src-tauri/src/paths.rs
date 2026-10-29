//! Where local meeting data lives.
//!
//! Product decision: recordings, transcripts and the meeting index belong with
//! the product, not in a hidden roaming profile folder, so a user can find,
//! back up or hand over their meetings. Debug builds therefore write to
//! `<repo>/data`, and release builds write to `<install dir>/data`.
//!
//! Writing next to the executable can fail (Program Files is not user-writable),
//! so the write is probed and falls back to the platform data directory instead
//! of crashing or losing a recording.

use std::fs;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

const DATA_DIR_ENV: &str = "MEETING_MASTER_DATA_DIR";

/// Root folder for meeting data: `…/data`.
pub fn data_root(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(custom) = std::env::var_os(DATA_DIR_ENV) {
        let path = PathBuf::from(custom);
        ensure_writable(&path)?;
        return Ok(path);
    }

    let preferred = if cfg!(debug_assertions) {
        // `CARGO_MANIFEST_DIR` is `<repo>/src-tauri` for the dev build.
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(|repo| repo.join("data"))
            .ok_or_else(|| "Could not resolve the development data directory.".to_string())?
    } else {
        std::env::current_exe()
            .map_err(|error| format!("Could not resolve the executable path: {error}"))?
            .parent()
            .map(|dir| dir.join("data"))
            .ok_or_else(|| "Could not resolve the install directory.".to_string())?
    };

    match ensure_writable(&preferred) {
        Ok(()) => Ok(preferred),
        Err(error) => {
            // Read-only install location (e.g. Program Files): keep the product
            // usable, and say so in the log rather than failing the meeting.
            let fallback = match app.path().app_data_dir() {
                Ok(dir) => dir,
                Err(_) => return Err(error),
            };
            log::warn!(
                "Data directory {} is not writable ({error}); using {}. Set {DATA_DIR_ENV} to override.",
                preferred.display(),
                fallback.display()
            );
            fs::create_dir_all(&fallback).map_err(|cause| {
                format!("Could not create the fallback data directory: {cause}")
            })?;
            Ok(fallback)
        }
    }
}

fn ensure_writable(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path)
        .map_err(|error| format!("Could not create {}: {error}", path.display()))?;
    let probe = path.join(".write-probe");
    fs::write(&probe, b"ok")
        .map_err(|error| format!("Could not write to {}: {error}", path.display()))?;
    let _ = fs::remove_file(&probe);
    Ok(())
}

/// Copies meeting data out of the legacy `app_data_dir` location the first time
/// the app runs with the new root, so an upgrade does not look like data loss.
pub fn migrate_legacy_data(app: &AppHandle, root: &Path) -> Result<(), String> {
    let Ok(legacy) = app.path().app_data_dir() else {
        return Ok(());
    };
    if legacy == root {
        return Ok(());
    }
    let legacy_meetings = legacy.join("meetings.json");
    let target_meetings = root.join("meetings.json");
    if !legacy_meetings.is_file() || target_meetings.exists() {
        return Ok(());
    }

    fs::copy(&legacy_meetings, &target_meetings)
        .map_err(|error| format!("Could not migrate meetings.json: {error}"))?;

    let legacy_recordings = legacy.join("recordings");
    let target_recordings = root.join("recordings");
    if legacy_recordings.is_dir() && !target_recordings.exists() {
        copy_tree(&legacy_recordings, &target_recordings)
            .map_err(|error| format!("Could not migrate recordings: {error}"))?;
    }
    log::info!(
        "Migrated meeting data from {} to {}",
        legacy.display(),
        root.display()
    );
    Ok(())
}

fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let source = entry.path();
        let destination = to.join(entry.file_name());
        if source.is_dir() {
            copy_tree(&source, &destination)?;
        } else {
            fs::copy(&source, &destination)?;
        }
    }
    Ok(())
}
