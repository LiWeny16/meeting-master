//! BYOK meeting-agent settings, durable per-meeting history, and sidecar turns.

use std::collections::HashMap;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::process::Command as StdCommand;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use reqwest::header::HeaderValue;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, Command};
use tokio::sync::{Mutex as AsyncMutex, mpsc, oneshot};
use tokio::time::Instant as TokioInstant;

use crate::agent::context::{self, ContextInput};
use crate::agent::types::{
    AgentConversation, AgentConversationList, AgentEvent, AgentHistoryEntry, AgentModelInfo,
    AgentProviderInfo, AgentSettings, AgentStatus, ProviderModelInput, ProviderSaveInput,
    ProviderTestResult,
};
use crate::asr::crypto;
use crate::audio::types::ASR_SAMPLE_RATE;
use crate::meetings::{MeetingAction, MeetingsState, TranscriptPage, TranscriptSegment};

const LOCAL_PROVIDER_ID: &str = "onion-3080";
const LOCAL_MODEL_ID: &str = "/home/onion/ai/bonsai/Ternary-Bonsai-2-27B-PQ2_0.gguf";
const LOCAL_BASE_URL: &str = "http://192.168.0.200:8080/v1";
const LOCAL_CONTEXT_WINDOW: u32 = 4096;
const LOCAL_MAX_TOKENS: u32 = 512;
const TURN_IDLE_TIMEOUT: Duration = Duration::from_secs(90);
const TURN_MAX_DURATION: Duration = Duration::from_secs(600);
const APPROVAL_TIMEOUT: Duration = Duration::from_secs(120);
const APPROVED_APIS: &[&str] = &[
    "openai-completions",
    "openai-responses",
    "anthropic-messages",
    "google-generative-ai",
    "mistral-conversations",
];

#[derive(Clone, Copy)]
struct ToolBudget {
    page_items: u64,
    text_chars: usize,
    summary_chars: usize,
    agenda_chars: usize,
    action_items: usize,
    action_chars: usize,
    action_sources: usize,
}

impl ToolBudget {
    fn for_model(context_window: u32, max_tokens: u32) -> Self {
        let available = context_window.saturating_sub(max_tokens);
        if context_window >= 65_536 && available >= 32_768 {
            let chars = (available as usize / 64).clamp(500, 4_000);
            Self {
                page_items: if available >= 300_000 { 30 } else { 12 },
                text_chars: chars,
                summary_chars: chars,
                agenda_chars: chars,
                action_items: 8,
                action_chars: 500,
                action_sources: 30,
            }
        } else {
            Self {
                page_items: 8,
                text_chars: 500,
                summary_chars: 400,
                agenda_chars: 180,
                action_items: 4,
                action_chars: 100,
                action_sources: 4,
            }
        }
    }
}

fn idle_deadline(now: TokioInstant, hard_deadline: TokioInstant) -> TokioInstant {
    (now + TURN_IDLE_TIMEOUT).min(hard_deadline)
}

fn turn_timeout_message(now: TokioInstant, hard_deadline: TokioInstant) -> &'static str {
    if now >= hard_deadline {
        "The meeting assistant reached the maximum turn duration. Ask about a smaller part of the meeting."
    } else {
        "The meeting assistant stopped responding for 90 seconds. Please try again."
    }
}

