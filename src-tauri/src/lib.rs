use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use tauri::Manager;

pub mod agent;
pub mod asr;
pub mod audio;
pub mod meetings;
pub mod paths;

use audio::commands::TauriEventSink;
use audio::coordinator::AudioCoordinator;
use audio::types::AudioEventSink;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppRuntimeStatus {
    platform: &'static str,
    architecture: &'static str,
    build_profile: &'static str,
    cdp_enabled: bool,
}

#[tauri::command]
fn app_runtime_status() -> AppRuntimeStatus {
    AppRuntimeStatus {
        platform: std::env::consts::OS,
        architecture: std::env::consts::ARCH,
        build_profile: if cfg!(debug_assertions) {
            "development"
        } else {
            "release"
        },
        cdp_enabled: cfg!(debug_assertions)
            && std::env::var_os("MEETING_MASTER_CDP_PORT").is_some(),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Recordings live with the product, not in a hidden roaming profile.
            let data_root = paths::data_root(app.handle())
                .map_err(|error| -> Box<dyn std::error::Error> { error.into() })?;
            paths::migrate_legacy_data(app.handle(), &data_root)
                .map_err(|error| -> Box<dyn std::error::Error> { error.into() })?;
            let output_root: PathBuf = data_root.join("recordings");
            let sink = Arc::new(TauriEventSink::new(app.handle().clone()));
            app.manage(Arc::clone(&sink));
            let audio_sink: Arc<dyn AudioEventSink> = sink;
            app.manage(Arc::new(AudioCoordinator::new(audio_sink, output_root)));

            let meetings_state = meetings::MeetingsState::new(app.handle())
                .map_err(|error| -> Box<dyn std::error::Error> { error.into() })?;
            app.manage(meetings_state);

            let asr_state = asr::AsrState::new(app.handle())
                .map_err(|error| -> Box<dyn std::error::Error> { error.into() })?;
            app.manage(asr_state);

            let agent_state = agent::AgentState::new(app.handle())
                .map_err(|error| -> Box<dyn std::error::Error> { error.into() })?;
            app.manage(agent_state);

            if let Some(window) = app.get_webview_window("main") {
                // Windows reports a caption frame offset while the window is hidden,
                // so sizing before show makes it taller than requested. Show first,
                // then size and center; the compositor presents only the final frame.
                let _ = window.show();
                let monitor = window
                    .current_monitor()
                    .ok()
                    .flatten()
                    .or_else(|| window.primary_monitor().ok().flatten());
                if let Some(monitor) = monitor {
                    let scale = monitor.scale_factor();
                    let logical = monitor.size().to_logical::<f64>(scale);
                    let work_area = monitor.work_area().size.to_logical::<f64>(scale);
                    let width = (logical.width * 0.9).clamp(900.0, 1280.0);
                    let height = (logical.height * 0.9)
                        .min(work_area.height - 24.0)
                        .clamp(540.0, 820.0);
                    let _ = window.set_size(tauri::LogicalSize::new(width, height));
                    let _ = window.center();
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_runtime_status,
            audio::commands::audio_devices_list,
            audio::commands::audio_capture_status,
            audio::commands::asr_stream_statuses,
            audio::commands::audio_capture_start,
            audio::commands::audio_capture_stop,
            meetings::commands::meetings_list,
            meetings::commands::meetings_get,
            meetings::commands::meetings_create,
            meetings::commands::meetings_start,
            meetings::commands::meetings_finish,
            meetings::commands::meetings_delete,
            meetings::commands::meetings_rename,
            meetings::commands::meetings_summary_clear,
            meetings::commands::meetings_transcript_export,
            meetings::commands::reveal_in_explorer,
            meetings::commands::meetings_transcript_list,
            meetings::commands::meetings_transcript_search,
            asr::commands::asr_hardware_profile,
            asr::commands::asr_local_models,
            asr::commands::asr_providers_list,
            asr::commands::asr_provider_save,
            asr::commands::asr_provider_clear,
            asr::commands::asr_provider_test,
            asr::commands::asr_set_active,
            asr::commands::asr_model_download,
            asr::commands::asr_model_cancel,
            asr::commands::asr_model_delete,
            agent::commands::agent_status,
            agent::commands::agent_get_settings,
            agent::commands::agent_save_provider,
            agent::commands::agent_select_model,
            agent::commands::agent_set_model,
            agent::commands::agent_test_provider,
            agent::commands::agent_discover_models,
            agent::commands::agent_conversations_list,
            agent::commands::agent_conversation_create,
            agent::commands::agent_conversation_select,
            agent::commands::agent_history_get,
            agent::commands::agent_send,
            agent::commands::agent_interrupt,
            agent::commands::agent_approve
        ])
        .run(tauri::generate_context!())
        .expect("error while building Meeting Master");
}
