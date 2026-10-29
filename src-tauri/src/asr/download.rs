//! Streaming model downloader with checksum verification and progress events.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;

use crate::asr::catalog::{self, CatalogModel, InstallState, InstalledFile, InstalledManifest};
use crate::asr::state::AsrState;
use crate::asr::types::DownloadProgress;
use crate::asr::util::{collapse_whitespace, now_unix_ms, truncate_chars};

const PROGRESS_INTERVAL: Duration = Duration::from_millis(200);
pub(crate) const PROGRESS_EVENT: &str = "asr-download-progress";

enum TransferError {
    Cancelled,
    Failed(String),
}

pub(crate) async fn download(
    app: &AppHandle,
    state: &AsrState,
    model_id: String,
    mirror: String,
) -> Result<(), String> {
    let model_id = model_id.trim();
    let model =
        catalog::find(model_id).ok_or_else(|| format!("Unknown local ASR model: {model_id}"))?;
    let base = mirror_base(mirror.trim())?;
    let model_dir = state.models_dir().join(model.id);

    let inspection = catalog::inspect(&model_dir, model);
    if inspection.state == InstallState::Installed {
        return Err(format!("{} is already installed.", model.name));
    }

    let cancel = state.begin_download(model.id)?;
    let mut reporter = ProgressReporter::new(app, state, model);

    if let Err(message) = prepare_directory(&model_dir).await {
        reporter.fail(&message);
        remove_model_dir(&model_dir).await;
        state.finish_download(model.id);
        return Err(message);
    }

    let outcome = transfer_model(state, model, base, &model_dir, &cancel, &mut reporter).await;

    match outcome {
        Ok(()) => {
            reporter.complete();
            state.finish_download(model.id);
            Ok(())
        }
        Err(TransferError::Cancelled) => {
            reporter.cancelled();
            remove_model_dir(&model_dir).await;
            state.finish_download(model.id);
            Ok(())
        }
        Err(TransferError::Failed(message)) => {
            reporter.fail(&message);
            remove_model_dir(&model_dir).await;
            state.finish_download(model.id);
            Err(message)
        }
    }
}

async fn transfer_model(
    state: &AsrState,
    model: &CatalogModel,
    base: &str,
    model_dir: &Path,
    cancel: &AtomicBool,
    reporter: &mut ProgressReporter<'_>,
) -> Result<(), TransferError> {
    let mut completed_bytes = 0u64;

    for (index, file) in model.files.iter().enumerate() {
        if is_cancelled(cancel) {
            return Err(TransferError::Cancelled);
        }
        reporter.start_file(index, file.path, completed_bytes);

        let url = format!("{}/{}/resolve/main/{}", base, model.repo, file.path);
        let response = state
            .download_http()
            .get(&url)
            .send()
            .await
            .map_err(|error| {
                TransferError::Failed(format!(
                    "Could not start downloading {}: {}",
                    file.path,
                    truncate_chars(&collapse_whitespace(&error.to_string()), 300)
                ))
            })?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            let detail = truncate_chars(&collapse_whitespace(&body), 300);
            let mut message = format!(
                "Downloading {} failed (HTTP {}).",
                file.path,
                status.as_u16()
            );
            if !detail.is_empty() {
                message.push(' ');
                message.push_str(&detail);
            }
            return Err(TransferError::Failed(message));
        }

        let path = model_dir.join(file.path);
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|error| {
                TransferError::Failed(format!(
                    "Could not create directory {}: {error}",
                    parent.display()
                ))
            })?;
        }
        let mut output = tokio::fs::File::create(&path).await.map_err(|error| {
            TransferError::Failed(format!("Could not create {}: {error}", path.display()))
        })?;

        let mut hasher = Sha256::new();
        let mut downloaded = 0u64;
        let mut stream = response.bytes_stream();

        while let Some(chunk) = stream.next().await {
            if is_cancelled(cancel) {
                return Err(TransferError::Cancelled);
            }
            let chunk = chunk.map_err(|error| {
                TransferError::Failed(format!(
                    "Downloading {} was interrupted: {}",
                    file.path,
                    truncate_chars(&collapse_whitespace(&error.to_string()), 300)
                ))
            })?;

            output.write_all(&chunk).await.map_err(|error| {
                TransferError::Failed(format!("Could not write {}: {error}", path.display()))
            })?;
            hasher.update(&chunk);
            downloaded = downloaded.saturating_add(chunk.len() as u64);
            reporter.set_downloaded(downloaded);

            if downloaded > file.size {
                return Err(TransferError::Failed(format!(
                    "{} is larger than expected (expected {} bytes, received at least {} bytes).",
                    file.path, file.size, downloaded
                )));
            }
        }

        output.flush().await.map_err(|error| {
            TransferError::Failed(format!(
                "Could not finish writing {}: {error}",
                path.display()
            ))
        })?;
        drop(output);

        if is_cancelled(cancel) {
            return Err(TransferError::Cancelled);
        }

        reporter.set_phase("verifying", Some(format!("Verifying {}", file.path)));
        let digest = format!("{:x}", hasher.finalize());
        if downloaded != file.size {
            return Err(TransferError::Failed(format!(
                "Checksum verification failed for {}: expected {} bytes but received {} bytes.",
                file.path, file.size, downloaded
            )));
        }
        if digest != file.sha256 {
            return Err(TransferError::Failed(format!(
                "Checksum verification failed for {}: expected SHA-256 {} but received {}.",
                file.path, file.sha256, digest
            )));
        }

        completed_bytes = completed_bytes.saturating_add(file.size);
        reporter.set_completed(completed_bytes);
    }

    if is_cancelled(cancel) {
        return Err(TransferError::Cancelled);
    }

    write_manifest(model_dir, model)
        .await
        .map_err(TransferError::Failed)
}

