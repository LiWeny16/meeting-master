use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter, State};

use crate::asr::types::{AsrStreamStatus, TranscriptUpdate};
use crate::audio::coordinator::AudioCoordinator;
use crate::audio::devices;
use crate::audio::types::{
    AudioDeviceInfo, AudioEventSink, CaptureLevel, CaptureStartRequest, CaptureStatus, SourceKind,
};

#[derive(Default)]
struct AsrStatusCache {
    session_id: Option<String>,
    sources: HashMap<SourceKind, AsrStreamStatus>,
}

impl AsrStatusCache {
    fn record(&mut self, status: AsrStreamStatus) {
        if self
            .session_id
            .as_ref()
            .is_none_or(|session| status.session_id > *session)
        {
            self.session_id = Some(status.session_id.clone());
            self.sources.clear();
        }
        if self.session_id.as_deref() == Some(status.session_id.as_str()) {
            self.sources.insert(status.source, status);
        }
    }

    fn for_meeting(&self, meeting_id: &str) -> Vec<AsrStreamStatus> {
        self.sources
            .values()
            .filter(|status| status.meeting_id == meeting_id)
            .cloned()
            .collect()
    }
}

pub struct TauriEventSink {
    app: AppHandle,
    asr_status: Mutex<AsrStatusCache>,
}

impl TauriEventSink {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            asr_status: Mutex::new(AsrStatusCache::default()),
        }
    }
}

impl AudioEventSink for TauriEventSink {
    fn emit_level(&self, level: CaptureLevel) {
        let _ = self.app.emit("audio-level", &level);
    }

    fn emit_status(&self, status: CaptureStatus) {
        let _ = self.app.emit("audio-status", &status);
    }

    fn emit_transcript_update(&self, update: TranscriptUpdate) {
        let _ = self.app.emit("transcript-update", &update);
    }

    fn emit_asr_stream_status(&self, status: AsrStreamStatus) {
        if let Ok(mut saved) = self.asr_status.lock() {
            saved.record(status.clone());
        }
        let _ = self.app.emit("asr-stream-status", &status);
    }
}

#[tauri::command]
pub fn asr_stream_statuses(
    state: State<'_, Arc<TauriEventSink>>,
    meeting_id: String,
) -> Vec<AsrStreamStatus> {
    state
        .asr_status
        .lock()
        .map(|saved| saved.for_meeting(&meeting_id))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn late_subscriber_can_read_errors_without_cross_session_leakage() {
        let mut cache = AsrStatusCache::default();
        let status = |meeting: &str, session: &str, state: &str| AsrStreamStatus {
            meeting_id: meeting.into(),
            session_id: session.into(),
            source: SourceKind::Microphone,
            state: state.into(),
            message: (state == "error").then(|| "stream failed".into()),
            latency_ms: None,
        };
        cache.record(status("first", "session-100", "error"));
        assert_eq!(cache.for_meeting("first")[0].state, "error");
        cache.record(status("second", "session-200", "connecting"));
        cache.record(status("first", "session-100", "stopped"));
        assert!(cache.for_meeting("first").is_empty());
        assert_eq!(cache.for_meeting("second")[0].state, "connecting");
    }
}

#[tauri::command]
pub async fn audio_devices_list() -> Result<Vec<AudioDeviceInfo>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        devices::list_devices().map_err(|error| error.to_message())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn audio_capture_status(state: State<'_, Arc<AudioCoordinator>>) -> CaptureStatus {
    state.status()
}

#[tauri::command]
pub async fn audio_capture_start(
    state: State<'_, Arc<AudioCoordinator>>,
    request: CaptureStartRequest,
) -> Result<CaptureStatus, String> {
    let coordinator = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        coordinator
            .start(request)
            .map_err(|error| error.to_message())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn audio_capture_stop(
    state: State<'_, Arc<AudioCoordinator>>,
) -> Result<CaptureStatus, String> {
    let coordinator = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        coordinator.stop().map_err(|error| error.to_message())
    })
    .await
    .map_err(|error| error.to_string())?
}
