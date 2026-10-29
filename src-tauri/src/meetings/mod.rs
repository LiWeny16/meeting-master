//! Local meeting store and capture orchestration.

pub mod commands;
pub mod export;
pub mod store;
pub mod transcript;

pub use store::MeetingsState;

use serde::{Deserialize, Serialize};

pub(crate) const MAX_TITLE_CHARS: usize = 120;
pub(crate) const MEETING_MISSING: &str = "That meeting no longer exists.";

pub(crate) const STATUS_UPCOMING: &str = "upcoming";
pub(crate) const STATUS_IN_PROGRESS: &str = "in-progress";
pub(crate) const STATUS_COMPLETED: &str = "completed";

pub(crate) const CAPTURE_STARTING: &str = "starting";
pub(crate) const CAPTURE_FAILED: &str = "failed";

pub(crate) const INTERRUPTED_CAPTURE_ERROR: &str = "Recording was interrupted when the app closed.";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Meeting {
    pub id: String,
    pub title: String,
    pub agenda: String,
    pub created_at: i64,
    pub started_at: Option<i64>,
    pub ended_at: Option<i64>,
    pub status: String,
    pub recording_dir: Option<String>,
    pub capture_state: Option<String>,
    pub capture_error: Option<String>,
    pub summary: String,
    pub tags: Vec<String>,
    pub participants: u32,
    #[serde(default)]
    pub identity_id: Option<String>,
    #[serde(default)]
    pub actions: Vec<MeetingAction>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MeetingAction {
    pub id: String,
    pub text: String,
    pub owner: Option<String>,
    pub due_date: Option<String>,
    pub completed: bool,
    pub source_segment_ids: Vec<String>,
}

impl Default for MeetingAction {
    fn default() -> Self {
        Self {
            id: String::new(),
            text: String::new(),
            owner: None,
            due_date: None,
            completed: false,
            source_segment_ids: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingCreateInput {
    pub title: String,
    pub agenda: String,
    #[serde(default)]
    pub identity_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSegment {
    pub id: String,
    pub meeting_id: String,
    pub session_id: String,
    pub turn_id: String,
    pub source: crate::audio::types::SourceKind,
    pub text: String,
    pub sequence: u64,
    pub start_frame: u64,
    pub end_frame: u64,
    pub started_at_ms: i64,
    pub ended_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptExport {
    pub path: String,
    pub file_name: String,
    pub segment_count: usize,
    pub bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptPage {
    pub items: Vec<TranscriptSegment>,
    pub total_count: usize,
    pub offset: usize,
    pub has_more: bool,
    pub next_offset: Option<usize>,
}
