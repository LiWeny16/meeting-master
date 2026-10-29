//! Secret-safe Tauri commands for the embedded meeting assistant.

use std::sync::Arc;

use tauri::State;

use crate::agent::context::{AgentAttachment, ContextInput, validate_attachments};
use crate::agent::state::AgentState;
use crate::agent::types::{
    AgentConversation, AgentConversationList, AgentHistoryEntry, AgentProviderInfo, AgentSettings,
    AgentStatus, ProviderModelInput, ProviderTestResult,
};
use crate::meetings::MeetingsState;

#[tauri::command]
pub fn agent_status(state: State<'_, Arc<AgentState>>) -> AgentStatus {
    state.status()
}

#[tauri::command]
pub fn agent_get_settings(state: State<'_, Arc<AgentState>>) -> Result<AgentSettings, String> {
    state.settings()
}

#[tauri::command]
pub fn agent_save_provider(
    state: State<'_, Arc<AgentState>>,
    provider_id: String,
    name: String,
    api: String,
    base_url: String,
    api_key: Option<String>,
    clear_api_key: Option<bool>,
    no_auth: Option<bool>,
    thinking_effort: Option<String>,
    models: Option<Vec<ProviderModelInput>>,
) -> Result<AgentProviderInfo, String> {
    state.save_provider(crate::agent::types::ProviderSaveInput {
        provider_id,
        name,
        api,
        base_url,
        api_key,
        clear_api_key: clear_api_key.unwrap_or(false),
        no_auth: no_auth.unwrap_or(false),
        thinking_effort,
        models,
    })
}

#[tauri::command]
pub fn agent_select_model(
    state: State<'_, Arc<AgentState>>,
    provider: String,
    model: String,
) -> Result<AgentStatus, String> {
    state.select(&provider, &model)
}

/// Compatibility alias for older frontends.
#[tauri::command]
pub fn agent_set_model(
    state: State<'_, Arc<AgentState>>,
    provider: String,
    model: String,
) -> Result<AgentStatus, String> {
    state.select(&provider, &model)
}

#[tauri::command]
pub async fn agent_test_provider(
    state: State<'_, Arc<AgentState>>,
    provider_id: String,
) -> Result<ProviderTestResult, String> {
    state.test_provider(&provider_id).await
}

#[tauri::command]
pub async fn agent_discover_models(
    state: State<'_, Arc<AgentState>>,
    provider_id: String,
) -> Result<Vec<crate::agent::types::AgentModelInfo>, String> {
    state.discover_models(&provider_id).await
}

#[tauri::command]
pub fn agent_history_get(
    state: State<'_, Arc<AgentState>>,
    meeting_id: Option<String>,
    conversation_id: Option<String>,
) -> Result<Vec<AgentHistoryEntry>, String> {
    state.history(meeting_id.as_deref(), conversation_id.as_deref())
}

#[tauri::command]
pub fn agent_conversations_list(
    state: State<'_, Arc<AgentState>>,
    meeting_id: Option<String>,
) -> Result<AgentConversationList, String> {
    state.conversations(meeting_id.as_deref())
}

#[tauri::command]
pub fn agent_conversation_create(
    state: State<'_, Arc<AgentState>>,
    meeting_id: Option<String>,
) -> Result<AgentConversation, String> {
    state.create_conversation(meeting_id.as_deref())
}

#[tauri::command]
pub fn agent_conversation_select(
    state: State<'_, Arc<AgentState>>,
    meeting_id: Option<String>,
    conversation_id: String,
) -> Result<(), String> {
    state.select_conversation(meeting_id.as_deref(), &conversation_id)
}

#[tauri::command]
pub async fn agent_send(
    state: State<'_, Arc<AgentState>>,
    meetings: State<'_, MeetingsState>,
    text: String,
    context: Option<ContextInput>,
    conversation_id: Option<String>,
    attachments: Option<Vec<AgentAttachment>>,
) -> Result<(), String> {
    let attachments = attachments.unwrap_or_default();
    validate_attachments(&attachments)?;
    if text.trim().is_empty() && attachments.is_empty() {
        return Err("Type a message before sending.".to_string());
    }
    state
        .run_turn(
            &text,
            context,
            conversation_id,
            attachments,
            meetings.inner(),
        )
        .await
}

#[tauri::command]
pub fn agent_interrupt(state: State<'_, Arc<AgentState>>) -> Result<(), String> {
    state.interrupt()
}

#[tauri::command]
pub fn agent_approve(
    state: State<'_, Arc<AgentState>>,
    request_id: String,
    result: String,
) -> Result<(), String> {
    let allow = match result.trim().to_ascii_lowercase().as_str() {
        "allow" | "approve" | "yes" => true,
        "deny" | "reject" | "no" => false,
        other => return Err(format!("Unknown permission result \"{other}\".")),
    };
    state.approve(&request_id, allow)
}