async fn prepare_directory(model_dir: &Path) -> Result<(), String> {
    match tokio::fs::remove_dir_all(model_dir).await {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "Could not clear the existing model directory {}: {error}",
                model_dir.display()
            ));
        }
    }
    tokio::fs::create_dir_all(model_dir).await.map_err(|error| {
        format!(
            "Could not create the model directory {}: {error}",
            model_dir.display()
        )
    })
}

async fn remove_model_dir(model_dir: &Path) {
    if let Err(error) = tokio::fs::remove_dir_all(model_dir).await
        && error.kind() != std::io::ErrorKind::NotFound
    {
        log::warn!(
            "Could not remove incomplete ASR model directory {}: {error}",
            model_dir.display()
        );
    }
}

async fn write_manifest(model_dir: &Path, model: &CatalogModel) -> Result<(), String> {
    let manifest = InstalledManifest {
        model_id: model.id.to_string(),
        installed_at: now_unix_ms(),
        files: model
            .files
            .iter()
            .map(|file| InstalledFile {
                path: file.path.to_string(),
                size: file.size,
                sha256: file.sha256.to_string(),
            })
            .collect(),
        total_bytes: model.total_bytes(),
    };
    let data = serde_json::to_vec_pretty(&manifest)
        .map_err(|error| format!("Could not serialize the install manifest: {error}"))?;
    let manifest_path = catalog::manifest_file(model_dir);
    let temp_path = manifest_path.with_extension("json.tmp");

    tokio::fs::write(&temp_path, &data).await.map_err(|error| {
        format!(
            "Could not write the install manifest {}: {error}",
            temp_path.display()
        )
    })?;
    tokio::fs::rename(&temp_path, &manifest_path)
        .await
        .map_err(|error| {
            format!(
                "Could not finalize the install manifest {}: {error}",
                manifest_path.display()
            )
        })
}

pub(crate) fn mirror_base(mirror: &str) -> Result<&'static str, String> {
    match mirror {
        "hf-mirror" | "" => Ok("https://hf-mirror.com"),
        "huggingface" => Ok("https://huggingface.co"),
        other => Err(format!(
            "Unsupported download mirror \"{other}\". Use \"hf-mirror\" or \"huggingface\"."
        )),
    }
}

fn is_cancelled(cancel: &AtomicBool) -> bool {
    cancel.load(Ordering::SeqCst)
}

struct ProgressReporter<'a> {
    app: &'a AppHandle,
    state: &'a AsrState,
    progress: DownloadProgress,
    last_emit: Instant,
}

impl<'a> ProgressReporter<'a> {
    fn new(app: &'a AppHandle, state: &'a AsrState, model: &CatalogModel) -> Self {
        let progress = DownloadProgress {
            model_id: model.id.to_string(),
            status: "downloading".to_string(),
            file_index: 0,
            file_count: model.files.len(),
            file_name: model
                .files
                .first()
                .map(|file| file.path.to_string())
                .unwrap_or_default(),
            downloaded_bytes: 0,
            completed_bytes: 0,
            total_bytes: model.total_bytes(),
            percent: 0.0,
            message: None,
        };
        let mut reporter = Self {
            app,
            state,
            progress,
            last_emit: Instant::now(),
        };
        reporter.publish();
        reporter
    }

    fn start_file(&mut self, index: usize, file_name: &str, completed_bytes: u64) {
        self.progress.file_index = index;
        self.progress.file_name = file_name.to_string();
        self.progress.completed_bytes = completed_bytes;
        self.progress.downloaded_bytes = 0;
        self.progress.status = "downloading".to_string();
        self.progress.message = None;
        self.recalculate();
        self.publish();
    }

    fn set_downloaded(&mut self, downloaded_bytes: u64) {
        self.progress.downloaded_bytes = downloaded_bytes;
        self.recalculate();
        if self.last_emit.elapsed() >= PROGRESS_INTERVAL {
            self.publish();
        }
    }

    fn set_completed(&mut self, completed_bytes: u64) {
        self.progress.completed_bytes = completed_bytes;
        self.recalculate();
    }

    fn set_phase(&mut self, status: &str, message: Option<String>) {
        self.progress.status = status.to_string();
        self.progress.message = message;
        self.recalculate();
        self.publish();
    }

    fn fail(&mut self, message: &str) {
        self.set_phase("failed", Some(message.to_string()));
    }

    fn cancelled(&mut self) {
        self.set_phase("cancelled", Some("Download cancelled.".to_string()));
    }

    fn complete(&mut self) {
        self.progress.status = "completed".to_string();
        self.progress.percent = 100.0;
        self.progress.message = Some("Model installed.".to_string());
        self.publish();
    }

    fn recalculate(&mut self) {
        let total = self.progress.total_bytes;
        let done = self
            .progress
            .completed_bytes
            .saturating_add(self.progress.downloaded_bytes);
        self.progress.percent = if total == 0 {
            0.0
        } else {
            ((done as f64 / total as f64) * 100.0).clamp(0.0, 100.0)
        };
    }

    fn publish(&mut self) {
        let _ = self.state.store_progress(self.progress.clone());
        let _ = self.app.emit(PROGRESS_EVENT, &self.progress);
        self.last_emit = Instant::now();
    }
}
