//! Shared ASR state: encrypted settings, download tracking, and model snapshots.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::asr::catalog::{self, CATALOG, InstallState};
use crate::asr::types::{AsrLocalSnapshot, AsrSelection, DownloadProgress, LocalModelInfo};

/// Credentials for one provider as persisted in `settings.json`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct StoredProvider {
    pub public: HashMap<String, String>,
    /// Values encrypted with Windows DPAPI, using the `dpapi:` prefix.
    pub secrets: HashMap<String, String>,
    pub key_hint: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct Settings {
    pub providers: HashMap<String, StoredProvider>,
    pub active: AsrSelection,
}

/// Cheap-to-share, thread-safe ASR management state.
pub struct AsrState {
    app_data_dir: PathBuf,
    models_dir: PathBuf,
    settings_path: PathBuf,
    http: reqwest::Client,
    download_http: reqwest::Client,
    settings: Mutex<Settings>,
    cancel_flags: Mutex<HashMap<String, Arc<AtomicBool>>>,
    progress: Mutex<HashMap<String, DownloadProgress>>,
}

impl AsrState {
    /// Create the ASR state rooted at `<app data>/asr`.
    pub fn new(app: &tauri::AppHandle) -> Result<Self, String> {
        let app_data_dir = app.path().app_data_dir().map_err(|error| {
            format!("Could not resolve the application data directory: {error}")
        })?;
        let asr_dir = app_data_dir.join("asr");
        let models_dir = asr_dir.join("models");

        fs::create_dir_all(&asr_dir).map_err(|error| {
            format!(
                "Could not create ASR data directory {}: {error}",
                asr_dir.display()
            )
        })?;
        fs::create_dir_all(&models_dir).map_err(|error| {
            format!(
                "Could not create ASR models directory {}: {error}",
                models_dir.display()
            )
        })?;

        let settings_path = asr_dir.join("settings.json");
        let settings = match load_settings(&settings_path) {
            Ok(settings) => settings,
            Err(error) => {
                // A corrupt settings file must not block application startup;
                // keep the original for recovery and continue unconfigured.
                log::warn!("{error} Starting with empty ASR settings.");
                let backup = settings_path
                    .with_extension(format!("json.corrupt-{}", crate::asr::util::now_unix_ms()));
                if let Err(rename_error) = fs::rename(&settings_path, &backup) {
                    log::warn!(
                        "Could not back up ASR settings {} to {}: {rename_error}",
                        settings_path.display(),
                        backup.display()
                    );
                }
                Settings::default()
            }
        };

        // Probes use a bounded total timeout; downloads intentionally have no
        // total timeout because model archives can take a long time.
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(20))
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|error| format!("Could not create the ASR HTTP client: {error}"))?;
        let download_http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(20))
            .build()
            .map_err(|error| format!("Could not create the ASR download client: {error}"))?;

        Ok(Self {
            app_data_dir,
            models_dir,
            settings_path,
            http,
            download_http,
            settings: Mutex::new(settings),
            cancel_flags: Mutex::new(HashMap::new()),
            progress: Mutex::new(HashMap::new()),
        })
    }

    pub fn app_data_dir(&self) -> &Path {
        &self.app_data_dir
    }

    pub fn models_dir(&self) -> &Path {
        &self.models_dir
    }

    pub fn settings_path(&self) -> &Path {
        &self.settings_path
    }

    pub(crate) fn http(&self) -> &reqwest::Client {
        &self.http
    }

    pub(crate) fn download_http(&self) -> &reqwest::Client {
        &self.download_http
    }

    pub(crate) fn settings_snapshot(&self) -> Result<Settings, String> {
        Ok(lock(&self.settings, "settings")?.clone())
    }

    /// Apply a mutation and persist it. The in-memory state is only replaced
    /// after the new file has been written successfully.
    pub(crate) fn mutate_settings<T>(
        &self,
        mutate: impl FnOnce(&mut Settings) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut guard = lock(&self.settings, "settings")?;
        let mut next = guard.clone();
        let value = mutate(&mut next)?;
        write_settings(&self.settings_path, &next)?;
        *guard = next;
        Ok(value)
    }

    /// Register a new download. Returns an error when one is already active.
    pub(crate) fn begin_download(&self, model_id: &str) -> Result<Arc<AtomicBool>, String> {
        let mut flags = lock(&self.cancel_flags, "download registry")?;
        if flags.contains_key(model_id) {
            return Err(format!("A download is already in progress for {model_id}."));
        }
        let flag = Arc::new(AtomicBool::new(false));
        flags.insert(model_id.to_string(), Arc::clone(&flag));
        Ok(flag)
    }

    /// Remove the tracking entries for a finished download.
    pub(crate) fn finish_download(&self, model_id: &str) {
        if let Ok(mut flags) = self.cancel_flags.lock() {
            flags.remove(model_id);
        }
        if let Ok(mut progress) = self.progress.lock() {
            progress.remove(model_id);
        }
    }

    /// Request cancellation. Returns whether a download was active.
    pub(crate) fn cancel_download(&self, model_id: &str) -> Result<bool, String> {
        let flags = lock(&self.cancel_flags, "download registry")?;
        match flags.get(model_id) {
            Some(flag) => {
                flag.store(true, Ordering::SeqCst);
                Ok(true)
            }
            None => Ok(false),
        }
    }

    pub(crate) fn is_downloading(&self, model_id: &str) -> bool {
        self.cancel_flags
            .lock()
            .map(|flags| flags.contains_key(model_id))
            .unwrap_or(false)
    }

    pub(crate) fn store_progress(&self, progress: DownloadProgress) -> Result<(), String> {
        let mut entries = lock(&self.progress, "download progress")?;
        entries.insert(progress.model_id.clone(), progress);
        Ok(())
    }

    pub(crate) fn progress_snapshot(&self) -> Result<HashMap<String, DownloadProgress>, String> {
        Ok(lock(&self.progress, "download progress")?.clone())
    }

    fn downloading_ids(&self) -> Result<std::collections::HashSet<String>, String> {
        let flags = lock(&self.cancel_flags, "download registry")?;
        Ok(flags.keys().cloned().collect())
    }

    /// Build the catalog snapshot shown by `asr_local_models`.
    pub(crate) fn local_snapshot(&self) -> Result<AsrLocalSnapshot, String> {
        let settings = self.settings_snapshot()?;
        let progress = self.progress_snapshot()?;
        let downloading = self.downloading_ids()?;

        let models = CATALOG
            .iter()
            .map(|model| {
                let model_dir = self.models_dir.join(model.id);
                let inspection = catalog::inspect(&model_dir, model);
                let is_downloading = downloading.contains(model.id);

                let (status, installed_bytes, installed_path, installed_at) = if is_downloading {
                    ("downloading", 0, None, None)
                } else {
                    match inspection.state {
                        InstallState::Installed => (
                            "installed",
                            inspection.installed_bytes,
                            Some(model_dir.to_string_lossy().into_owned()),
                            inspection.installed_at,
                        ),
                        InstallState::Corrupted => (
                            "corrupted",
                            inspection.installed_bytes,
                            Some(model_dir.to_string_lossy().into_owned()),
                            inspection.installed_at,
                        ),
                        InstallState::NotInstalled => ("not-installed", 0, None, None),
                    }
                };

                LocalModelInfo {
                    id: model.id.to_string(),
                    name: model.name.to_string(),
                    vendor: model.vendor.to_string(),
                    description: model.description.to_string(),
                    repo: model.repo.to_string(),
                    total_bytes: model.total_bytes(),
                    languages: model
                        .languages
                        .iter()
                        .map(|language| (*language).to_string())
                        .collect(),
                    min_vram_bytes: model.min_vram_bytes,
                    status: status.to_string(),
                    installed_bytes,
                    installed_path,
                    installed_at,
                    progress: if is_downloading {
                        progress.get(model.id).cloned()
                    } else {
                        None
                    },
                }
            })
            .collect();

        Ok(AsrLocalSnapshot {
            models,
            active: settings.active,
            storage_dir: self.models_dir.to_string_lossy().into_owned(),
        })
    }
}