fn is_turn_progress(record: &Value, request_id: &str) -> bool {
    record.get("requestId").and_then(Value::as_str) == Some(request_id)
        && matches!(
            record.get("type").and_then(Value::as_str),
            Some("event" | "tool_request" | "history" | "error" | "done")
        )
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct StoredSettings {
    active_provider: Option<String>,
    active_model: Option<String>,
    providers: HashMap<String, StoredProvider>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct StoredProvider {
    id: String,
    name: String,
    api: String,
    base_url: String,
    encrypted_api_key: Option<String>,
    no_auth: bool,
    thinking_effort: Option<String>,
    models: Vec<StoredModel>,
}

impl Default for StoredProvider {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            api: "openai-completions".to_string(),
            base_url: String::new(),
            encrypted_api_key: None,
            no_auth: false,
            thinking_effort: None,
            models: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct StoredModel {
    id: String,
    name: String,
    context_window: u32,
    max_tokens: u32,
}

impl Default for StoredModel {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            context_window: 8192,
            max_tokens: 1024,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct StoredConversationFile {
    scope_key: String,
    active_conversation_id: Option<String>,
    conversations: Vec<StoredConversation>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct StoredConversation {
    id: String,
    title: String,
    created_at: i64,
    updated_at: i64,
    messages: Vec<Value>,
    // Raw model history is scoped to the meeting that produced it. Legacy
    // unscoped messages remain on disk for recovery, but are not sent again.
    messages_by_scope: HashMap<String, Vec<Value>>,
    visible_history: Vec<AgentHistoryEntry>,
}

impl StoredConversation {
    fn messages_for_context(&self, meeting_id: Option<&str>) -> Vec<Value> {
        self.messages_by_scope
            .get(&model_history_scope(meeting_id))
            .cloned()
            .unwrap_or_default()
    }
}

fn model_history_scope(meeting_id: Option<&str>) -> String {
    meeting_id.map_or_else(|| "general".to_string(), |id| format!("meeting:{id}"))
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct LegacyStoredSession {
    meeting_id: String,
    messages: Vec<Value>,
    visible_history: Vec<AgentHistoryEntry>,
}

struct RuntimePaths {
    root: Option<PathBuf>,
    node: Option<PathBuf>,
    host: Option<PathBuf>,
    error: Option<String>,
}

enum TurnControl {
    Abort,
}

/// One serialized sidecar turn at a time; request IDs and meeting IDs are
/// attached to every event so a route can safely discard stale events.
pub struct AgentState {
    app: AppHandle,
    settings_path: PathBuf,
    sessions_dir: PathBuf,
    runtime: RuntimePaths,
    http: reqwest::Client,
    settings: Mutex<StoredSettings>,
    turn: AsyncMutex<()>,
    active_control: Mutex<Option<(String, mpsc::UnboundedSender<TurnControl>)>>,
    approvals: Mutex<HashMap<String, (String, oneshot::Sender<bool>)>>,
}

impl AgentState {
    pub fn new(app: &AppHandle) -> Result<Arc<Self>, String> {
        let app_data = app.path().app_data_dir().map_err(|error| {
            format!("Could not resolve the application data directory: {error}")
        })?;
        let data_dir = app_data.join("agent");
        let sessions_dir = data_dir.join("sessions");
        fs::create_dir_all(&sessions_dir).map_err(|error| {
            format!(
                "Could not create the meeting-agent data directory {}: {error}",
                data_dir.display()
            )
        })?;
        let settings_path = data_dir.join("settings.json");
        let mut settings = load_settings(&settings_path)?;
        if !settings.providers.contains_key(LOCAL_PROVIDER_ID) {
            settings
                .providers
                .insert(LOCAL_PROVIDER_ID.to_string(), local_preset());
            persist_settings(&settings_path, &settings)?;
        }
        let runtime = runtime_paths(app);
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(8))
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|error| format!("Could not create the meeting-agent HTTP client: {error}"))?;
        Ok(Arc::new(Self {
            app: app.clone(),
            settings_path,
            sessions_dir,
            runtime,
            http,
            settings: Mutex::new(settings),
            turn: AsyncMutex::new(()),
            active_control: Mutex::new(None),
            approvals: Mutex::new(HashMap::new()),
        }))
    }

    pub fn status(&self) -> AgentStatus {
        let settings = match self.settings_snapshot() {
            Ok(settings) => settings,
            Err(error) => return unavailable_status(error),
        };
        let models = flatten_models(&settings);
        let selected = settings
            .active_provider
            .as_deref()
            .and_then(|provider_id| settings.providers.get(provider_id))
            .and_then(|provider| {
                settings
                    .active_model
                    .as_deref()
                    .and_then(|model_id| provider.models.iter().find(|model| model.id == model_id))
                    .map(|model| (provider, model))
            });

        let Some((provider, model)) = selected else {
            return AgentStatus {
                status: "unavailable".to_string(),
                label: "Choose an assistant model".to_string(),
                detail: "Add or select a provider and model in assistant settings.".to_string(),
                provider: settings.active_provider,
                model: settings.active_model,
                models,
            };
        };
        let has_key = match self.provider_has_key(provider) {
            Ok(has_key) => has_key,
            Err(error) => return unavailable_status(error),
        };
        if !provider_configured(provider, has_key) {
            return AgentStatus {
                status: "unavailable".to_string(),
                label: "Provider setup is incomplete".to_string(),
                detail: format!(
                    "Add a key for {} or mark a local endpoint as keyless.",
                    provider.name
                ),
                provider: Some(provider.id.clone()),
                model: Some(model.id.clone()),
                models,
            };
        }
        if let Some(error) = self.runtime.error.as_ref() {
            return AgentStatus {
                status: "error".to_string(),
                label: "Meeting agent runtime unavailable".to_string(),
                detail: error.clone(),
                provider: Some(provider.id.clone()),
                model: Some(model.id.clone()),
                models,
            };
        }
        AgentStatus {
            status: "available".to_string(),
            label: "Meeting assistant ready".to_string(),
            detail: format!(
                "{} is configured. Test the provider in settings to check its connection.",
                model.name
            ),
            provider: Some(provider.id.clone()),
            model: Some(model.id.clone()),
            models,
        }
    }

    pub fn settings(&self) -> Result<AgentSettings, String> {
        let settings = self.settings_snapshot()?;
        let mut providers = settings
            .providers
            .values()
            .map(|provider| self.provider_info(provider))
            .collect::<Result<Vec<_>, _>>()?;
        providers.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
        Ok(AgentSettings {
            active_provider: settings.active_provider,
            active_model: settings.active_model,
            providers,
        })
    }

    pub fn save_provider(&self, input: ProviderSaveInput) -> Result<AgentProviderInfo, String> {
        let id = input.provider_id.trim();
        if !valid_provider_id(id) {
            return Err(
                "Provider IDs can contain only letters, numbers, dots, underscores, and hyphens."
                    .to_string(),
            );
        }
        let api = input.api.trim();
        if !APPROVED_APIS.contains(&api) {
            return Err(format!("Unsupported model API: {api}"));
        }
        let base_url = input.base_url.trim().trim_end_matches('/');
        let parsed = reqwest::Url::parse(base_url)
            .map_err(|_| "Enter a valid provider base URL.".to_string())?;
        if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
            return Err(
                "Provider base URLs must use HTTP or HTTPS and include a host.".to_string(),
            );
        }
        let name = input.name.trim();
        if name.is_empty() || name.len() > 100 {
            return Err("Provider names must contain between 1 and 100 characters.".to_string());
        }
        let mut settings = lock(&self.settings, "settings");
        let mut provider = settings
            .providers
            .get(id)
            .cloned()
            .unwrap_or_else(|| StoredProvider {
                id: id.to_string(),
                ..StoredProvider::default()
            });
        provider.id = id.to_string();
        provider.name = name.to_string();
        provider.api = api.to_string();
        provider.base_url = base_url.to_string();
        provider.no_auth = input.no_auth;
        if let Some(effort) = input.thinking_effort.as_deref() {
            if !matches!(effort, "off" | "low" | "high" | "max") {
                return Err("Unsupported thinking level.".to_string());
            }
            provider.thinking_effort = Some(effort.to_string());
        }
        if input.clear_api_key {
            provider.encrypted_api_key = None;
        } else if let Some(key) = input
            .api_key
            .as_deref()
            .map(str::trim)
            .filter(|key| !key.is_empty())
        {
            provider.encrypted_api_key = Some(crypto::protect(key)?);
        }
        if let Some(models) = input.models {
            let previous = provider.models.clone();
            provider.models = normalize_models(merge_model_metadata(models, &previous))?;
        }
        settings.providers.insert(id.to_string(), provider.clone());
        persist_settings(&self.settings_path, &settings)?;
        self.provider_info(&provider)
    }

    pub fn select(&self, provider_id: &str, model_id: &str) -> Result<AgentStatus, String> {
        let mut settings = lock(&self.settings, "settings");
        let provider_id = provider_id.trim();
        let model_id = model_id.trim();
        let provider = settings
            .providers
            .get(provider_id)
            .ok_or_else(|| format!("Unknown assistant provider: {provider_id}"))?;
        let model = provider
            .models
            .iter()
            .find(|model| model.id == model_id)
            .ok_or_else(|| format!("Unknown assistant model: {provider_id}/{model_id}"))?;
        let has_key = provider.encrypted_api_key.is_some();
        if !provider_configured(provider, has_key) {
            return Err(format!(
                "{} is not fully configured. Add an API key or mark the endpoint as keyless.",
                provider.name
            ));
        }
        let _ = model;
        settings.active_provider = Some(provider_id.to_string());
        settings.active_model = Some(model_id.to_string());
        persist_settings(&self.settings_path, &settings)?;
        drop(settings);
        Ok(self.status())
    }

    pub async fn discover_models(&self, provider_id: &str) -> Result<Vec<AgentModelInfo>, String> {
        let provider_id = provider_id.trim();
        let settings = self.settings_snapshot()?;
        let provider = settings
            .providers
            .get(provider_id)
            .ok_or_else(|| format!("Unknown assistant provider: {provider_id}"))?;
        let api_key = self.api_key(provider)?;
        if !provider.no_auth && api_key.is_none() {
            return Err(format!(
                "Add an API key for {} before discovering models.",
                provider.name
            ));
        }
        let response = self.fetch_catalog(provider, api_key.as_deref()).await?;
        let mut updated = self.settings_snapshot()?;
        let saved = updated
            .providers
            .get_mut(provider_id)
            .ok_or_else(|| format!("Unknown assistant provider: {provider_id}"))?;
        let previous = saved.models.clone();
        saved.models = normalize_models(merge_model_metadata(response, &previous))?;
        let result = saved
            .models
            .iter()
            .map(|model| model_info(saved, model, api_key.is_some()))
            .collect();
        persist_settings(&self.settings_path, &updated)?;
        *lock(&self.settings, "settings") = updated;
        Ok(result)
    }

    pub async fn test_provider(&self, provider_id: &str) -> Result<ProviderTestResult, String> {
        let settings = self.settings_snapshot()?;
        let provider = settings
            .providers
            .get(provider_id.trim())
            .ok_or_else(|| format!("Unknown assistant provider: {}", provider_id.trim()))?;
        let has_key = provider.encrypted_api_key.is_some();
        if !provider_configured(provider, has_key) {
            return Ok(ProviderTestResult {
                ok: false,
                message: format!(
                    "{} needs a base URL, model, and required API key before it can be tested.",
                    provider.name
                ),
                latency_ms: 0,
            });
        }
        let api_key = self.api_key(provider)?;
        let started = Instant::now();
        match self.fetch_catalog(provider, api_key.as_deref()).await {
            Ok(models) => Ok(ProviderTestResult {
                ok: true,
                message: format!(
                    "Connected to {}. The provider reported {} model(s).",
                    provider.name,
                    models.len()
                ),
                latency_ms: started.elapsed().as_millis(),
            }),
            Err(error) => Ok(ProviderTestResult {
                ok: false,
                message: error,
                latency_ms: started.elapsed().as_millis(),
            }),
        }
    }

    pub fn conversations(&self, meeting_id: Option<&str>) -> Result<AgentConversationList, String> {
        let scope_key = meeting_id.unwrap_or("__global__");
        let stored = self.load_conversation_file(scope_key)?;
        let mut conversations = stored
            .conversations
            .iter()
            .map(public_conversation)
            .collect::<Vec<_>>();
        conversations.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
        Ok(AgentConversationList {
            conversations,
            active_conversation_id: stored.active_conversation_id,
        })
    }

    pub fn create_conversation(
        &self,
        meeting_id: Option<&str>,
    ) -> Result<AgentConversation, String> {
        let scope_key = meeting_id.unwrap_or("__global__");
        let mut stored = self.load_conversation_file(scope_key)?;
        let now = now_ms() as i64;
        let conversation = StoredConversation {
            id: uuid::Uuid::new_v4().to_string(),
            title: String::new(),
            created_at: now,
            updated_at: now,
            ..StoredConversation::default()
        };
        stored.active_conversation_id = Some(conversation.id.clone());
        stored.conversations.push(conversation.clone());
        self.save_conversation_file(scope_key, &stored)?;
        Ok(public_conversation(&conversation))
    }

    pub fn select_conversation(
        &self,
        meeting_id: Option<&str>,
        conversation_id: &str,
    ) -> Result<(), String> {
        let scope_key = meeting_id.unwrap_or("__global__");
        let mut stored = self.load_conversation_file(scope_key)?;
        if !stored
            .conversations
            .iter()
            .any(|item| item.id == conversation_id)
        {
            return Err(
                "That assistant conversation could not be found in this scope.".to_string(),
            );
        }
        stored.active_conversation_id = Some(conversation_id.to_string());
        self.save_conversation_file(scope_key, &stored)
    }

    pub fn history(
        &self,
        meeting_id: Option<&str>,
        conversation_id: Option<&str>,
    ) -> Result<Vec<AgentHistoryEntry>, String> {
        let scope_key = meeting_id.unwrap_or("__global__");
        let stored = self.load_conversation_file(scope_key)?;
        if stored.conversations.is_empty() {
            return Ok(Vec::new());
        }
        let target_id = conversation_id
            .or(stored.active_conversation_id.as_deref())
            .unwrap_or(&stored.conversations[0].id);
        stored
            .conversations
            .iter()
            .find(|item| item.id == target_id)
            .map(|item| item.visible_history.clone())
            .ok_or_else(|| {
                "That assistant conversation could not be found in this scope.".to_string()
            })
    }

    pub fn interrupt(&self) -> Result<(), String> {
        let active = lock(&self.active_control, "active turn");
        let Some((_, sender)) = active.as_ref() else {
            return Err("No meeting assistant turn is running.".to_string());
        };
        sender
            .send(TurnControl::Abort)
            .map_err(|_| "The meeting assistant turn has already ended.".to_string())
    }

    pub fn approve(&self, request_id: &str, allow: bool) -> Result<(), String> {
        let request_id = request_id.trim();
        let (turn_id, sender) = lock(&self.approvals, "permission requests")
            .remove(request_id)
            .ok_or_else(|| "That approval request is no longer active.".to_string())?;
        let _ = turn_id;
        sender
            .send(allow)
            .map_err(|_| "The meeting assistant turn has already ended.".to_string())
    }

    pub async fn run_turn(
        &self,
        text: &str,
        context: Option<ContextInput>,
        conversation_id: Option<String>,
        attachments: Vec<context::AgentAttachment>,
        meetings: &MeetingsState,
    ) -> Result<(), String> {
        let _turn_guard = self.turn.lock().await;
        let meeting_id = context.as_ref().and_then(|ctx| ctx.meeting_id.clone());
        if let Some(id) = meeting_id.as_deref() {
            if meetings.get(id)?.is_none() {
                return Err("The selected meeting could not be found.".to_string());
            }
        }
        let settings = self.settings_snapshot()?;
        let provider_id = settings.active_provider.as_deref().ok_or_else(|| {
            "Choose an assistant model in settings before sending a message.".to_string()
        })?;
        let provider = settings
            .providers
            .get(provider_id)
            .ok_or_else(|| "The selected assistant provider no longer exists.".to_string())?;
        let model_id = settings.active_model.as_deref().ok_or_else(|| {
            "Choose an assistant model in settings before sending a message.".to_string()
        })?;
        let model = provider
            .models
            .iter()
            .find(|model| model.id == model_id)
            .ok_or_else(|| "The selected model is not in the provider's model list.".to_string())?;
        let tool_budget = ToolBudget::for_model(model.context_window, model.max_tokens);
        let api_key = self.api_key(provider)?;
        if !provider_configured(provider, api_key.is_some()) {
            return Err("The selected assistant provider is not fully configured.".to_string());
        }
        let runtime_root = self
            .runtime
            .root
            .as_ref()
            .ok_or_else(|| self.runtime.error.clone().unwrap_or_else(|| "The meeting agent runtime is not installed. Run `npm run agent:stage` and restart the app.".to_string()))?;
        let node = self.runtime.node.as_ref().ok_or_else(|| {
            self.runtime.error.clone().unwrap_or_else(|| {
                "Node.js runtime is unavailable. Run `npm run agent:stage` and restart the app."
                    .to_string()
            })
        })?;
        let host = self
            .runtime
            .host
            .as_ref()
            .ok_or_else(|| self.runtime.error.clone().unwrap_or_else(|| "The meeting agent host script is missing. Run `npm run agent:stage` and restart the app.".to_string()))?;

        // The app has exactly one assistant thread. The meeting is *turn context*
        // (it still scopes tools and is stored on the message for attribution),
        // never the key of the conversation file — keying by meeting made every
        // visited meeting create its own orphan conversation.
        let conversation_key = "__global__";
        let mut conversation_file = self.load_conversation_file(conversation_key)?;
        let active_id = conversation_file.active_conversation_id.clone();
        let selected_id = conversation_id.or(active_id).or_else(|| {
            conversation_file
                .conversations
                .first()
                .map(|item| item.id.clone())
        });
        let selected_id = match selected_id {
            Some(id)
                if conversation_file
                    .conversations
                    .iter()
                    .any(|item| item.id == id) =>
            {
                id
            }
            Some(_) => {
                return Err(
                    "That assistant conversation could not be found in this scope.".to_string(),
                );
            }
            None => {
                let id = uuid::Uuid::new_v4().to_string();
                let now = now_ms() as i64;
                conversation_file.conversations.push(StoredConversation {
                    id: id.clone(),
                    title: String::new(),
                    created_at: now,
                    updated_at: now,
                    ..StoredConversation::default()
                });
                id
            }
        };
        conversation_file.active_conversation_id = Some(selected_id.clone());
        let selected = conversation_file
            .conversations
            .iter_mut()
            .find(|item| item.id == selected_id)
            .ok_or_else(|| {
                "That assistant conversation could not be found in this scope.".to_string()
            })?;
        if selected.title.trim().is_empty() {
            selected.title = conversation_title(text);
        }
        selected.updated_at = now_ms() as i64;
        let stored_conversation = selected.clone();
        self.save_conversation_file(conversation_key, &conversation_file)?;
        let request_id = uuid::Uuid::new_v4().to_string();
        let (control_tx, mut control_rx) = mpsc::unbounded_channel();
        let mut child = Command::new(node)
            .arg(host)
            .current_dir(runtime_root)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| {
                format!(
                    "Could not start the bundled meeting-agent runtime at {}: {error}",
                    node.display()
                )
            })?;
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "The agent runtime input stream could not be opened.".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "The agent runtime output stream could not be opened.".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "The agent runtime error stream could not be opened.".to_string())?;
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                log::debug!("meeting agent sidecar wrote {} stderr bytes", line.len());
            }
        });

        let profile = json!({
            "providerId": provider.id,
            "name": provider.name,
            "api": provider.api,
            "chatTemplateCompat": if provider.id == LOCAL_PROVIDER_ID && provider.api == "openai-completions" { "qwen" } else { "" },
            "baseUrl": provider.base_url,
            "apiKey": api_key.as_deref().unwrap_or_default(),
            "noAuth": provider.no_auth,
            "thinkingEffort": provider.thinking_effort,
            "model": {
                "id": model.id,
                "name": model.name,
                "contextWindow": model.context_window,
                "maxTokens": model.max_tokens,
            },
        });
        let prompt = context::build_prompt(
            if text.trim().is_empty() {
                "Please analyze the attached files."
            } else {
                text
            },
            context.as_ref(),
        );
        let display_text = if attachments.is_empty() {
            text.to_string()
        } else {
            format!(
                "{}\n[{}]",
                text,
                attachments
                    .iter()
                    .map(|item| item.name.replace(['\r', '\n'], " "))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        };
        let request = json!({
            "type": "prompt",
            "requestId": request_id.clone(),
            "meetingId": meeting_id,
            "profile": profile,
            "text": prompt,
            "displayText": display_text,
            "attachments": attachments,
            "history": stored_conversation.messages_for_context(meeting_id.as_deref()),
            "visibleHistory": stored_conversation.visible_history,
        });
        *lock(&self.active_control, "active turn") = Some((request_id.clone(), control_tx));
        if let Err(error) = write_json_line(&mut stdin, &request).await {
            let _ = child.start_kill();
            let mut active = lock(&self.active_control, "active turn");
            if active.as_ref().is_some_and(|(id, _)| id == &request_id) {
                *active = None;
            }
            return Err(error);
        }
        let mut lines = BufReader::new(stdout).lines();
        let mut terminal = false;
        let mut interrupted = false;
        let mut saw_done_event = false;
        let mut saw_error_event = false;
        let mut abort_at: Option<TokioInstant> = None;
        let started = TokioInstant::now();
        let hard_deadline = started + TURN_MAX_DURATION;
        let mut deadline = idle_deadline(started, hard_deadline);
        let mut outcome: Result<(), String> = Ok(());

        while !terminal {
            if !interrupted && TokioInstant::now() >= deadline {
                outcome = Err(turn_timeout_message(TokioInstant::now(), hard_deadline).to_string());
                interrupted = true;
                abort_at = Some(TokioInstant::now() + Duration::from_secs(3));
                reject_turn_approvals(&self.approvals, &request_id);
                let _ = write_json_line(&mut stdin, &json!({ "type": "abort" })).await;
            }
            let abort_timer =
                abort_at.unwrap_or_else(|| TokioInstant::now() + Duration::from_secs(3600));
            tokio::select! {
                line = lines.next_line() => {
                    match line {
                        Ok(Some(line)) => {
                            match serde_json::from_str::<Value>(&line) {
                                Ok(record) => {
                                    let progress = is_turn_progress(&record, &request_id);
                                    if record.get("type").and_then(Value::as_str) == Some("error")
                                        || record.pointer("/event/type").and_then(Value::as_str) == Some("error")
                                    {
                                        saw_error_event = true;
                                    }
                                    if record.pointer("/event/type").and_then(Value::as_str) == Some("done") {
                                        saw_done_event = true;
                                    }
                                    if let Err(error) = self.handle_record(
                                        &record,
                                        meeting_id.as_deref(),
                                        conversation_key,
                                        &selected_id,
                                        &request_id,
                                        meetings,
                                        &mut stdin,
                                        &mut control_rx,
                                        &mut interrupted,
                                        hard_deadline,
                                        tool_budget,
                                    ).await {
                                        outcome = Err(error);
                                        reject_turn_approvals(&self.approvals, &request_id);
                                        let _ = write_json_line(&mut stdin, &json!({ "type": "abort" })).await;
                                        interrupted = true;
                                        abort_at = Some(TokioInstant::now() + Duration::from_secs(3));
                                    }
                                    if progress && !interrupted {
                                        deadline = idle_deadline(TokioInstant::now(), hard_deadline);
                                    }
                                    if interrupted && abort_at.is_none() {
                                        abort_at = Some(TokioInstant::now() + Duration::from_secs(3));
                                    }
                                    if progress && record.get("type").and_then(Value::as_str) == Some("done") {
                                        terminal = true;
                                    }
                                }
                                Err(error) => log::warn!("Ignoring invalid meeting-agent output: {error}"),
                            }
                        }
                        Ok(None) => {
                            if outcome.is_ok() {
                                outcome = Err("The meeting-agent runtime stopped before completing the turn.".to_string());
                            }
                            terminal = true;
                        }
                        Err(error) => {
                            outcome = Err(format!("Could not read the meeting-agent runtime: {error}"));
                            terminal = true;
                        }
                    }
                }
                control = control_rx.recv(), if !interrupted => {
                    if matches!(control, Some(TurnControl::Abort)) {
                        interrupted = true;
                        abort_at = Some(TokioInstant::now() + Duration::from_secs(3));
                        reject_turn_approvals(&self.approvals, &request_id);
                        let _ = write_json_line(&mut stdin, &json!({ "type": "abort" })).await;
                    }
                }
                _ = tokio::time::sleep_until(abort_timer), if abort_at.is_some() => {
                    let _ = child.start_kill();
                    terminal = true;
                }
                _ = tokio::time::sleep_until(deadline), if !interrupted => {
                    outcome = Err(turn_timeout_message(TokioInstant::now(), hard_deadline).to_string());
                    interrupted = true;
                    abort_at = Some(TokioInstant::now() + Duration::from_secs(3));
                    reject_turn_approvals(&self.approvals, &request_id);
                    let _ = write_json_line(&mut stdin, &json!({ "type": "abort" })).await;
                }
            }
        }

        let _ = stdin.shutdown().await;
        if tokio::time::timeout(Duration::from_secs(2), child.wait())
            .await
            .is_err()
        {
            let _ = child.start_kill();
            let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
        }
        reject_turn_approvals(&self.approvals, &request_id);
        let mut active = lock(&self.active_control, "active turn");
        if active.as_ref().is_some_and(|(id, _)| id == &request_id) {
            *active = None;
        }
        drop(active);
        if !saw_error_event {
            if let Err(message) = outcome.as_ref() {
                self.emit(AgentEvent::Error {
                    message: message.clone(),
                    meeting_id: meeting_id.clone(),
                });
            }
        }
        if !saw_done_event {
            self.emit(AgentEvent::Done { meeting_id });
        }
        outcome
    }

    fn settings_snapshot(&self) -> Result<StoredSettings, String> {
        Ok(lock(&self.settings, "settings").clone())
    }

    fn provider_has_key(&self, provider: &StoredProvider) -> Result<bool, String> {
        self.api_key(provider).map(|key| key.is_some())
    }

    fn api_key(&self, provider: &StoredProvider) -> Result<Option<String>, String> {
        provider
            .encrypted_api_key
            .as_deref()
            .map(crypto::unprotect)
            .transpose()
    }

    fn provider_info(&self, provider: &StoredProvider) -> Result<AgentProviderInfo, String> {
        let has_key = self.provider_has_key(provider)?;
        Ok(AgentProviderInfo {
            id: provider.id.clone(),
            name: provider.name.clone(),
            api: provider.api.clone(),
            base_url: provider.base_url.clone(),
            configured: provider_configured(provider, has_key),
            has_key,
            no_auth: provider.no_auth,
            thinking_effort: provider.thinking_effort.clone(),
            models: provider
                .models
                .iter()
                .map(|model| model_info(provider, model, has_key))
                .collect(),
        })
    }

    async fn fetch_catalog(
        &self,
        provider: &StoredProvider,
        api_key: Option<&str>,
    ) -> Result<Vec<ProviderModelInput>, String> {
        let url = format!("{}/models", provider.base_url.trim_end_matches('/'));
        let mut request = self.http.get(&url);
        if let Some(key) = api_key.filter(|key| !key.is_empty()) {
            request = add_provider_auth(request, &provider.api, key)?;
        }
        let response = request.send().await.map_err(|error| {
            format!(
                "Could not reach {} at its models endpoint: {error}",
                provider.name
            )
        })?;
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(format!(
                "{} returned HTTP {status} from its models endpoint. Check the base URL and credentials.",
                provider.name
            ));
        }
        parse_catalog(&body, &provider.api)
    }

    fn session_path(&self, meeting_id: &str) -> Result<PathBuf, String> {
        if meeting_id.trim().is_empty() || meeting_id.len() > 250 {
            return Err("A valid meeting ID is required to load assistant history.".to_string());
        }
        let digest = Sha256::digest(meeting_id.as_bytes());
        let name = digest
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        Ok(self.sessions_dir.join(format!("{name}.json")))
    }

    fn load_conversation_file(&self, scope_key: &str) -> Result<StoredConversationFile, String> {
        let path = self.session_path(scope_key)?;
        let backup = path.with_extension("json.bak");
        if !path.exists() && backup.exists() {
            fs::rename(&backup, &path).map_err(|error| {
                format!(
                    "Could not restore assistant history from {}: {error}",
                    backup.display()
                )
            })?;
        }
        match fs::read_to_string(&path) {
            Ok(data) => {
                let value = serde_json::from_str::<Value>(&data)
                    .map_err(|error| format!("Could not load assistant history: {error}"))?;
                if value.get("conversations").is_some() {
                    let stored = serde_json::from_value::<StoredConversationFile>(value).map_err(
                        |error| format!("Could not load assistant conversations: {error}"),
                    )?;
                    if stored.scope_key != scope_key {
                        return Err(
                            "The assistant conversations belong to a different scope.".to_string()
                        );
                    }
                    return Ok(stored);
                }

                let legacy =
                    serde_json::from_value::<LegacyStoredSession>(value).map_err(|error| {
                        format!("Could not read existing assistant history: {error}")
                    })?;
                if legacy.meeting_id != scope_key {
                    return Err("The assistant history belongs to a different meeting.".to_string());
                }
                let created_at = legacy
                    .visible_history
                    .first()
                    .map(|item| item.timestamp)
                    .unwrap_or(now_ms() as i64);
                let updated_at = legacy
                    .visible_history
                    .last()
                    .map(|item| item.timestamp)
                    .unwrap_or(created_at);
                let title = legacy
                    .visible_history
                    .iter()
                    .find(|item| item.role == "user")
                    .map(|item| conversation_title(&item.text))
                    .unwrap_or_default();
                let conversation = StoredConversation {
                    id: "legacy".to_string(),
                    title,
                    created_at,
                    updated_at,
                    messages: legacy.messages,
                    messages_by_scope: HashMap::new(),
                    visible_history: legacy.visible_history,
                };
                Ok(StoredConversationFile {
                    scope_key: scope_key.to_string(),
                    active_conversation_id: Some(conversation.id.clone()),
                    conversations: vec![conversation],
                })
            }
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(StoredConversationFile {
                scope_key: scope_key.to_string(),
                ..StoredConversationFile::default()
            }),
            Err(error) => Err(format!("Could not load assistant history: {error}")),
        }
    }

    fn save_conversation_file(
        &self,
        scope_key: &str,
        stored: &StoredConversationFile,
    ) -> Result<(), String> {
        if stored.scope_key != scope_key {
            return Err("The assistant conversations belong to a different scope.".to_string());
        }
        let path = self.session_path(scope_key)?;
        let mut serialized = serde_json::to_vec(stored)
            .map_err(|error| format!("Could not serialize assistant conversations: {error}"))?;
        serialized.push(b'\n');
        let temp = path.with_extension("json.tmp");
        let backup = path.with_extension("json.bak");
        fs::write(&temp, serialized).map_err(|error| {
            format!(
                "Could not write assistant conversations {}: {error}",
                temp.display()
            )
        })?;
        match fs::rename(&temp, &path) {
            Ok(()) => Ok(()),
            Err(first_error) if path.exists() => {
                if backup.exists() {
                    fs::remove_file(&backup).map_err(|error| {
                        let _ = fs::remove_file(&temp);
                        format!(
                            "Could not clear the previous assistant-history backup {}: {error}",
                            backup.display()
                        )
                    })?;
                }
                fs::rename(&path, &backup).map_err(|error| {
                    let _ = fs::remove_file(&temp);
                    format!(
                        "Could not move assistant history {} aside for replacement: {error}",
                        path.display()
                    )
                })?;
                match fs::rename(&temp, &path) {
                    Ok(()) => {
                        let _ = fs::remove_file(&backup);
                        Ok(())
                    }
                    Err(replace_error) => match fs::rename(&backup, &path) {
                        Ok(()) => {
                            let _ = fs::remove_file(&temp);
                            Err(format!(
                                "Could not save assistant conversations {}: {replace_error} (initial replacement error: {first_error})",
                                path.display()
                            ))
                        }
                        Err(restore_error) => Err(format!(
                            "Could not save assistant conversations {}: {replace_error}; the previous history remains at {} because restoring it failed: {restore_error}",
                            path.display(),
                            backup.display()
                        )),
                    },
                }
            }
            Err(error) => {
                let _ = fs::remove_file(&temp);
                Err(format!(
                    "Could not save assistant conversations {}: {error}",
                    path.display()
                ))
            }
        }
    }

    fn save_conversation(
        &self,
        scope_key: &str,
        conversation_id: &str,
        model_scope: &str,
        messages: Vec<Value>,
        visible_history: Vec<AgentHistoryEntry>,
    ) -> Result<(), String> {
        let mut stored = self.load_conversation_file(scope_key)?;
        let conversation = stored
            .conversations
            .iter_mut()
            .find(|item| item.id == conversation_id)
            .ok_or_else(|| "The active assistant conversation could not be found.".to_string())?;
        if conversation.title.trim().is_empty() {
            conversation.title = visible_history
                .iter()
                .find(|item| item.role == "user")
                .map(|item| conversation_title(&item.text))
                .unwrap_or_default();
        }
        conversation.updated_at = now_ms() as i64;
        conversation
            .messages_by_scope
            .insert(model_scope.to_string(), messages);
        conversation.visible_history = visible_history;
        stored.active_conversation_id = Some(conversation_id.to_string());
        self.save_conversation_file(scope_key, &stored)
    }

    async fn handle_record(
        &self,
        record: &Value,
        meeting_id: Option<&str>,
        conversation_key: &str,
        conversation_id: &str,
        request_id: &str,
        meetings: &MeetingsState,
        stdin: &mut ChildStdin,
        controls: &mut mpsc::UnboundedReceiver<TurnControl>,
        interrupted: &mut bool,
        hard_deadline: TokioInstant,
        tool_budget: ToolBudget,
    ) -> Result<(), String> {
        match record
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
        {
            "event" => {
                if record.get("requestId").and_then(Value::as_str) != Some(request_id) {
                    return Ok(());
                }
                if let Some(raw) = record.get("event") {
                    if let Some(event) = parse_event(raw, meeting_id) {
                        let failure = match &event {
                            AgentEvent::Error { message, .. } => Some(message.clone()),
                            _ => None,
                        };
                        self.emit(event);
                        if let Some(message) = failure {
                            return Err(message);
                        }
                    }
                }
                Ok(())
            }
            "history" => {
                if record.get("requestId").and_then(Value::as_str) != Some(request_id) {
                    return Ok(());
                }
                let messages = record
                    .get("messages")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let visible_history = record
                    .get("visibleHistory")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(|item| serde_json::from_value::<AgentHistoryEntry>(item).ok())
                    .collect();
                self.save_conversation(
                    conversation_key,
                    conversation_id,
                    &model_history_scope(meeting_id),
                    messages,
                    visible_history,
                )
            }
            "tool_request" => {
                if record.get("requestId").and_then(Value::as_str) != Some(request_id) {
                    return Ok(());
                }
                self.handle_tool_request(
                    record,
                    meeting_id,
                    request_id,
                    meetings,
                    stdin,
                    controls,
                    interrupted,
                    hard_deadline,
                    tool_budget,
                )
                .await
            }
            "error" => {
                let message = record
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("The meeting assistant encountered an error.")
                    .to_string();
                self.emit(AgentEvent::Error {
                    message,
                    meeting_id: meeting_id.map(str::to_string),
                });
                Err(record
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("The meeting assistant encountered an error.")
                    .to_string())
            }
            _ => Ok(()),
        }
    }

    async fn handle_tool_request(
        &self,
        record: &Value,
        expected_meeting_id: Option<&str>,
        turn_id: &str,
        meetings: &MeetingsState,
        stdin: &mut ChildStdin,
        controls: &mut mpsc::UnboundedReceiver<TurnControl>,
        interrupted: &mut bool,
        hard_deadline: TokioInstant,
        tool_budget: ToolBudget,
    ) -> Result<(), String> {
        let call_id = record
            .get("callId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let name = record
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let meeting_id = record.get("meetingId").and_then(Value::as_str);
        if call_id.is_empty() {
            return Err("The meeting assistant sent a tool request without an ID.".to_string());
        }
        if meeting_id != expected_meeting_id {
            return write_tool_result(
                stdin,
                call_id,
                Value::Null,
                Some("The tool request did not match this meeting session.".to_string()),
            )
            .await;
        }
        let Some(meeting_id) = meeting_id else {
            return write_tool_result(
                stdin,
                call_id,
                Value::Null,
                Some("Select a meeting before using meeting tools.".to_string()),
            )
            .await;
        };
        let args = record.get("args").cloned().unwrap_or_else(|| json!({}));

        if matches!(name, "save_meeting_summary" | "save_meeting_actions") {
            let request_id = format!("agent:{turn_id}:{call_id}");
            let preview = match name {
                "save_meeting_summary" => args
                    .get("summary")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                _ => serde_json::to_string_pretty(
                    &args.get("actions").cloned().unwrap_or(Value::Null),
                )
                .unwrap_or_default(),
            };
            let title = if name == "save_meeting_summary" {
                "Save meeting summary"
            } else {
                "Save meeting actions"
            };
            let (sender, receiver) = oneshot::channel();
            lock(&self.approvals, "permission requests")
                .insert(request_id.clone(), (turn_id.to_string(), sender));
            self.emit(AgentEvent::PermissionRequest {
                request_id: request_id.clone(),
                tool: title.to_string(),
                input: Some(preview.chars().take(2500).collect()),
                title: Some(title.to_string()),
                meeting_id: Some(meeting_id.to_string()),
            });
            let approval_deadline = (TokioInstant::now() + APPROVAL_TIMEOUT).min(hard_deadline);
            let allow = tokio::select! {
                result = tokio::time::timeout_at(approval_deadline, receiver) => {
                    result.ok().and_then(Result::ok).unwrap_or(false)
                },
                control = controls.recv(), if !*interrupted => {
                    if matches!(control, Some(TurnControl::Abort)) {
                        *interrupted = true;
                        reject_turn_approvals(&self.approvals, turn_id);
                        let _ = write_json_line(stdin, &json!({ "type": "abort" })).await;
                    }
                    false
                }
            };
            lock(&self.approvals, "permission requests").remove(&request_id);
            if !allow {
                return write_tool_result(
                    stdin,
                    call_id,
                    Value::Null,
                    Some("The user did not approve this meeting-record change.".to_string()),
                )
                .await;
            }
        }

        let result = match name {
            "get_meeting_context" => get_meeting_context(meetings, meeting_id, &args, tool_budget),
            "get_meeting_action" => get_meeting_action(meetings, meeting_id, &args, tool_budget),
            "list_transcript_page" => {
                list_transcript_page(meetings, meeting_id, &args, tool_budget)
            }
            "search_transcript" => search_transcript(meetings, meeting_id, &args, tool_budget),
            "get_transcript_segment" => {
                get_transcript_segment(meetings, meeting_id, &args, tool_budget)
            }
            "save_meeting_summary" => save_meeting_summary(meetings, meeting_id, &args),
            "save_meeting_actions" => save_meeting_actions(meetings, meeting_id, &args),
            _ => Err(format!("Unknown meeting tool: {name}")),
        };
        match result {
            Ok(value) => write_tool_result(stdin, call_id, value, None).await,
            Err(error) => write_tool_result(stdin, call_id, Value::Null, Some(error)).await,
        }
    }

    fn emit(&self, event: AgentEvent) {
        let _ = self.app.emit("agent-event", &event);
    }
}

