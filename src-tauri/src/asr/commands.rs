//! Tauri command surface for ASR provider and local model management.

use std::collections::HashMap;

use futures_util::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::asr::catalog;
use crate::asr::download;
use crate::asr::hardware;
use crate::asr::probe;
use crate::asr::providers;
use crate::asr::state::AsrState;
use crate::asr::types::{
    AsrLocalSnapshot, AsrSelection, HardwareProfile, ProviderInfo, ProviderTestResult,
};

/// Inspect the GPU, RAM and CPU to recommend a local model.
#[tauri::command]
pub async fn asr_hardware_profile() -> Result<HardwareProfile, String> {
    tauri::async_runtime::spawn_blocking(hardware::detect)
        .await
        .map_err(|error| format!("Hardware detection task failed: {error}"))
}

/// Return the local model catalog with installation and download state.
#[tauri::command]
pub fn asr_local_models(state: State<'_, AsrState>) -> Result<AsrLocalSnapshot, String> {
    state.local_snapshot()
}

/// Save a user-selected model directory for the next launch; existing files are never moved.
#[tauri::command]
pub async fn asr_choose_model_storage(
    app: AppHandle,
    state: State<'_, AsrState>,
) -> Result<Option<String>, String> {
    let selected =
        tauri::async_runtime::spawn_blocking(move || app.dialog().file().blocking_pick_folder())
            .await
            .map_err(|_| "Could not open the folder picker")?;
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|_| "The selected folder is not supported")?;
    if !path.is_dir() {
        return Err("The selected folder is not available".into());
    }
    let probe = path.join(format!(".meeting-master-probe-{}", uuid::Uuid::new_v4()));
    std::fs::write(&probe, b"").map_err(|e| format!("The selected folder is not writable: {e}"))?;
    std::fs::remove_file(&probe)
        .map_err(|e| format!("Could not remove the folder write test: {e}"))?;
    let path = path.to_string_lossy().into_owned();
    state.mutate_settings(|settings| {
        settings.model_storage_dir = Some(path.clone());
        Ok(())
    })?;
    Ok(Some(path))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorLatency {
    mirror: String,
    latency_ms: Option<u64>,
    bytes_per_second: Option<u64>,
    sample_bytes: u64,
    message: String,
}

