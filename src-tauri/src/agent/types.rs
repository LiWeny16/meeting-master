use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentModelInfo {
    pub provider: String,
    pub id: String,
    pub name: String,
    pub api: String,
    pub base_url: String,
    pub has_key: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProviderInfo {
    pub id: String,
    pub name: String,
    pub api: String,
    pub base_url: String,
    pub configured: bool,
    pub has_key: bool,
    pub no_auth: bool,
    pub thinking_effort: Option<String>,
    pub models: Vec<AgentModelInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSettings {
    pub active_provider: Option<String>,
    pub active_model: Option<String>,
    pub providers: Vec<AgentProviderInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    pub status: String,
    pub label: String,
    pub detail: String,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub models: Vec<AgentModelInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentHistoryEntry {
    pub id: String,
    pub role: String,
    pub text: String,
    pub timestamp: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConversation {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConversationList {
    pub conversations: Vec<AgentConversation>,
    pub active_conversation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderTestResult {
    pub ok: bool,
    pub message: String,
    pub latency_ms: u128,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSaveInput {
    pub provider_id: String,
    pub name: String,
    pub api: String,
    pub base_url: String,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub clear_api_key: bool,
    #[serde(default)]
    pub no_auth: bool,
    #[serde(default)]
    pub thinking_effort: Option<String>,
    #[serde(default)]
    pub models: Option<Vec<ProviderModelInput>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProviderModelInput {
    pub id: String,
    pub name: String,
    pub context_window: Option<u32>,
    pub max_tokens: Option<u32>,
}

impl Default for ProviderModelInput {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            context_window: None,
            max_tokens: None,
        }
    }
}

/// Agent events retain the existing frontend contract and carry a meeting ID
/// so a route can ignore late events belonging to another meeting.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum AgentEvent {
    TurnStarted {
        #[serde(skip_serializing_if = "Option::is_none")]
        meeting_id: Option<String>,
    },
    TextDelta {
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        meeting_id: Option<String>,
    },
    ThinkingDelta {
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        meeting_id: Option<String>,
    },
    ContextStatus {
        status: String,
        estimated_tokens: u64,
        context_window: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        summary_tokens: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        meeting_id: Option<String>,
    },
    ToolCallStart {
        call_id: String,
        name: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        input: Option<serde_json::Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        meeting_id: Option<String>,
    },
    ToolCallEnd {
        call_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        output: Option<serde_json::Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        is_error: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        meeting_id: Option<String>,
    },
    PermissionRequest {
        request_id: String,
        tool: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        input: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        meeting_id: Option<String>,
    },
    TurnEnded {
        #[serde(skip_serializing_if = "Option::is_none")]
        meeting_id: Option<String>,
    },
    Done {
        #[serde(skip_serializing_if = "Option::is_none")]
        meeting_id: Option<String>,
    },
    Error {
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        meeting_id: Option<String>,
    },
}