fn public_conversation(stored: &StoredConversation) -> AgentConversation {
    AgentConversation {
        id: stored.id.clone(),
        title: stored.title.clone(),
        created_at: stored.created_at,
        updated_at: stored.updated_at,
    }
}

fn conversation_title(text: &str) -> String {
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut characters = normalized.chars();
    let title = characters.by_ref().take(48).collect::<String>();
    if characters.next().is_some() {
        format!("{title}…")
    } else {
        title
    }
}

fn local_preset() -> StoredProvider {
    StoredProvider {
        id: LOCAL_PROVIDER_ID.to_string(),
        name: "Local 3080".to_string(),
        api: "openai-completions".to_string(),
        base_url: LOCAL_BASE_URL.to_string(),
        encrypted_api_key: None,
        no_auth: true,
        thinking_effort: None,
        models: vec![StoredModel {
            id: LOCAL_MODEL_ID.to_string(),
            name: "Ternary Bonsai 27B (3080)".to_string(),
            context_window: LOCAL_CONTEXT_WINDOW,
            max_tokens: LOCAL_MAX_TOKENS,
        }],
    }
}

fn runtime_paths(app: &AppHandle) -> RuntimePaths {
    let mut roots = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        roots.push((resource_dir.join("agent-runtime"), false));
    }
    #[cfg(debug_assertions)]
    {
        if let Some(workspace) = Path::new(env!("CARGO_MANIFEST_DIR")).parent() {
            roots.push((workspace.join("agent-runtime"), true));
        }
    }
    for (root, source_tree) in roots {
        let host = root.join("host.mjs");
        let modules = root.join("node_modules");
        if !host.is_file() || !modules.is_dir() {
            continue;
        }
        let bundled_node = root.join("runtime").join("node.exe");
        if bundled_node.is_file() {
            return RuntimePaths {
                root: Some(root),
                node: Some(bundled_node),
                host: Some(host),
                error: None,
            };
        }
        #[cfg(debug_assertions)]
        if source_tree {
            if let Some(node) = find_development_node() {
                return RuntimePaths {
                    root: Some(root),
                    node: Some(node.clone()),
                    host: Some(host),
                    error: None,
                };
            }
        }
    }
    RuntimePaths {
        root: None,
        node: None,
        host: None,
        error: Some("The packaged meeting-agent runtime is missing. Run `npm run agent:stage` and rebuild the app.".to_string()),
    }
}

