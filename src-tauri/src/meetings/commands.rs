use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::{AppHandle, State};

use crate::asr::realtime;
use crate::asr::state::AsrState;
use crate::audio::coordinator::AudioCoordinator;
use crate::audio::types::{CaptureStartRequest, CaptureStatus, SessionState};

use super::store::MeetingsState;
use super::{
    MAX_TITLE_CHARS, Meeting, MeetingCreateInput, STATUS_IN_PROGRESS, TranscriptExport,
    TranscriptPage,
};

const MAX_CAPTURE_SECONDS: u64 = 4 * 60 * 60;

#[tauri::command]
pub fn meetings_list(state: State<'_, MeetingsState>) -> Result<Vec<Meeting>, String> {
    state.list()
}

#[tauri::command]
pub fn meetings_get(
    state: State<'_, MeetingsState>,
    id: String,
) -> Result<Option<Meeting>, String> {
    state.get(&id)
}

#[tauri::command]
pub fn meetings_create(
    state: State<'_, MeetingsState>,
    input: MeetingCreateInput,
) -> Result<Meeting, String> {
    state.create(input)
}

#[tauri::command(rename_all = "camelCase")]
pub fn meetings_transcript_list(
    state: State<'_, MeetingsState>,
    meeting_id: String,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<TranscriptPage, String> {
    state.transcript_list(&meeting_id, offset.unwrap_or(0), limit.unwrap_or(0))
}

#[tauri::command(rename_all = "camelCase")]
pub fn meetings_transcript_search(
    state: State<'_, MeetingsState>,
    query: String,
    meeting_id: Option<String>,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<TranscriptPage, String> {
    state.transcript_search(
        &query,
        meeting_id.as_deref(),
        offset.unwrap_or(0),
        limit.unwrap_or(0),
    )
}

/// Deletes a finished meeting and its local recording directory.
///
/// Refuses while the meeting is still recording: destroying an open capture
/// would leave the audio pipeline writing into a missing directory.
#[tauri::command]
pub fn meetings_delete(
    app: AppHandle,
    state: State<'_, MeetingsState>,
    id: String,
) -> Result<String, String> {
    let existing = state
        .get(&id)?
        .ok_or_else(|| "That meeting no longer exists.".to_string())?;
    if existing.status == STATUS_IN_PROGRESS {
        return Err("End the meeting before deleting it.".to_string());
    }
    let removed = state
        .remove(&id)?
        .ok_or_else(|| "That meeting no longer exists.".to_string())?;
    // Deleting means deleting: audio + transcript.jsonl (+ anything else the
    // capture wrote) go with the record. Fall back to the canonical folder when
    // the meeting never finished capturing and has no recorded path.
    let mut targets: Vec<PathBuf> = removed
        .recording_dir
        .as_deref()
        .map(|dir| vec![PathBuf::from(dir)])
        .unwrap_or_default();
    if let Ok(root) = meeting_recordings_dir(&app) {
        targets.push(root.join(&removed.id));
    }
    for path in targets {
        let path = Path::new(&path);
        if path.is_dir() {
            std::fs::remove_dir_all(path).map_err(|error| {
                format!(
                    "The meeting was removed, but {} could not be deleted: {error}",
                    path.display()
                )
            })?;
        }
    }
    Ok(removed.id)
}

#[tauri::command]
pub fn meetings_rename(
    state: State<'_, MeetingsState>,
    id: String,
    title: String,
) -> Result<Meeting, String> {
    let title = valid_title(&title)?;
    state.rename(&id, title)
}

#[tauri::command]
pub fn meetings_summary_clear(
    state: State<'_, MeetingsState>,
    id: String,
) -> Result<Meeting, String> {
    state.clear_summary(&id)
}

#[tauri::command]
pub fn meetings_transcript_export(
    state: State<'_, MeetingsState>,
    id: String,
) -> Result<TranscriptExport, String> {
    state.export_transcript(&id)
}

#[tauri::command]
pub fn reveal_in_explorer(app: AppHandle, path: String) -> Result<(), String> {
    let data_root = crate::paths::data_root(&app)?;
    super::export::reveal(&path, &data_root)
}

#[tauri::command]
pub async fn meetings_start(
    app: AppHandle,
    state: State<'_, MeetingsState>,
    asr: State<'_, AsrState>,
    audio: State<'_, Arc<AudioCoordinator>>,
    id: String,
) -> Result<Meeting, String> {
    let output_dir = meeting_recordings_dir(&app)?.join(&id);
    state.begin_start(&id)?;

    let request = CaptureStartRequest {
        output_dir: Some(output_dir.to_string_lossy().into_owned()),
        max_seconds: Some(MAX_CAPTURE_SECONDS),
        ..CaptureStartRequest::default()
    };
    let (realtime_config, asr_unavailable) = match realtime::active_stream_config(asr.inner()) {
        Ok(config) => (Some(config), None),
        Err(message) => (None, Some(message)),
    };
    let coordinator = Arc::clone(audio.inner());
    let start_meeting_id = id.clone();
    let started = tauri::async_runtime::spawn_blocking(move || {
        coordinator.start_meeting(request, start_meeting_id, realtime_config, asr_unavailable)
    })
    .await;

    match started {
        Ok(Ok(status)) => {
            let capture_state = capture_state_label(status.state);
            state.confirm_start(&id, capture_state, status.output_dir)
        }
        Ok(Err(error)) => {
            let message = error.to_message();
            let _ = state.fail_start(&id, message.clone());
            Err(message)
        }
        Err(error) => {
            let message = error.to_string();
            let _ = state.fail_start(&id, message.clone());
            Err(message)
        }
    }
}

#[tauri::command]
pub async fn meetings_finish(
    state: State<'_, MeetingsState>,
    audio: State<'_, Arc<AudioCoordinator>>,
    id: String,
) -> Result<Meeting, String> {
    let meeting = state
        .get(&id)?
        .ok_or_else(|| "Meeting not found.".to_string())?;
    if meeting.status.as_str() != STATUS_IN_PROGRESS {
        return Ok(meeting);
    }

    let initial = audio.status();
    let mut final_status: Option<CaptureStatus> = None;
    let mut capture_error: Option<String> = None;

    if matches!(
        initial.state,
        SessionState::Starting | SessionState::Recording | SessionState::Stopping
    ) {
        let coordinator = Arc::clone(audio.inner());
        match tauri::async_runtime::spawn_blocking(move || coordinator.stop()).await {
            Ok(Ok(status)) => final_status = Some(status),
            Ok(Err(error)) => capture_error = Some(error.to_message()),
            Err(error) => capture_error = Some(error.to_string()),
        }
    } else {
        final_status = Some(initial);
    }

    let capture_state = final_status
        .as_ref()
        .map(|status| capture_state_label(status.state));
    let recording_dir = final_status.and_then(|status| status.output_dir);
    state.complete(&id, capture_state, recording_dir, capture_error)
}

fn meeting_recordings_dir(app: &AppHandle) -> Result<PathBuf, String> {
    crate::paths::data_root(app).map(|root| root.join("recordings").join("meetings"))
}

fn capture_state_label(state: SessionState) -> String {
    format!("{state:?}").to_ascii_lowercase()
}

fn valid_title(raw: &str) -> Result<String, String> {
    let title = raw.trim();
    if title.is_empty() {
        return Err("Enter a title.".to_string());
    }
    if title.chars().count() > MAX_TITLE_CHARS {
        return Err(format!(
            "Titles are limited to {MAX_TITLE_CHARS} characters."
        ));
    }
    Ok(title.to_string())
}
