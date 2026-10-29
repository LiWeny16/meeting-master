//! Tauri command surface for ASR provider and local model management.

use std::collections::HashMap;

use tauri::{AppHandle, State};

use crate::asr::catalog::{self, InstallState};
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
        "local" => {
            let model_id = id.trim();
            let model = catalog::find(model_id)
                .ok_or_else(|| format!("Unknown local ASR model: {model_id}"))?;
            let model_dir = state.models_dir().join(model.id);
            let inspection = catalog::inspect(&model_dir, model);
            if inspection.state != InstallState::Installed {
                return Err(format!(
                    "{} is not installed. Download it before activating.",
                    model.name
                ));
            }
            state.mutate_settings(|settings| {
                settings.active = AsrSelection::local(model.id);
                Ok(settings.active.clone())
            })
        }
        "api" => {
            let provider_id = id.trim();
            let spec = providers::find(provider_id)
                .ok_or_else(|| format!("Unknown ASR provider: {provider_id}"))?;
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