#[cfg(debug_assertions)]
fn find_development_node() -> Option<PathBuf> {
    let output = StdCommand::new("where.exe").arg("node").output().ok()?;
    if !output.status.success() {
        return None;
    }
    for candidate in String::from_utf8_lossy(&output.stdout).lines() {
        let path = PathBuf::from(candidate.trim());
        if !path.is_file() {
            continue;
        }
        let version = StdCommand::new(&path).arg("--version").output().ok()?;
        if version.status.success()
            && node_version_is_supported(&String::from_utf8_lossy(&version.stdout))
        {
            log::info!(
                "Using development-only Node.js fallback at {} because no staged node.exe was found.",
                path.display()
            );
            return Some(path);
        }
    }
    None
}

#[cfg(not(debug_assertions))]
fn find_development_node() -> Option<PathBuf> {
    None
}

fn node_version_is_supported(version: &str) -> bool {
    let parsed = version.trim().trim_start_matches('v');
    let mut parts = parsed
        .split('.')
        .filter_map(|part| part.parse::<u32>().ok());
    let major = parts.next().unwrap_or_default();
    let minor = parts.next().unwrap_or_default();
    major > 22 || (major == 22 && minor >= 19)
}

fn load_settings(path: &Path) -> Result<StoredSettings, String> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(StoredSettings::default()),
        Err(error) => {
            return Err(format!(
                "Could not read assistant settings {}: {error}",
                path.display()
            ));
        }
    };
    match serde_json::from_str(&text) {
        Ok(settings) => Ok(settings),
        Err(error) => {
            let backup = path.with_extension(format!("json.corrupt-{}", now_ms()));
            fs::rename(path, &backup).map_err(|rename_error| {
                format!("Assistant settings are invalid ({error}) and could not be backed up: {rename_error}")
            })?;
            log::warn!(
                "Assistant settings were invalid ({error}); moved the file to {}.",
                backup.display()
            );
            Ok(StoredSettings::default())
        }
    }
}