fn lock<'a, T>(mutex: &'a Mutex<T>, label: &str) -> Result<MutexGuard<'a, T>, String> {
    mutex
        .lock()
        .map_err(|_| format!("An internal ASR {label} lock was poisoned."))
}

fn load_settings(path: &Path) -> Result<Settings, String> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Settings::default());
        }
        Err(error) => {
            return Err(format!(
                "Could not read ASR settings {}: {error}",
                path.display()
            ));
        }
    };

    if text.trim().is_empty() {
        return Ok(Settings::default());
    }

    serde_json::from_str(&text)
        .map_err(|error| format!("ASR settings file {} is invalid: {error}", path.display()))
}

fn write_settings(path: &Path, settings: &Settings) -> Result<(), String> {
    let data = serde_json::to_vec_pretty(settings)
        .map_err(|error| format!("Could not serialize ASR settings: {error}"))?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Could not create ASR settings directory {}: {error}",
                parent.display()
            )
        })?;
    }

    let temp_path = path.with_extension("json.tmp");
    fs::write(&temp_path, &data).map_err(|error| {
        format!(
            "Could not write ASR settings {}: {error}",
            temp_path.display()
        )
    })?;

    if let Err(first_error) = fs::rename(&temp_path, path) {
        // Some Windows configurations refuse to replace an existing file
        // in-place; retry after removing the destination.
        if path.exists() {
            fs::remove_file(path).map_err(|error| {
                let _ = fs::remove_file(&temp_path);
                format!("Could not replace ASR settings {}: {error}", path.display())
            })?;
        }
        fs::rename(&temp_path, path).map_err(|second_error| {
            let _ = fs::remove_file(&temp_path);
            format!(
                "Could not save ASR settings {}: {second_error} (initial error: {first_error})",
                path.display()
            )
        })?;
    }

    Ok(())
}