#[tauri::command]
pub async fn asr_probe_mirrors(state: State<'_, AsrState>) -> Result<Vec<MirrorLatency>, String> {
    let model = catalog::CATALOG
        .first()
        .ok_or("No model is available for the mirror test")?;
    let file = model
        .files
        .first()
        .ok_or("The model has no downloadable file")?;
    let state = state.inner();
    let probe = |name: &'static str| async move {
        let url = format!(
            "{}/{}/resolve/main/{}",
            download::mirror_base(name).unwrap(),
            model.repo,
            file.path
        );
        let start = std::time::Instant::now();
        match state
            .download_http()
            .get(url)
            .header(reqwest::header::RANGE, "bytes=0-262143")
            .timeout(std::time::Duration::from_secs(15))
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => {
                let latency = start.elapsed().as_millis() as u64;
                if response
                    .headers()
                    .get(reqwest::header::CONTENT_TYPE)
                    .and_then(|value| value.to_str().ok())
                    .is_some_and(|value| value.to_ascii_lowercase().contains("text/html"))
                {
                    return MirrorLatency {
                        mirror: name.into(),
                        latency_ms: Some(latency),
                        bytes_per_second: None,
                        sample_bytes: 0,
                        message: "The mirror returned an HTML page instead of the model file"
                            .into(),
                    };
                }
                let mut stream = response.bytes_stream();
                let mut received = 0u64;
                while let Some(chunk) = stream.next().await {
                    match chunk {
                        Ok(data) => {
                            received += (data.len() as u64).min(262_144 - received);
                            if received >= 262_144 {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
                let elapsed = start.elapsed().as_millis().max(1) as u64;
                MirrorLatency {
                    mirror: name.into(),
                    latency_ms: Some(latency),
                    bytes_per_second: (received > 0)
                        .then_some(received.saturating_mul(1000) / elapsed),
                    sample_bytes: received,
                    message: if received == 0 {
                        "No sample data received".into()
                    } else {
                        String::new()
                    },
                }
            }
            Ok(response) => MirrorLatency {
                mirror: name.into(),
                latency_ms: None,
                bytes_per_second: None,
                sample_bytes: 0,
                message: format!("HTTP {}", response.status().as_u16()),
            },
            Err(_) => MirrorLatency {
                mirror: name.into(),
                latency_ms: None,
                bytes_per_second: None,
                sample_bytes: 0,
                message: "Connection failed or timed out".into(),
            },
        }
    };
    let (a, b) = tokio::join!(probe("hf-mirror"), probe("huggingface"));
    Ok(vec![a, b])
}

#[tauri::command]
pub fn asr_providers_list(state: State<'_, AsrState>) -> Result<Vec<ProviderInfo>, String> {
    providers::list(state.inner())
}

#[tauri::command]
pub fn asr_provider_save(
    state: State<'_, AsrState>,
    provider_id: String,
    fields: HashMap<String, String>,
) -> Result<ProviderInfo, String> {
    providers::save(state.inner(), provider_id.trim(), fields)
}

#[tauri::command]
pub fn asr_provider_clear(
    state: State<'_, AsrState>,
    provider_id: String,
) -> Result<ProviderInfo, String> {
    providers::clear(state.inner(), provider_id.trim())
}

#[tauri::command]
pub async fn asr_provider_test(
    state: State<'_, AsrState>,
    provider_id: String,
) -> Result<ProviderTestResult, String> {
    let provider_id = provider_id.trim();
    let spec = providers::find(provider_id)
        .ok_or_else(|| format!("Unknown ASR provider: {provider_id}"))?;
    let settings = state.settings_snapshot()?;
    let stored = settings
        .providers
        .get(provider_id)
        .cloned()
        .unwrap_or_default();

    if !providers::is_configured(spec, Some(&stored)) {
        return Ok(ProviderTestResult {
            ok: false,
            message: format!(
                "{} is not fully configured. Save all required fields before testing.",
                spec.name
            ),
            latency_ms: 0,
        });
    }

    probe::test(state.inner(), spec, &stored).await
}

/// Select the active ASR backend. Validation happens before persisting.
#[tauri::command]
pub fn asr_set_active(
    state: State<'_, AsrState>,
    mode: String,
    id: String,
) -> Result<AsrSelection, String> {
    match mode.trim() {
        "none" => state.mutate_settings(|settings| {
            settings.active = AsrSelection::none();
            Ok(settings.active.clone())
        }),
        "local" => Err(
            "Local model inference is not connected to live transcription in this build.".into(),
        ),
        "api" => {
            let provider_id = id.trim();
            let spec = providers::find(provider_id)
                .ok_or_else(|| format!("Unknown ASR provider: {provider_id}"))?;
            if provider_id != "local-websocket" {
                return Err(
                    "This provider is not connected to live transcription in this build.".into(),
                );
            }
            state.mutate_settings(|settings| {
                if !providers::is_configured(spec, settings.providers.get(spec.id)) {
                    return Err(format!(
                        "{} is not fully configured. Save valid credentials before activating.",
                        spec.name
                    ));
                }
                settings.active = AsrSelection::api(spec.id);
                Ok(settings.active.clone())
            })
        }
        other => Err(format!(
            "Unknown ASR mode \"{other}\". Expected \"none\", \"local\" or \"api\"."
        )),
    }
}

/// Download one model, awaiting completion while emitting progress events.
#[tauri::command]
pub async fn asr_model_download(
    app: AppHandle,
    state: State<'_, AsrState>,
    model_id: String,
    mirror: String,
) -> Result<(), String> {
    download::download(&app, state.inner(), model_id, mirror).await
}

/// Request cancellation of an in-flight model download. Idempotent.
#[tauri::command]
pub fn asr_model_cancel(state: State<'_, AsrState>, model_id: String) -> Result<(), String> {
    state.cancel_download(model_id.trim())?;
    Ok(())
}

/// Delete a model directory and reset the active selection if it pointed there.
#[tauri::command]
pub async fn asr_model_delete(
    state: State<'_, AsrState>,
    model_id: String,
) -> Result<AsrLocalSnapshot, String> {
    let model = catalog::find(model_id.trim())
        .ok_or_else(|| format!("Unknown local ASR model: {}", model_id.trim()))?;

    if state.is_downloading(model.id) {
        return Err(format!(
            "{} is still downloading. Cancel the download before deleting it.",
            model.name
        ));
    }

    let model_dir = state.models_dir().join(model.id);
    match tokio::fs::remove_dir_all(&model_dir).await {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "Could not delete the model directory {}: {error}",
                model_dir.display()
            ));
        }
    }

    state.mutate_settings(|settings| {
        if settings.active.mode == "local"
            && settings.active.local_model_id.as_deref() == Some(model.id)
        {
            settings.active = AsrSelection::none();
        }
        Ok(())
    })?;

    state.local_snapshot()
}