fn persist_settings(path: &Path, settings: &StoredSettings) -> Result<(), String> {
    let mut json = serde_json::to_vec_pretty(settings)
        .map_err(|error| format!("Could not serialize assistant settings: {error}"))?;
    json.push(b'\n');
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, json)
        .map_err(|error| format!("Could not write assistant settings: {error}"))?;
    match fs::rename(&temp, path) {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = fs::remove_file(&temp);
            Err(format!(
                "Could not save assistant settings {}: {error}",
                path.display()
            ))
        }
    }
}

fn normalize_models(models: Vec<ProviderModelInput>) -> Result<Vec<StoredModel>, String> {
    let mut normalized = Vec::new();
    for model in models {
        let id = model.id.trim();
        if id.is_empty() || id.len() > 250 {
            continue;
        }
        if normalized.iter().any(|item: &StoredModel| item.id == id) {
            continue;
        }
        let context_window = model.context_window.unwrap_or(8192).clamp(1024, 1_000_000);
        let max_tokens = model.max_tokens.unwrap_or(1024).clamp(1, context_window);
        normalized.push(StoredModel {
            id: id.to_string(),
            name: if model.name.trim().is_empty() {
                id.to_string()
            } else {
                model.name.trim().to_string()
            },
            context_window,
            max_tokens,
        });
        if normalized.len() >= 200 {
            break;
        }
    }
    Ok(normalized)
}

