//! Serializable data transfer objects shared with the frontend.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// One editable credential field on an API provider.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderField {
    pub key: String,
    pub label: String,
    /// `"text"` or `"secret"`.
    pub kind: String,
    pub placeholder: Option<String>,
    pub required: bool,
    pub default_value: Option<String>,
}

/// Frontend-facing description of a provider. Secrets are never included.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    pub id: String,
    pub name: String,
    /// `"cn"` or `"global"`.
    pub region: String,
    pub description: String,
    pub fields: Vec<ProviderField>,
    pub configured: bool,
    pub key_hint: Option<String>,
    pub public_values: HashMap<String, String>,
    pub active: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderTestResult {
    pub ok: bool,
    pub message: String,
    pub latency_ms: u64,
}

/// Replaceable live transcript snapshot for one realtime turn.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptUpdate {
    pub meeting_id: String,
    pub session_id: String,
    pub turn_id: String,
    pub segment_id: String,
    pub source: crate::audio::types::SourceKind,
    /// `partial` or `final`. Partials contain cumulative text and replace by `segment_id`.
    pub kind: String,
    pub text: String,
    pub stable_text: Option<String>,
    pub sequence: u64,
    pub start_frame: u64,
    pub end_frame: u64,
    pub started_at_ms: i64,
    pub ended_at_ms: i64,
}

/// Session/source scoped health for a realtime ASR stream.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AsrStreamStatus {
    pub meeting_id: String,
    pub session_id: String,
    pub source: crate::audio::types::SourceKind,
    /// `connecting`, `streaming`, `stopped`, or `error`.
    pub state: String,
    pub message: Option<String>,
    /// Approximate processing delay from the outbound chunk at server `frameEnd`.
    /// This is not an end-to-end microphone-to-text latency measurement.
    pub latency_ms: Option<u64>,
}

/// Which ASR backend is currently selected.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AsrSelection {
    /// `"none"`, `"local"` or `"api"`.
    pub mode: String,
    pub local_model_id: Option<String>,
    pub api_provider_id: Option<String>,
}

impl Default for AsrSelection {
    fn default() -> Self {
        Self::none()
    }
}

impl AsrSelection {
    pub fn none() -> Self {
        Self {
            mode: "none".to_string(),
            local_model_id: None,
            api_provider_id: None,
        }
    }

    pub fn local(model_id: impl Into<String>) -> Self {
        Self {
            mode: "local".to_string(),
            local_model_id: Some(model_id.into()),
            api_provider_id: None,
        }
    }

    pub fn api(provider_id: impl Into<String>) -> Self {
        Self {
            mode: "api".to_string(),
            local_model_id: None,
            api_provider_id: Some(provider_id.into()),
        }
    }

    pub fn is_none(&self) -> bool {
        self.mode == "none"
    }
}

/// Live progress for one model download.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub model_id: String,
    /// `"downloading"`, `"verifying"`, `"completed"`, `"failed"` or `"cancelled"`.
    pub status: String,
    pub file_index: usize,
    pub file_count: usize,
    pub file_name: String,
    pub downloaded_bytes: u64,
    pub completed_bytes: u64,
    pub total_bytes: u64,
    pub percent: f64,
    pub message: Option<String>,
}

/// Catalog entry enriched with local installation state.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalModelInfo {
    pub id: String,
    pub name: String,
    pub vendor: String,
    pub description: String,
    pub repo: String,
    pub total_bytes: u64,
    pub languages: Vec<String>,
    pub min_vram_bytes: u64,
    /// `"not-installed"`, `"downloading"`, `"installed"` or `"corrupted"`.
    pub status: String,
    pub installed_bytes: u64,
    pub installed_path: Option<String>,
    pub installed_at: Option<i64>,
    pub progress: Option<DownloadProgress>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AsrLocalSnapshot {
    pub models: Vec<LocalModelInfo>,
    pub active: AsrSelection,
    pub storage_dir: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareProfile {
    pub gpu_name: String,
    pub vram_bytes: u64,
    pub total_ram_bytes: u64,
    pub cpu_name: String,
    pub logical_cores: usize,
    /// `"cpu"`, `"entry"`, `"mid"`, `"upper"` or `"high"`.
    pub tier: String,
    pub recommended_model_id: Option<String>,
    pub detection_note: Option<String>,
}