fn merge_model_metadata(
    models: Vec<ProviderModelInput>,
    previous: &[StoredModel],
) -> Vec<ProviderModelInput> {
    models
        .into_iter()
        .map(|model| {
            let known = previous.iter().find(|saved| saved.id == model.id);
            ProviderModelInput {
                context_window: model
                    .context_window
                    .or_else(|| known.map(|saved| saved.context_window)),
                max_tokens: model
                    .max_tokens
                    .or_else(|| known.map(|saved| saved.max_tokens)),
                name: if model.name.trim().is_empty() {
                    known
                        .map(|saved| saved.name.clone())
                        .unwrap_or_else(|| model.id.clone())
                } else {
                    model.name
                },
                ..model
            }
        })
        .collect()
}

fn valid_provider_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn provider_configured(provider: &StoredProvider, has_key: bool) -> bool {
    !provider.base_url.trim().is_empty()
        && !provider.models.is_empty()
        && (provider.no_auth || has_key)
}

fn model_info(provider: &StoredProvider, model: &StoredModel, has_key: bool) -> AgentModelInfo {
    AgentModelInfo {
        provider: provider.id.clone(),
        id: model.id.clone(),
        name: model.name.clone(),
        api: provider.api.clone(),
        base_url: provider.base_url.clone(),
        has_key,
    }
}

fn flatten_models(settings: &StoredSettings) -> Vec<AgentModelInfo> {
    let mut result = Vec::new();
    for provider in settings.providers.values() {
        let has_key = provider.encrypted_api_key.is_some();
        result.extend(
            provider
                .models
                .iter()
                .map(|model| model_info(provider, model, has_key)),
        );
    }
    result.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    result
}

fn unavailable_status(detail: String) -> AgentStatus {
    AgentStatus {
        status: "error".to_string(),
        label: "Assistant settings unavailable".to_string(),
        detail,
        provider: None,
        model: None,
        models: Vec::new(),
    }
}

fn add_provider_auth(
    request: reqwest::RequestBuilder,
    api: &str,
    key: &str,
) -> Result<reqwest::RequestBuilder, String> {
    match api {
        "anthropic-messages" => {
            let api_key = HeaderValue::from_str(key)
                .map_err(|_| "The API key contains invalid characters.".to_string())?;
            let version = HeaderValue::from_static("2023-06-01");
            Ok(request
                .header("x-api-key", api_key)
                .header("anthropic-version", version))
        }
        "google-generative-ai" => {
            let api_key = HeaderValue::from_str(key)
                .map_err(|_| "The API key contains invalid characters.".to_string())?;
            Ok(request.header("x-goog-api-key", api_key))
        }
        _ => Ok(request.bearer_auth(key)),
    }
}

fn parse_catalog(body: &str, api: &str) -> Result<Vec<ProviderModelInput>, String> {
    let value: Value = serde_json::from_str(body)
        .map_err(|error| format!("The provider returned an unreadable model list: {error}"))?;
    let rows = value
        .get("data")
        .or_else(|| value.get("models"))
        .and_then(Value::as_array)
        .or_else(|| value.as_array())
        .ok_or_else(|| "The provider did not return a supported model-list format.".to_string())?;
    let mut models = Vec::new();
    for row in rows.iter().take(200) {
        let id = row
            .get("id")
            .or_else(|| row.get("name"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim();
        if id.is_empty() {
            continue;
        }
        let id = if api == "google-generative-ai" {
            id.strip_prefix("models/").unwrap_or(id)
        } else {
            id
        };
        let name = row
            .get("displayName")
            .and_then(Value::as_str)
            .unwrap_or_default();
        models.push(ProviderModelInput {
            id: id.to_string(),
            name: name.to_string(),
            context_window: first_u32(
                row,
                &[
                    "/meta/n_ctx",
                    "/meta/context_length",
                    "/context_window",
                    "/contextWindow",
                    "/context_length",
                    "/contextLength",
                    "/inputTokenLimit",
                ],
            ),
            max_tokens: first_u32(
                row,
                &[
                    "/max_tokens",
                    "/max_completion_tokens",
                    "/max_output_tokens",
                    "/outputTokenLimit",
                    "/output_token_limit",
                ],
            ),
        });
    }
    Ok(models)
}

fn first_u32(value: &Value, paths: &[&str]) -> Option<u32> {
    paths.iter().find_map(|path| {
        value
            .pointer(path)
            .and_then(Value::as_u64)
            .and_then(|number| u32::try_from(number).ok())
            .filter(|number| *number > 0 && *number <= 1_000_000)
    })
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

fn reject_turn_approvals(
    approvals: &Mutex<HashMap<String, (String, oneshot::Sender<bool>)>>,
    turn_id: &str,
) {
    let mut pending = lock(approvals, "permission requests");
    let keys = pending
        .iter()
        .filter(|(_, (pending_turn, _))| pending_turn == turn_id)
        .map(|(request_id, _)| request_id.clone())
        .collect::<Vec<_>>();
    for request_id in keys {
        if let Some((_, sender)) = pending.remove(&request_id) {
            let _ = sender.send(false);
        }
    }
}

fn parse_event(raw: &Value, meeting_id: Option<&str>) -> Option<AgentEvent> {
    let mut value = raw.clone();
    let object = value.as_object_mut()?;
    if let Some(meeting_id) = meeting_id {
        object.insert(
            "meetingId".to_string(),
            Value::String(meeting_id.to_string()),
        );
    }
    serde_json::from_value(value).ok()
}

async fn write_json_line(stdin: &mut ChildStdin, value: &Value) -> Result<(), String> {
    let mut encoded = serde_json::to_vec(value)
        .map_err(|error| format!("Could not encode agent runtime input: {error}"))?;
    encoded.push(b'\n');
    stdin
        .write_all(&encoded)
        .await
        .map_err(|error| format!("Could not write to the meeting-agent runtime: {error}"))?;
    stdin
        .flush()
        .await
        .map_err(|error| format!("Could not flush meeting-agent runtime input: {error}"))
}

async fn write_tool_result(
    stdin: &mut ChildStdin,
    call_id: &str,
    result: Value,
    error: Option<String>,
) -> Result<(), String> {
    write_json_line(
        stdin,
        &json!({
            "type": "tool_result",
            "callId": call_id,
            "result": result,
            "error": error,
        }),
    )
    .await
}

fn get_meeting_context(
    meetings: &MeetingsState,
    meeting_id: &str,
    args: &Value,
    budget: ToolBudget,
) -> Result<Value, String> {
    let meeting = meetings
        .get(meeting_id)?
        .ok_or_else(|| "Meeting not found.".to_string())?;
    let transcript = meetings.transcript_list(meeting_id, 0, 1)?;
    let summary_offset = args
        .get("summaryOffset")
        .and_then(Value::as_u64)
        .unwrap_or(0) as usize;
    let (summary, summary_length, summary_next_offset) = text_page(
        &meeting.summary,
        summary_offset,
        budget.summary_chars,
        "summary",
    )?;
    let agenda_offset = args
        .get("agendaOffset")
        .and_then(Value::as_u64)
        .unwrap_or(0) as usize;
    let (agenda, agenda_length, agenda_next_offset) = text_page(
        &meeting.agenda,
        agenda_offset,
        budget.agenda_chars,
        "agenda",
    )?;

    let action_offset = args
        .get("actionOffset")
        .and_then(Value::as_u64)
        .unwrap_or(0) as usize;
    let action_count = meeting.actions.len();
    if action_offset > action_count {
        return Err("The action offset is beyond the saved action list.".to_string());
    }
    let actions = meeting
        .actions
        .iter()
        .skip(action_offset)
        .take(budget.action_items)
        .map(|action| action_page(action, 0, 0, budget))
        .collect::<Result<Vec<_>, _>>()?;
    let action_end = action_offset + actions.len();
    let actions_next_offset = (action_end < action_count).then_some(action_end);
    Ok(json!({
        "meeting": {
            "id": meeting.id,
            "title": meeting.title,
            "agenda": agenda,
            "agendaLength": agenda_length,
            "agendaOffset": agenda_offset,
            "agendaTruncated": agenda_next_offset.is_some(),
            "agendaNextOffset": agenda_next_offset,
            "status": meeting.status,
            "startedAt": meeting.started_at,
            "endedAt": meeting.ended_at,
            "summary": summary,
            "summaryLength": summary_length,
            "summaryOffset": summary_offset,
            "summaryHasMore": summary_next_offset.is_some(),
            "summaryNextOffset": summary_next_offset,
            "actions": actions,
            "actionCount": action_count,
            "actionOffset": action_offset,
            "actionsHasMore": actions_next_offset.is_some(),
            "actionsNextOffset": actions_next_offset,
        },
        "transcriptTotalCount": transcript.total_count,
    }))
}

fn text_page(
    text: &str,
    offset: usize,
    limit: usize,
    label: &str,
) -> Result<(String, usize, Option<usize>), String> {
    let length = text.chars().count();
    if offset > length {
        return Err(format!("The {label} offset is beyond the saved text."));
    }
    let fragment: String = text.chars().skip(offset).take(limit).collect();
    let end = offset + fragment.chars().count();
    Ok((fragment, length, (end < length).then_some(end)))
}

fn action_page(
    action: &MeetingAction,
    text_offset: usize,
    source_offset: usize,
    budget: ToolBudget,
) -> Result<Value, String> {
    let (text, text_length, next_text_offset) = text_page(
        &action.text,
        text_offset,
        budget.action_chars,
        "action text",
    )?;
    let source_count = action.source_segment_ids.len();
    if source_offset > source_count {
        return Err("The source offset is beyond the action's references.".to_string());
    }
    let sources = action
        .source_segment_ids
        .iter()
        .skip(source_offset)
        .take(budget.action_sources)
        .collect::<Vec<_>>();
    let source_end = source_offset + sources.len();
    let next_source_offset = (source_end < source_count).then_some(source_end);
    Ok(json!({
        "id": action.id, "text": text, "textOffset": text_offset,
        "textLength": text_length, "textTruncated": next_text_offset.is_some(),
        "nextTextOffset": next_text_offset, "owner": action.owner,
        "dueDate": action.due_date, "completed": action.completed,
        "sourceSegmentIds": sources, "sourceOffset": source_offset,
        "sourceCount": source_count, "nextSourceOffset": next_source_offset,
    }))
}

fn get_meeting_action(
    meetings: &MeetingsState,
    meeting_id: &str,
    args: &Value,
    budget: ToolBudget,
) -> Result<Value, String> {
    let action_id = args
        .get("actionId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    if action_id.is_empty() {
        return Err("An action ID is required.".to_string());
    }
    let meeting = meetings
        .get(meeting_id)?
        .ok_or_else(|| "Meeting not found.".to_string())?;
    let action = meeting
        .actions
        .iter()
        .find(|action| action.id == action_id)
        .ok_or_else(|| "Action not found in this meeting.".to_string())?;
    let text_offset = args.get("textOffset").and_then(Value::as_u64).unwrap_or(0) as usize;
    let source_offset = args
        .get("sourceOffset")
        .and_then(Value::as_u64)
        .unwrap_or(0) as usize;
    action_page(action, text_offset, source_offset, budget)
}

fn list_transcript_page(
    meetings: &MeetingsState,
    meeting_id: &str,
    args: &Value,
    budget: ToolBudget,
) -> Result<Value, String> {
    let offset = args.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
    let limit = args
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(budget.page_items)
        .clamp(1, budget.page_items) as usize;
    let page = meetings.transcript_list(meeting_id, offset, limit)?;
    let started_at = meeting_started_at(meetings, meeting_id)?;
    Ok(compact_page(page, budget, started_at))
}

fn search_transcript(
    meetings: &MeetingsState,
    meeting_id: &str,
    args: &Value,
    budget: ToolBudget,
) -> Result<Value, String> {
    let query = args
        .get("query")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    if query.is_empty() {
        return Err("Enter a transcript search phrase.".to_string());
    }
    let offset = args.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
    let limit = args
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(budget.page_items)
        .clamp(1, budget.page_items) as usize;
    let page = meetings.transcript_search(query, Some(meeting_id), offset, limit)?;
    let started_at = meeting_started_at(meetings, meeting_id)?;
    Ok(compact_page(page, budget, started_at))
}

fn get_transcript_segment(
    meetings: &MeetingsState,
    meeting_id: &str,
    args: &Value,
    budget: ToolBudget,
) -> Result<Value, String> {
    let segment_id = args
        .get("segmentId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    if segment_id.is_empty() {
        return Err("A transcript segment ID is required.".to_string());
    }
    let segment = meetings
        .transcript_get_by_id(meeting_id, segment_id)?
        .ok_or_else(|| "Transcript segment not found in this meeting.".to_string())?;
    let text_offset = args.get("textOffset").and_then(Value::as_u64).unwrap_or(0) as usize;
    let limit = args
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(budget.text_chars as u64)
        .clamp(1, budget.text_chars as u64) as usize;
    let text_length = segment.text.chars().count();
    if text_offset > text_length {
        return Err("The text offset is beyond this transcript segment.".to_string());
    }
    let text: String = segment.text.chars().skip(text_offset).take(limit).collect();
    let end_offset = text_offset + text.chars().count();
    let next_text_offset = (end_offset < text_length).then_some(end_offset);
    let (start_ms, end_ms, time_base) =
        segment_times(&segment, meeting_started_at(meetings, meeting_id)?);
    Ok(json!({
        "id": segment.id,
        "sequence": segment.sequence,
        "startMs": start_ms,
        "endMs": end_ms,
        "timeBase": time_base,
        "startUnixMs": segment.started_at_ms,
        "endUnixMs": segment.ended_at_ms,
        "source": segment.source,
        "text": text,
        "textOffset": text_offset,
        "textLength": text_length,
        "textTruncated": next_text_offset.is_some(),
        "nextTextOffset": next_text_offset,
    }))
}

fn meeting_started_at(meetings: &MeetingsState, meeting_id: &str) -> Result<Option<i64>, String> {
    Ok(meetings
        .get(meeting_id)?
        .ok_or_else(|| "Meeting not found.".to_string())?
        .started_at)
}

fn segment_times(
    segment: &TranscriptSegment,
    meeting_start: Option<i64>,
) -> (i64, i64, &'static str) {
    if let Some(start) = meeting_start.filter(|start| {
        segment.started_at_ms >= *start && segment.ended_at_ms >= segment.started_at_ms
    }) {
        return (
            segment.started_at_ms.saturating_sub(start),
            segment.ended_at_ms.saturating_sub(start),
            "meeting",
        );
    }
    let frame_ms = |frame: u64| {
        ((frame as u128 * 1_000 / ASR_SAMPLE_RATE as u128).min(i64::MAX as u128)) as i64
    };
    (
        frame_ms(segment.start_frame),
        frame_ms(segment.end_frame),
        "recording",
    )
}

fn compact_page(page: TranscriptPage, budget: ToolBudget, meeting_start: Option<i64>) -> Value {
    let mut text_budget = budget.text_chars;
    let mut items = Vec::new();
    for segment in &page.items {
        if text_budget == 0 {
            break;
        }
        let (item, used, truncated) = compact_segment(segment, text_budget, meeting_start);
        text_budget = text_budget.saturating_sub(used);
        items.push(item);
        if truncated {
            break;
        }
    }
    let next_offset = if items.is_empty() {
        page.next_offset.filter(|offset| *offset > page.offset)
    } else {
        let next = page.offset.saturating_add(items.len());
        (next < page.total_count).then_some(next)
    };
    json!({
        "items": items,
        "totalCount": page.total_count,
        "offset": page.offset,
        "hasMore": next_offset.is_some(),
        "nextOffset": next_offset,
        "pageItemLimit": budget.page_items,
        "pageTextLimit": budget.text_chars,
    })
}

fn compact_segment(
    segment: &TranscriptSegment,
    text_budget: usize,
    meeting_start: Option<i64>,
) -> (Value, usize, bool) {
    let chars: Vec<char> = segment.text.chars().collect();
    let allowed = chars.len().min(text_budget);
    let text: String = chars.iter().take(allowed).collect();
    let truncated = allowed < chars.len();
    let (start_ms, end_ms, time_base) = segment_times(segment, meeting_start);
    (
        json!({
            "id": segment.id,
            "sequence": segment.sequence,
            "startMs": start_ms,
            "endMs": end_ms,
            "timeBase": time_base,
            "startUnixMs": segment.started_at_ms,
            "endUnixMs": segment.ended_at_ms,
            "source": segment.source,
            "text": text,
            "textOffset": 0,
            "textLength": chars.len(),
            "textTruncated": truncated,
            "nextTextOffset": truncated.then_some(allowed),
        }),
        allowed,
        truncated,
    )
}

fn save_meeting_summary(
    meetings: &MeetingsState,
    meeting_id: &str,
    args: &Value,
) -> Result<Value, String> {
    let summary = args
        .get("summary")
        .and_then(Value::as_str)
        .ok_or_else(|| "A meeting summary is required.".to_string())?
        .trim();
    if !(20..=6000).contains(&summary.chars().count()) {
        return Err("The summary must contain between 20 and 6000 characters.".to_string());
    }
    let meeting = meetings.update_summary(meeting_id, summary.to_string())?;
    Ok(
        json!({ "saved": true, "meetingId": meeting.id, "summaryLength": meeting.summary.chars().count() }),
    )
}

fn save_meeting_actions(
    meetings: &MeetingsState,
    meeting_id: &str,
    args: &Value,
) -> Result<Value, String> {
    let actions = args
        .get("actions")
        .cloned()
        .ok_or_else(|| "Meeting actions are required.".to_string())?;
    let actions: Vec<MeetingAction> = serde_json::from_value(actions)
        .map_err(|error| format!("The meeting actions were invalid: {error}"))?;
    if actions.len() > 30 {
        return Err("Save at most 30 actions at a time.".to_string());
    }
    let meeting = meetings.set_actions(meeting_id, actions)?;
    Ok(json!({ "saved": true, "meetingId": meeting.id, "actionCount": meeting.actions.len() }))
}

fn lock<'a, T>(mutex: &'a Mutex<T>, label: &str) -> MutexGuard<'a, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            log::warn!("The meeting-agent {label} lock was poisoned; continuing.");
            poisoned.into_inner()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn context_status_is_forwarded_with_meeting_scope() {
        let raw = json!({
            "type": "context_status",
            "status": "compacted",
            "estimatedTokens": 4123,
            "contextWindow": 8192,
            "summaryTokens": 512
        });
        let event = parse_event(&raw, Some("meeting-a")).expect("valid context event");
        let serialized = serde_json::to_value(event).expect("serializable context event");
        assert_eq!(serialized["meetingId"], "meeting-a");
        assert_eq!(serialized["status"], "compacted");
        assert_eq!(serialized["estimatedTokens"], 4123);
        assert_eq!(serialized["summaryTokens"], 512);
    }
    use crate::audio::types::SourceKind;
    use crate::meetings::{MeetingCreateInput, transcript::TranscriptStore};

    struct TempStore(PathBuf);

    impl TempStore {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("meeting-agent-tools-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempStore {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn test_meeting(path: &Path, agenda: String) -> (MeetingsState, String) {
        let store = MeetingsState::from_path(path.join("meetings.json")).unwrap();
        let meeting = store
            .create(MeetingCreateInput {
                title: "fixture".to_string(),
                agenda,
                identity_id: None,
            })
            .unwrap();
        (store, meeting.id)
    }

    fn segment(id: usize, meeting_id: &str, started_at_ms: i64) -> TranscriptSegment {
        TranscriptSegment {
            id: format!("segment-{id}"),
            meeting_id: meeting_id.to_string(),
            session_id: "session".to_string(),
            turn_id: format!("turn-{id}"),
            source: SourceKind::Microphone,
            text: "中".repeat(50),
            sequence: id as u64,
            start_frame: 32_000 + id as u64 * 1_600,
            end_frame: 40_000 + id as u64 * 1_600,
            started_at_ms,
            ended_at_ms: started_at_ms + 500,
        }
    }

    #[test]
    fn summary_limits_count_unicode_characters() {
        let temp = TempStore::new();
        let (store, id) = test_meeting(&temp.0, String::new());
        assert!(save_meeting_summary(&store, &id, &json!({"summary": "中".repeat(19)})).is_err());
        assert_eq!(
            save_meeting_summary(&store, &id, &json!({"summary": "中".repeat(20)})).unwrap()["summaryLength"],
            20
        );
        assert_eq!(
            save_meeting_summary(&store, &id, &json!({"summary": "中".repeat(6000)})).unwrap()["summaryLength"],
            6000
        );
        assert!(save_meeting_summary(&store, &id, &json!({"summary": "中".repeat(6001)})).is_err());
    }

    #[test]
    fn agenda_and_action_details_are_recoverable_in_small_windows() {
        let temp = TempStore::new();
        let agenda = "议".repeat(420);
        let (store, id) = test_meeting(&temp.0, agenda.clone());
        let budget = ToolBudget::for_model(4096, 512);
        let mut offset = 0;
        let mut recovered = String::new();
        loop {
            let result =
                get_meeting_context(&store, &id, &json!({"agendaOffset": offset}), budget).unwrap();
            recovered.push_str(result["meeting"]["agenda"].as_str().unwrap());
            match result["meeting"]["agendaNextOffset"].as_u64() {
                Some(next) => offset = next as usize,
                None => break,
            }
        }
        assert_eq!(recovered, agenda);
        let action = MeetingAction {
            id: "action".into(),
            text: "项".repeat(250),
            source_segment_ids: (0..9).map(|n| format!("ref-{n}")).collect(),
            ..MeetingAction::default()
        };
        let first = action_page(&action, 0, 0, budget).unwrap();
        assert_eq!(first["nextTextOffset"], 100);
        assert_eq!(first["nextSourceOffset"], 4);
        let second = action_page(&action, 100, 4, budget).unwrap();
        let third = action_page(&action, 200, 8, budget).unwrap();
        assert_eq!(
            format!(
                "{}{}{}",
                first["text"].as_str().unwrap(),
                second["text"].as_str().unwrap(),
                third["text"].as_str().unwrap()
            ),
            action.text
        );
        assert!(third["nextSourceOffset"].is_null());
        assert_eq!(third["sourceSegmentIds"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn transcript_pages_and_timestamps_use_model_budget_and_explicit_time_base() {
        let temp = TempStore::new();
        let (store, id) = test_meeting(&temp.0, String::new());
        let started = store.begin_start(&id).unwrap().started_at.unwrap();
        let dir = temp.0.join("recording");
        fs::create_dir_all(&dir).unwrap();
        store
            .confirm_start(
                &id,
                "running".to_string(),
                Some(dir.to_string_lossy().to_string()),
            )
            .unwrap();
        let transcript = TranscriptStore::open(dir.join("transcript.jsonl")).unwrap();
        for index in 0..32 {
            transcript
                .append(&segment(index, &id, started + 2_000 + index as i64 * 100))
                .unwrap();
        }
        drop(transcript);
        let small = ToolBudget::for_model(4096, 512);
        let large = ToolBudget::for_model(1_000_000, 4096);
        let first_small = list_transcript_page(&store, &id, &json!({"limit": 30}), small).unwrap();
        assert_eq!(first_small["items"].as_array().unwrap().len(), 8);
        assert_eq!(first_small["nextOffset"], 8);
        assert_eq!(first_small["items"][0]["startMs"], 2000);
        assert_eq!(first_small["items"][0]["timeBase"], "meeting");
        assert_eq!(first_small["items"][0]["startUnixMs"], started + 2000);
        let first_large = list_transcript_page(&store, &id, &json!({"limit": 30}), large).unwrap();
        assert_eq!(first_large["items"].as_array().unwrap().len(), 30);
        assert_eq!(first_large["nextOffset"], 30);
        let searched =
            search_transcript(&store, &id, &json!({"query":"中", "limit":30}), large).unwrap();
        assert_eq!(searched["items"].as_array().unwrap().len(), 30);
        let last =
            list_transcript_page(&store, &id, &json!({"offset": 30, "limit": 30}), large).unwrap();
        assert_eq!(last["items"].as_array().unwrap().len(), 2);
        assert_eq!(last["hasMore"], false);
        let single =
            get_transcript_segment(&store, &id, &json!({"segmentId":"segment-0"}), large).unwrap();
        assert_eq!(single["startMs"], 2000);
        assert_eq!(single["timeBase"], "meeting");
        store
            .set_actions(
                &id,
                vec![MeetingAction {
                    id: "action-1".into(),
                    text: "项".repeat(250),
                    source_segment_ids: (0..9).map(|n| format!("segment-{n}")).collect(),
                    ..MeetingAction::default()
                }],
            )
            .unwrap();
        let context = get_meeting_context(&store, &id, &json!({}), small).unwrap();
        let action = &context["meeting"]["actions"][0];
        assert_eq!(action["nextTextOffset"], 100);
        assert_eq!(action["nextSourceOffset"], 4);
        let continuation = get_meeting_action(
            &store,
            &id,
            &json!({"actionId":"action-1", "textOffset":100, "sourceOffset":4}),
            small,
        )
        .unwrap();
        assert_eq!(continuation["text"].as_str().unwrap().chars().count(), 100);
        assert_eq!(continuation["nextTextOffset"], 200);
        assert!(get_meeting_action(&store, &id, &json!({"actionId":"missing"}), small).is_err());
        assert_eq!(
            segment_times(&segment(0, &id, started + 2000), None),
            (2000, 2500, "recording")
        );
    }

    #[test]
    fn progress_renews_idle_timeout_but_never_extends_absolute_limit() {
        let started = TokioInstant::now();
        let hard = started + TURN_MAX_DURATION;
        assert_eq!(idle_deadline(started, hard), started + TURN_IDLE_TIMEOUT);
        assert_eq!(
            idle_deadline(started + Duration::from_secs(80), hard),
            started + Duration::from_secs(170)
        );
        assert_eq!(
            idle_deadline(started + Duration::from_secs(590), hard),
            hard
        );
        assert!(is_turn_progress(
            &json!({"requestId":"a", "type":"event", "event":{"type":"text_delta"}}),
            "a"
        ));
        assert!(!is_turn_progress(
            &json!({"requestId":"b", "type":"event"}),
            "a"
        ));
        assert!(!is_turn_progress(
            &json!({"requestId":"a", "type":"heartbeat"}),
            "a"
        ));
        assert!(turn_timeout_message(hard, hard).contains("maximum"));
    }

    #[test]
    fn model_history_is_isolated_by_meeting_and_legacy_messages_are_not_replayed() {
        let mut conversation = StoredConversation {
            messages: vec![json!({"role": "user", "content": "legacy"})],
            ..StoredConversation::default()
        };
        conversation
            .messages_by_scope
            .insert(model_history_scope(Some("a")), vec![json!("meeting a")]);
        conversation
            .messages_by_scope
            .insert(model_history_scope(None), vec![json!("general")]);
        assert_eq!(
            conversation.messages_for_context(Some("a")),
            vec![json!("meeting a")]
        );
        assert_eq!(
            conversation.messages_for_context(None),
            vec![json!("general")]
        );
        assert!(conversation.messages_for_context(Some("b")).is_empty());
        let restored: StoredConversation =
            serde_json::from_value(serde_json::to_value(&conversation).unwrap()).unwrap();
        assert_eq!(
            restored.messages_for_context(Some("a")),
            vec![json!("meeting a")]
        );
        assert_eq!(
            restored.messages,
            vec![json!({"role": "user", "content": "legacy"})]
        );
    }

    #[test]
    fn catalog_uses_runtime_context_and_preserves_known_model_limits() {
        let discovered = parse_catalog(
            r#"{"data":[{"id":"bonsai","meta":{"n_ctx":4096,"n_ctx_train":262144}},{"id":"new-model","meta":{"n_ctx_train":131072}}]}"#,
            "openai-completions",
        )
        .expect("valid model catalog");
        assert_eq!(discovered[0].context_window, Some(4096));
        assert_eq!(discovered[1].context_window, None);

        let previous = vec![StoredModel {
            id: "bonsai".to_string(),
            name: "Ternary Bonsai local".to_string(),
            context_window: 4096,
            max_tokens: 512,
        }];
        let normalized = normalize_models(merge_model_metadata(discovered, &previous))
            .expect("normalized models");
        assert_eq!(normalized[0].context_window, 4096);
        assert_eq!(normalized[0].max_tokens, 512);
        assert_eq!(normalized[0].name, "Ternary Bonsai local");
        assert_eq!(normalized[1].context_window, 8192);
        assert_eq!(normalized[1].max_tokens, 1024);
    }
}
