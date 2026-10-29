//! User-configured knowledge services. Source documents stay with their provider.
use std::{fs, path::PathBuf, sync::Mutex, time::Duration};

use reqwest::{Client, Url};
use rmcp::{
    ServiceExt,
    model::CallToolRequestParams,
    transport::{
        StreamableHttpClientTransport, streamable_http_client::StreamableHttpClientTransportConfig,
    },
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::asr::crypto;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredSource {
    id: String,
    name: String,
    kind: String,
    base_url: String,
    encrypted_api_key: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeSource {
    id: String,
    name: String,
    kind: String,
    base_url: String,
    has_api_key: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentMcpSource {
    id: String,
    name: String,
}

pub(crate) struct AgentMcpTarget(StoredSource);

impl AgentMcpTarget {
    pub(crate) fn label(&self) -> String {
        format!("{} ({})", self.0.name, self.0.base_url)
    }
}

impl From<&StoredSource> for KnowledgeSource {
    fn from(source: &StoredSource) -> Self {
        Self {
            id: source.id.clone(),
            name: source.name.clone(),
            kind: source.kind.clone(),
            base_url: source.base_url.clone(),
            has_api_key: source.encrypted_api_key.is_some(),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeSourceInput {
    id: Option<String>,
    name: String,
    kind: String,
    base_url: String,
    api_key: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeSpace {
    id: String,
    name: String,
    uses_pipeline: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeImport {
    name: String,
    document_id: String,
    status: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeDocumentStatus {
    status: String,
    message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeDocument {
    id: String,
    name: String,
    status: String,
    message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeDocumentPage {
    items: Vec<KnowledgeDocument>,
    has_more: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredSource {
    kind: String,
    base_url: String,
    label: String,
}

async fn probe_local_http(client: &Client, kind: &str, base: &str) -> Option<DiscoveredSource> {
    let path = match kind {
        "ragflow" => "/api/v1/system/healthz",
        "openwebui" => "/api/version",
        "anythingllm" => "/api/ping",
        _ => return None,
    };
    let response = client
        .get(format!("{base}{path}"))
        .timeout(Duration::from_secs(2))
        .send()
        .await
        .ok()?;
    if !response.status().is_success() && !(kind == "ragflow" && response.status().as_u16() == 500)
    {
        return None;
    }
    let value: Value = response.json().await.ok()?;
    let matches = match kind {
        "ragflow" => value.get("db").is_some() && value.get("doc_engine").is_some(),
        "openwebui" => {
            value.get("version").and_then(Value::as_str).is_some()
                && value.get("deployment_id").is_some()
        }
        // A ping endpoint alone is not a unique product fingerprint; present it as a candidate.
        "anythingllm" => value.is_object(),
        _ => false,
    };
    matches.then(|| DiscoveredSource {
        kind: kind.into(),
        base_url: base.into(),
        label: if kind == "anythingllm" {
            "Possible AnythingLLM".into()
        } else if kind == "openwebui" {
            "Open WebUI".into()
        } else {
            "RAGFlow".into()
        },
    })
}

#[tauri::command]
pub async fn knowledge_discover_local() -> Result<Vec<DiscoveredSource>, String> {
    let client = Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Could not create local service detector")?;
    let (ragflow, webui, anything) = tokio::join!(
        probe_local_http(&client, "ragflow", "http://127.0.0.1:9380"),
        probe_local_http(&client, "openwebui", "http://127.0.0.1:8080"),
        probe_local_http(&client, "anythingllm", "http://127.0.0.1:3001")
    );
    Ok([ragflow, webui, anything].into_iter().flatten().collect())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeResult {
    id: String,
    document_id: String,
    document_name: String,
    content: String,
    similarity: Option<f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCatalog {
    server_name: String,
    tools: Vec<McpTool>,
    resources: Vec<McpResource>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct McpTool {
    name: String,
    description: String,
    input_schema: Value,
}

#[derive(Debug, Serialize)]
struct McpResource {
    name: String,
    uri: String,
}

pub struct KnowledgeState {
    path: PathBuf,
    sources: Mutex<Vec<StoredSource>>,
    client: Client,
    load_error: Option<String>,
}

impl KnowledgeState {
    pub fn new(app: &AppHandle) -> Result<Self, String> {
        let root = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("knowledge");
        fs::create_dir_all(&root)
            .map_err(|e| format!("Could not create knowledge settings directory: {e}"))?;
        Self::from_path(root.join("sources.json"))
    }

    fn from_path(path: PathBuf) -> Result<Self, String> {
        let (sources, load_error) = match fs::read(&path) {
            Ok(data) => match serde_json::from_slice(&data) {
                Ok(sources) => (sources, None),
                Err(e) => (
                    Vec::new(),
                    Some(format!(
                        "Knowledge source settings are invalid at {}: {e}. The file has been preserved.",
                        path.display()
                    )),
                ),
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (Vec::new(), None),
            Err(e) => (
                Vec::new(),
                Some(format!(
                    "Could not read knowledge source settings at {}: {e}",
                    path.display()
                )),
            ),
        };
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(20))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| format!("Could not create knowledge client: {e}"))?;
        Ok(Self {
            path,
            sources: Mutex::new(sources),
            client,
            load_error,
        })
    }

    fn ensure_loaded(&self) -> Result<(), String> {
        match &self.load_error {
            Some(error) => Err(error.clone()),
            None => Ok(()),
        }
    }

    fn persist(&self, sources: &[StoredSource]) -> Result<(), String> {
        let data = serde_json::to_vec_pretty(sources).map_err(|e| e.to_string())?;
        let temp = self.path.with_extension("json.tmp");
        fs::write(&temp, data).map_err(|e| format!("Could not write knowledge settings: {e}"))?;
        fs::rename(&temp, &self.path).map_err(|e| {
            let _ = fs::remove_file(&temp);
            format!("Could not save knowledge settings: {e}")
        })
    }

    fn source(&self, id: &str) -> Result<StoredSource, String> {
        self.ensure_loaded()?;
        self.sources
            .lock()
            .map_err(|_| "Knowledge settings are unavailable".to_string())?
            .iter()
            .find(|source| source.id == id)
            .cloned()
            .ok_or_else(|| "Knowledge source not found".to_string())
    }

    pub(crate) fn agent_mcp_sources(&self) -> Result<Vec<AgentMcpSource>, String> {
        self.ensure_loaded()?;
        let sources = self
            .sources
            .lock()
            .map_err(|_| "Knowledge settings are unavailable".to_string())?;
        Ok(sources
            .iter()
            .filter(|source| source.kind == "mcp")
            .map(|source| AgentMcpSource {
                id: source.id.clone(),
                name: source.name.clone(),
            })
            .collect())
    }

    pub(crate) async fn agent_mcp_inspect(&self, source_id: &str) -> Result<Value, String> {
        let source = self.source(source_id)?;
        let catalog = inspect_mcp(self, &source).await?;
        serde_json::to_value(catalog).map_err(|_| "Could not read MCP capabilities".into())
    }

    pub(crate) async fn agent_mcp_call(
        &self,
        target: AgentMcpTarget,
        name: String,
        args: Value,
    ) -> Result<Value, String> {
        if self.source(&target.0.id)? != target.0 {
            return Err("The MCP connection changed after approval. Review the new connection and try again.".into());
        }
        call_mcp(self, &target.0, name, args).await
    }

    pub(crate) fn agent_mcp_target(&self, source_id: &str) -> Result<AgentMcpTarget, String> {
        let source = self.source(source_id)?;
        if source.kind != "mcp" {
            return Err("This source is not an MCP service".into());
        }
        Ok(AgentMcpTarget(source))
    }
}

fn validate_base_url(value: &str) -> Result<String, String> {
    let url = Url::parse(value.trim())
        .map_err(|_| "Enter a valid HTTP or HTTPS service URL".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "The service URL must use HTTP(S), without credentials, query or fragment".into(),
        );
    }
    Ok(url.as_str().trim_end_matches('/').to_string())
}

#[tauri::command]
pub fn knowledge_sources_list(
    state: State<'_, KnowledgeState>,
) -> Result<Vec<KnowledgeSource>, String> {
    state.ensure_loaded()?;
    Ok(state
        .sources
        .lock()
        .map_err(|_| "Knowledge settings are unavailable".to_string())?
        .iter()
        .map(KnowledgeSource::from)
        .collect())
}

#[tauri::command]
pub fn knowledge_source_save(
    state: State<'_, KnowledgeState>,
    input: KnowledgeSourceInput,
) -> Result<KnowledgeSource, String> {
    save_source(&state, input)
}

fn save_source(
    state: &KnowledgeState,
    input: KnowledgeSourceInput,
) -> Result<KnowledgeSource, String> {
    state.ensure_loaded()?;
    let name = input.name.trim();
    if name.is_empty() || name.chars().count() > 120 {
        return Err("Enter a source name (up to 120 characters)".into());
    }
    if !matches!(
        input.kind.as_str(),
        "ragflow" | "openwebui" | "anythingllm" | "mcp"
    ) {
        return Err("This knowledge source type is not supported".into());
    }
    let base_url = validate_base_url(&input.base_url)?;
    let mut sources = state
        .sources
        .lock()
        .map_err(|_| "Knowledge settings are unavailable".to_string())?;
    let existing = input
        .id
        .as_deref()
        .map(|id| sources.iter().find(|source| source.id == id))
        .transpose_option()
        .ok_or_else(|| "Knowledge source not found".to_string())?;
    let encrypted_api_key = match input
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|key| !key.is_empty())
    {
        Some(key) => Some(crypto::protect(key)?),
        None => existing
            .filter(|source| source.kind == input.kind && source.base_url == base_url)
            .and_then(|source| source.encrypted_api_key.clone()),
    };
    if encrypted_api_key.is_none() && input.kind != "mcp" {
        return Err("Enter the knowledge service API key".into());
    }
    let source = StoredSource {
        id: input.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        name: name.to_string(),
        kind: input.kind,
        base_url,
        encrypted_api_key,
    };
    let mut next = sources.clone();
    if let Some(index) = next.iter().position(|item| item.id == source.id) {
        next[index] = source.clone();
    } else {
        next.push(source.clone());
    }
    state.persist(&next)?;
    *sources = next;
    Ok(KnowledgeSource::from(&source))
}

// `Some(Some(value))` or `None` are valid; `Some(None)` means the requested id was missing.
trait TransposeOption<T> {
    fn transpose_option(self) -> Option<Option<T>>;
}
impl<T> TransposeOption<T> for Option<Option<T>> {
    fn transpose_option(self) -> Option<Option<T>> {
        match self {
            None => Some(None),
            Some(Some(value)) => Some(Some(value)),
            Some(None) => None,
        }
    }
}

#[tauri::command]
pub fn knowledge_source_remove(
    state: State<'_, KnowledgeState>,
    source_id: String,
) -> Result<(), String> {
    state.ensure_loaded()?;
    let mut sources = state
        .sources
        .lock()
        .map_err(|_| "Knowledge settings are unavailable".to_string())?;
    if !sources.iter().any(|source| source.id == source_id) {
        return Err("Knowledge source not found".into());
    }
    let next: Vec<_> = sources
        .iter()
        .filter(|source| source.id != source_id)
        .cloned()
        .collect();
    state.persist(&next)?;
    *sources = next;
    Ok(())
}

async fn inspect_mcp(state: &KnowledgeState, source: &StoredSource) -> Result<McpCatalog, String> {
    if source.kind != "mcp" {
        return Err("This source is not an MCP service".into());
    }
    let mut config = StreamableHttpClientTransportConfig::with_uri(source.base_url.clone());
    if let Some(key) = source.encrypted_api_key.as_deref() {
        config = config.auth_header(crypto::unprotect(key)?);
    }
    let transport = StreamableHttpClientTransport::with_client(state.client.clone(), config);
    tokio::time::timeout(Duration::from_secs(20), async move {
        let client = ().serve(transport).await.map_err(|_| {
            "Could not connect to the MCP service. Check its URL and credentials.".to_string()
        })?;
        let info = client
            .peer_info()
            .ok_or_else(|| "The MCP service did not provide capabilities".to_string())?;
        let name = info
            .server_info
            .as_ref()
            .map(|server| server.name.clone())
            .unwrap_or_else(|| "MCP".to_string());
        let has_tools = info.capabilities.tools.is_some();
        let has_resources = info.capabilities.resources.is_some();
        let tools = if has_tools {
            client
                .list_all_tools()
                .await
                .map_err(|_| "Could not list MCP tools".to_string())?
                .into_iter()
                .map(|tool| McpTool {
                    name: tool.name.to_string(),
                    description: tool
                        .description
                        .map(|text| text.to_string())
                        .unwrap_or_default(),
                    input_schema: Value::Object((*tool.input_schema).clone()),
                })
                .collect()
        } else {
            Vec::new()
        };
        let resources = if has_resources {
            client
                .list_all_resources()
                .await
                .map_err(|_| "Could not list MCP resources".to_string())?
                .into_iter()
                .map(|resource| McpResource {
                    name: resource.name,
                    uri: resource.uri,
                })
                .collect()
        } else {
            Vec::new()
        };
        let _ = client.cancel().await;
        Ok(McpCatalog {
            server_name: name,
            tools,
            resources,
        })
    })
    .await
    .map_err(|_| "MCP service connection timed out".to_string())?
}

#[tauri::command]
pub async fn knowledge_mcp_inspect(
    state: State<'_, KnowledgeState>,
    source_id: String,
) -> Result<McpCatalog, String> {
    let source = state.source(&source_id)?;
    inspect_mcp(&state, &source).await
}

async fn call_mcp(
    state: &KnowledgeState,
    source: &StoredSource,
    name: String,
    args: Value,
) -> Result<Value, String> {
    if source.kind != "mcp" {
        return Err("This source is not an MCP service".into());
    }
    if name.trim().is_empty() || name.len() > 256 {
        return Err("Select a valid MCP tool".into());
    }
    let arguments = args
        .as_object()
        .ok_or("MCP arguments must be a JSON object")?
        .clone();
    if args.to_string().len() > 32768 {
        return Err("MCP arguments are too large".into());
    }
    let mut config = StreamableHttpClientTransportConfig::with_uri(source.base_url.clone());
    if let Some(key) = source.encrypted_api_key.as_deref() {
        config = config.auth_header(crypto::unprotect(key)?);
    }
    let transport = StreamableHttpClientTransport::with_client(state.client.clone(), config);
    tokio::time::timeout(Duration::from_secs(65), async move {
        let client = ()
            .serve(transport)
            .await
            .map_err(|_| "Could not connect to the MCP service".to_string())?;
        let available = client
            .list_all_tools()
            .await
            .map_err(|_| "Could not list MCP tools".to_string())?;
        if !available.iter().any(|tool| tool.name == name) {
            let _ = client.cancel().await;
            return Err("The selected MCP tool is not available".into());
        }
        let result = client
            .call_tool(CallToolRequestParams::new(name).with_arguments(arguments))
            .await
            .map_err(|error| format!("MCP tool request failed: {error}"))?;
        let _ = client.cancel().await;
        if result.is_error.unwrap_or(false) {
            let detail = result
                .content
                .iter()
                .filter_map(|item| item.as_text())
                .map(|item| item.text.as_str())
                .collect::<Vec<_>>()
                .join("\n");
            return Err(format!(
                "MCP tool returned an error: {}",
                detail.chars().take(1000).collect::<String>()
            ));
        }
        serde_json::to_value(result).map_err(|_| "Could not read MCP tool output".into())
    })
    .await
    .map_err(|_| "MCP tool request timed out".to_string())?
}

#[tauri::command]
pub async fn knowledge_mcp_call(
    state: State<'_, KnowledgeState>,
    source_id: String,
    name: String,
    args: Value,
) -> Result<Value, String> {
    let source = state.source(&source_id)?;
    call_mcp(&state, &source, name, args).await
}

async fn provider_request(
    state: &KnowledgeState,
    source: &StoredSource,
    url: String,
    body: Option<Value>,
) -> Result<Value, String> {
    let token = source
        .encrypted_api_key
        .as_deref()
        .ok_or_else(|| "Knowledge service API key is missing".to_string())
        .and_then(crypto::unprotect)?;
    let mut request = if let Some(body) = body {
        state.client.post(url).json(&body)
    } else {
        state.client.get(url)
    };
    request = request.bearer_auth(token);
    let response = request.send().await.map_err(|_| {
        "Could not connect to the knowledge service. Check its URL and network connection."
            .to_string()
    })?;
    if !response.status().is_success() {
        return Err(format!(
            "Knowledge service returned HTTP {}",
            response.status().as_u16()
        ));
    }
    let data: Value = response
        .json()
        .await
        .map_err(|_| "Knowledge service returned an invalid response".to_string())?;
    if source.kind == "ragflow" && data.get("code").and_then(Value::as_i64) != Some(0) {
        let message = data
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("Request failed");
        return Err(format!(
            "Knowledge service: {}",
            message.chars().take(300).collect::<String>()
        ));
    }
    Ok(data)
}

#[tauri::command]
pub async fn knowledge_spaces_list(
    state: State<'_, KnowledgeState>,
    source_id: String,
) -> Result<Vec<KnowledgeSpace>, String> {
    list_spaces(&state, &source_id).await
}

async fn list_spaces(
    state: &KnowledgeState,
    source_id: &str,
) -> Result<Vec<KnowledgeSpace>, String> {
    let source = state.source(&source_id)?;
    let mut spaces = Vec::new();
    for page in 1..=100 {
        let path = match source.kind.as_str() {
            "ragflow" => format!("/api/v1/datasets?page={page}&page_size=100"),
            "openwebui" => format!("/api/v1/knowledge/?page={page}"),
            "anythingllm" => "/api/v1/workspaces".to_string(),
            _ => return Err("This knowledge source type is not supported".into()),
        };
        let response =
            provider_request(&state, &source, format!("{}{path}", source.base_url), None).await?;
        let items = match source.kind.as_str() {
            "ragflow" => response.get("data"),
            "openwebui" => response
                .get("items")
                .or_else(|| response.as_array().map(|_| &response)),
            "anythingllm" => response.get("workspaces"),
            _ => None,
        }
        .and_then(Value::as_array)
        .ok_or("Knowledge service returned an invalid dataset list")?;
        for item in items {
            if let (Some(id), Some(name)) = (
                item.get(if source.kind == "anythingllm" {
                    "slug"
                } else {
                    "id"
                })
                .and_then(Value::as_str),
                item.get("name").and_then(Value::as_str),
            ) {
                spaces.push(KnowledgeSpace {
                    id: id.to_string(),
                    name: name.to_string(),
                    uses_pipeline: item.get("parse_type").and_then(Value::as_i64) == Some(2)
                        || item
                            .get("pipeline_id")
                            .and_then(Value::as_str)
                            .is_some_and(|id| !id.is_empty()),
                });
            }
        }
        let finished = match source.kind.as_str() {
            "anythingllm" => true,
            "openwebui" => {
                response
                    .get("total")
                    .and_then(Value::as_u64)
                    .map(|total| spaces.len() as u64 >= total)
                    .unwrap_or(true)
                    || items.is_empty()
            }
            _ => items.len() < 100,
        };
        if finished {
            return Ok(spaces);
        }
    }
    Err("Too many knowledge spaces to load; narrow the source permissions".into())
}

fn service_url(source: &StoredSource, segments: &[&str]) -> Result<Url, String> {
    let mut url = Url::parse(&source.base_url).map_err(|_| "Invalid service URL")?;
    url.path_segments_mut()
        .map_err(|_| "Invalid service URL")?
        .pop_if_empty()
        .extend(segments.iter().copied());
    Ok(url)
}

async fn upload_ragflow_data(
    state: &KnowledgeState,
    source: &StoredSource,
    space_id: &str,
    uses_pipeline: bool,
    name: String,
    data: Vec<u8>,
) -> Result<KnowledgeImport, String> {
    if source.kind != "ragflow" {
        return Err("File import is not available for this source type".into());
    }
    if data.is_empty() {
        return Err("The selected file is empty".into());
    }
    if data.len() > 100 * 1024 * 1024 {
        return Err("The selected file exceeds 100 MB".into());
    }
    let token = source
        .encrypted_api_key
        .as_deref()
        .ok_or("Knowledge service API key is missing")
        .map_err(str::to_string)
        .and_then(crypto::unprotect)?;
    let url = service_url(source, &["api", "v1", "datasets", space_id, "documents"])?;
    let form = reqwest::multipart::Form::new().part(
        "file",
        reqwest::multipart::Part::bytes(data).file_name(name.clone()),
    );
    let response = state
        .client
        .post(url)
        .bearer_auth(token)
        .multipart(form)
        .send()
        .await
        .map_err(|_| "Could not upload the file to the knowledge service".to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "File upload returned HTTP {}",
            response.status().as_u16()
        ));
    }
    let value: Value = response
        .json()
        .await
        .map_err(|_| "Knowledge service returned an invalid upload response".to_string())?;
    if value.get("code").and_then(Value::as_i64) != Some(0) {
        return Err(format!(
            "File upload failed: {}",
            value
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("unknown error")
                .chars()
                .take(300)
                .collect::<String>()
        ));
    }
    let id = value.pointer("/data/0/id").and_then(Value::as_str)
        .ok_or("The file was uploaded but the service did not return its document ID; check the service before retrying")?.to_string();
    let (url, body) = if uses_pipeline {
        (
            service_url(source, &["api", "v1", "documents", "ingest"])?,
            json!({"doc_ids": [id], "run": "1", "delete": false}),
        )
    } else {
        (
            service_url(source, &["api", "v1", "datasets", space_id, "chunks"])?,
            json!({"document_ids": [id]}),
        )
    };
    provider_request(state, source, url.to_string(), Some(body)).await.map_err(|error| format!("The file was uploaded but indexing could not be started. It remains on the service; check it there before retrying: {error}"))?;
    Ok(KnowledgeImport {
        name,
        document_id: id,
        status: "submitted".into(),
    })
}

#[tauri::command]
pub async fn knowledge_import_file(
    app: AppHandle,
    state: State<'_, KnowledgeState>,
    source_id: String,
    space_id: String,
) -> Result<Option<KnowledgeImport>, String> {
    let source = state.source(&source_id)?;
    if source.kind != "ragflow" {
        return Err("File import is not available for this source type".into());
    }
    let spaces = list_spaces(&state, &source_id).await?;
    let space = spaces
        .iter()
        .find(|space| space.id == space_id)
        .ok_or("The knowledge space is no longer accessible")?;
    let uses_pipeline = space.uses_pipeline;
    let selected =
        tauri::async_runtime::spawn_blocking(move || app.dialog().file().blocking_pick_file())
            .await
            .map_err(|_| "Could not open the file picker")?;
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|_| "The selected file path is not supported")?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .ok_or("The selected filename is invalid")?
        .to_string();
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|_| "Could not read the selected file")?;
    if !metadata.is_file() || metadata.len() > 100 * 1024 * 1024 {
        return Err("Select a file no larger than 100 MB".into());
    }
    let data = tokio::fs::read(path)
        .await
        .map_err(|_| "Could not read the selected file")?;
    upload_ragflow_data(&state, &source, &space_id, uses_pipeline, name, data)
        .await
        .map(Some)
}

async fn ragflow_document_status(
    state: &KnowledgeState,
    source: &StoredSource,
    space_id: &str,
    document_id: &str,
) -> Result<KnowledgeDocumentStatus, String> {
    if source.kind != "ragflow" {
        return Err("Document status is not available for this source type".into());
    }
    let mut url = service_url(source, &["api", "v1", "datasets", space_id, "documents"])?;
    url.query_pairs_mut()
        .append_pair("id", document_id)
        .append_pair("page", "1")
        .append_pair("page_size", "1");
    let value = provider_request(state, source, url.to_string(), None).await?;
    let doc = value
        .pointer("/data/docs/0")
        .or_else(|| value.pointer("/data/0"))
        .ok_or("The uploaded document is not visible in this knowledge space")?;
    Ok(parse_document_status(doc))
}

fn parse_document_status(doc: &Value) -> KnowledgeDocumentStatus {
    let run = doc
        .get("run")
        .and_then(|value| {
            value
                .as_str()
                .map(str::to_string)
                .or_else(|| value.as_i64().map(|n| n.to_string()))
        })
        .unwrap_or_default()
        .to_uppercase();
    let status = match run.as_str() {
        "3" | "DONE" => "ready",
        "4" | "FAIL" => "failed",
        "2" | "CANCEL" => "cancelled",
        "0" | "UNSTART" | "5" | "SCHEDULE" => "queued",
        "1" | "RUNNING" => "processing",
        _ => "unknown",
    };
    let message = doc
        .get("progress_msg")
        .and_then(|value| {
            value.as_str().or_else(|| {
                value
                    .as_array()
                    .and_then(|messages| messages.last())
                    .and_then(Value::as_str)
            })
        })
        .unwrap_or_default()
        .chars()
        .take(500)
        .collect();
    KnowledgeDocumentStatus {
        status: status.into(),
        message,
    }
}

async fn list_documents(
    state: &KnowledgeState,
    source_id: &str,
    space_id: &str,
    page: u32,
) -> Result<KnowledgeDocumentPage, String> {
    let source = state.source(source_id)?;
    if source.kind != "ragflow" || space_id.trim().is_empty() || page == 0 {
        return Err("Document listing is unavailable for this source or page".into());
    }
    let mut url = service_url(&source, &["api", "v1", "datasets", space_id, "documents"])?;
    url.query_pairs_mut()
        .append_pair("page", &page.to_string())
        .append_pair("page_size", "20");
    let value = provider_request(state, &source, url.to_string(), None).await?;
    let docs = value
        .pointer("/data/docs")
        .or_else(|| value.get("data"))
        .and_then(Value::as_array)
        .ok_or("The knowledge service returned an invalid document list")?;
    let total = value
        .pointer("/data/total")
        .or_else(|| value.pointer("/data/total_datasets"))
        .and_then(Value::as_u64);
    let items: Vec<_> = docs
        .iter()
        .map(|doc| {
            let id = doc
                .get("id")
                .and_then(Value::as_str)
                .ok_or("The knowledge service returned a document without an ID")?;
            let status = parse_document_status(doc);
            Ok(KnowledgeDocument {
                id: id.into(),
                name: doc
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("Document")
                    .into(),
                status: status.status,
                message: status.message,
            })
        })
        .collect::<Result<_, &str>>()?;
    let has_more = total
        .map(|count| (page as u64) * 20 < count)
        .unwrap_or(items.len() == 20);
    Ok(KnowledgeDocumentPage { items, has_more })
}

#[tauri::command]
pub async fn knowledge_documents_list(
    state: State<'_, KnowledgeState>,
    source_id: String,
    space_id: String,
    page: u32,
) -> Result<KnowledgeDocumentPage, String> {
    list_documents(&state, &source_id, &space_id, page).await
}

#[tauri::command]
pub async fn knowledge_document_status(
    state: State<'_, KnowledgeState>,
    source_id: String,
    space_id: String,
    document_id: String,
) -> Result<KnowledgeDocumentStatus, String> {
    let source = state.source(&source_id)?;
    ragflow_document_status(&state, &source, &space_id, &document_id).await
}

#[tauri::command]
pub async fn knowledge_source_search(
    state: State<'_, KnowledgeState>,
    source_id: String,
    space_id: String,
    query: String,
) -> Result<Vec<KnowledgeResult>, String> {
    search_source(&state, &source_id, space_id, query).await
}

async fn search_source(
    state: &KnowledgeState,
    source_id: &str,
    space_id: String,
    query: String,
) -> Result<Vec<KnowledgeResult>, String> {
    let source = state.source(&source_id)?;
    let query = query.trim();
    if query.is_empty() || query.chars().count() > 2000 || space_id.trim().is_empty() {
        return Err("Enter a search query and select a knowledge space".into());
    }
    if source.kind == "openwebui" {
        let response = provider_request(
            &state,
            &source,
            format!("{}/api/v1/retrieval/query/collection", source.base_url),
            Some(json!({"query": query, "collection_names": [space_id], "k": 20})),
        )
        .await?;
        let documents = response
            .pointer("/documents/0")
            .and_then(Value::as_array)
            .ok_or("Knowledge service returned invalid search results")?;
        let metadata = response.pointer("/metadatas/0").and_then(Value::as_array);
        return Ok(documents
            .iter()
            .enumerate()
            .map(|(index, item)| {
                let meta = metadata
                    .and_then(|items| items.get(index))
                    .unwrap_or(&Value::Null);
                KnowledgeResult {
                    id: meta
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    document_id: meta
                        .get("file_id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    document_name: meta
                        .get("name")
                        .or_else(|| meta.get("source"))
                        .and_then(Value::as_str)
                        .unwrap_or("Document")
                        .to_string(),
                    content: item.as_str().unwrap_or_default().to_string(),
                    similarity: None,
                }
            })
            .collect());
    }
    if source.kind == "anythingllm" {
        let mut url = Url::parse(&source.base_url).map_err(|_| "Invalid service URL")?;
        url.path_segments_mut()
            .map_err(|_| "Invalid service URL")?
            .pop_if_empty()
            .extend(["api", "v1", "workspace", &space_id, "vector-search"]);
        let response = provider_request(
            &state,
            &source,
            url.to_string(),
            Some(json!({"query": query, "topN": 20})),
        )
        .await?;
        let items = response
            .get("results")
            .and_then(Value::as_array)
            .ok_or("Knowledge service returned invalid search results")?;
        return Ok(items
            .iter()
            .map(|item| KnowledgeResult {
                id: item
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                document_id: item
                    .pointer("/metadata/docSource")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                document_name: item
                    .pointer("/metadata/title")
                    .or_else(|| item.pointer("/metadata/chunkSource"))
                    .and_then(Value::as_str)
                    .unwrap_or("Document")
                    .to_string(),
                content: item
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                similarity: item.get("score").and_then(Value::as_f64),
            })
            .collect());
    }
    let response = provider_request(
        &state,
        &source,
        format!("{}/api/v1/retrieval", source.base_url),
        Some(json!({ "question": query, "dataset_ids": [space_id], "page": 1, "page_size": 20 })),
    )
    .await?;
    let chunks = response
        .pointer("/data/chunks")
        .and_then(Value::as_array)
        .ok_or("Knowledge service returned invalid search results")?;
    Ok(chunks
        .iter()
        .map(|item| KnowledgeResult {
            id: item
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            document_id: item
                .get("document_id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            document_name: item
                .get("document_keyword")
                .or_else(|| item.get("document_name"))
                .and_then(Value::as_str)
                .unwrap_or("Document")
                .to_string(),
            content: item
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            similarity: item.get("similarity").and_then(Value::as_f64),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::validate_base_url;

    #[test]
    fn accepts_http_origins_and_prefixes() {
        assert_eq!(
            validate_base_url("http://127.0.0.1:9380/").unwrap(),
            "http://127.0.0.1:9380"
        );
        assert_eq!(
            validate_base_url("https://example.org/rag/").unwrap(),
            "https://example.org/rag"
        );
    }

    #[test]
    fn rejects_credentials_fragments_and_non_http_urls() {
        for url in [
            "file:///etc/passwd",
            "http://user:pass@example.org",
            "https://example.org/?token=x",
            "https://example.org/#x",
        ] {
            assert!(validate_base_url(url).is_err(), "{url}");
        }
    }

    #[test]
    fn damaged_settings_do_not_prevent_startup_or_get_overwritten() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("sources.json");
        std::fs::write(&path, b"invalid json").unwrap();
        let state = super::KnowledgeState::from_path(path.clone()).unwrap();
        assert!(state.ensure_loaded().unwrap_err().contains("preserved"));
        assert_eq!(std::fs::read(path).unwrap(), b"invalid json");
    }

    #[cfg(windows)]
    mod provider_integration {
        use super::super::{
            KnowledgeSourceInput, KnowledgeState, call_mcp, inspect_mcp, list_documents,
            list_spaces, ragflow_document_status, save_source, search_source, upload_ragflow_data,
        };
        use serde_json::{Value, json};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;

        #[tokio::test]
        async fn discovers_open_webui_from_its_version_response() {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}", listener.local_addr().unwrap());
            let server = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = [0u8; 4096];
                let count = stream.read(&mut request).await.unwrap();
                assert!(
                    String::from_utf8_lossy(&request[..count]).starts_with("GET /api/version ")
                );
                let body = r#"{"version":"1.0.0","deployment_id":"example"}"#;
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream.write_all(response.as_bytes()).await.unwrap();
            });
            let client = reqwest::Client::builder().no_proxy().build().unwrap();
            let found = super::super::probe_local_http(&client, "openwebui", &base)
                .await
                .unwrap();
            assert_eq!(found.base_url, base);
            server.await.unwrap();
        }

        #[test]
        fn never_reuses_a_credential_for_a_changed_service_address() {
            let temp = tempfile::tempdir().unwrap();
            let state = KnowledgeState::from_path(temp.path().join("sources.json")).unwrap();
            let source = save_source(
                &state,
                KnowledgeSourceInput {
                    id: None,
                    name: "Service".into(),
                    kind: "ragflow".into(),
                    base_url: "http://127.0.0.1:9380".into(),
                    api_key: Some("secret".into()),
                },
            )
            .unwrap();
            let error = save_source(
                &state,
                KnowledgeSourceInput {
                    id: Some(source.id.clone()),
                    name: "Service".into(),
                    kind: "ragflow".into(),
                    base_url: "http://127.0.0.1:9381".into(),
                    api_key: None,
                },
            )
            .unwrap_err();
            assert!(error.contains("API key"));
            assert_eq!(
                state.source(&source.id).unwrap().base_url,
                "http://127.0.0.1:9380"
            );
        }

        #[tokio::test]
        async fn rejects_a_tool_call_when_connection_changed_after_review() {
            let temp = tempfile::tempdir().unwrap();
            let state = KnowledgeState::from_path(temp.path().join("sources.json")).unwrap();
            let source = save_source(
                &state,
                KnowledgeSourceInput {
                    id: None,
                    name: "MCP".into(),
                    kind: "mcp".into(),
                    base_url: "http://127.0.0.1:9382/mcp".into(),
                    api_key: None,
                },
            )
            .unwrap();
            let target = state.agent_mcp_target(&source.id).unwrap();
            save_source(
                &state,
                KnowledgeSourceInput {
                    id: Some(source.id),
                    name: "MCP".into(),
                    kind: "mcp".into(),
                    base_url: "http://127.0.0.1:9383/mcp".into(),
                    api_key: None,
                },
            )
            .unwrap();
            let error = state
                .agent_mcp_call(target, "search".into(), json!({}))
                .await
                .unwrap_err();
            assert!(error.contains("changed after approval"));
        }

        async fn fixture(
            expected: Vec<(&'static str, Value)>,
        ) -> (String, tokio::task::JoinHandle<()>) {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            let task = tokio::spawn(async move {
                for (path, body) in expected {
                    let (mut stream, _) = listener.accept().await.unwrap();
                    let mut request = Vec::new();
                    let mut buffer = [0; 4096];
                    loop {
                        let count = stream.read(&mut buffer).await.unwrap();
                        assert!(count > 0, "incomplete request");
                        request.extend_from_slice(&buffer[..count]);
                        if let Some(end) = request.windows(4).position(|slice| slice == b"\r\n\r\n")
                        {
                            let header = String::from_utf8_lossy(&request[..end]);
                            let length = header
                                .lines()
                                .find_map(|line| {
                                    line.to_ascii_lowercase()
                                        .strip_prefix("content-length:")
                                        .and_then(|n| n.trim().parse::<usize>().ok())
                                })
                                .unwrap_or(0);
                            if request.len() >= end + 4 + length {
                                break;
                            }
                        }
                    }
                    let request = String::from_utf8_lossy(&request);
                    assert!(request.lines().next().unwrap().contains(path));
                    assert!(
                        request
                            .to_ascii_lowercase()
                            .contains("authorization: bearer test-key")
                    );
                    let body = body.to_string();
                    let response = format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    stream.write_all(response.as_bytes()).await.unwrap();
                }
            });
            (url, task)
        }

        #[tokio::test]
        async fn provider_adapters_load_spaces_search_and_encrypt_keys() {
            for (kind, paths, responses) in [
                (
                    "ragflow",
                    ["/api/v1/datasets?", "/api/v1/retrieval"],
                    [
                        json!({"code":0,"data":[{"id":"space","name":"Library"}]}),
                        json!({"code":0,"data":{"chunks":[{"id":"chunk","document_id":"doc","document_keyword":"notes.txt","content":"actual content"}]}}),
                    ],
                ),
                (
                    "openwebui",
                    ["/api/v1/knowledge/?", "/api/v1/retrieval/query/collection"],
                    [
                        json!({"items":[{"id":"space","name":"Library"}],"total":1}),
                        json!({"documents":[["actual content"]],"metadatas":[[{"file_id":"doc","name":"notes.txt"}]]}),
                    ],
                ),
                (
                    "anythingllm",
                    [
                        "/api/v1/workspaces",
                        "/api/v1/workspace/space/vector-search",
                    ],
                    [
                        json!({"workspaces":[{"slug":"space","name":"Library"}]}),
                        json!({"results":[{"id":"chunk","text":"actual content","metadata":{"title":"notes.txt","docSource":"doc"}}]}),
                    ],
                ),
            ] {
                let (url, server) = fixture(vec![
                    (paths[0], responses[0].clone()),
                    (paths[1], responses[1].clone()),
                ])
                .await;
                let temp = tempfile::tempdir().unwrap();
                let path = temp.path().join("sources.json");
                let state = KnowledgeState::from_path(path.clone()).unwrap();
                let source = save_source(
                    &state,
                    KnowledgeSourceInput {
                        id: None,
                        name: "Example".into(),
                        kind: kind.into(),
                        base_url: url,
                        api_key: Some("test-key".into()),
                    },
                )
                .unwrap();
                assert!(!std::fs::read_to_string(&path).unwrap().contains("test-key"));
                let reopened = KnowledgeState::from_path(path).unwrap();
                let spaces = list_spaces(&reopened, &source.id).await.unwrap();
                assert_eq!(spaces[0].name, "Library");
                let hits = search_source(
                    &reopened,
                    &source.id,
                    spaces[0].id.clone(),
                    "test query".into(),
                )
                .await
                .unwrap();
                assert_eq!(hits[0].content, "actual content");
                assert_eq!(hits[0].document_name, "notes.txt");
                server.await.unwrap();
            }
        }

        #[tokio::test]
        async fn reports_backend_business_errors_instead_of_empty_results() {
            let (url, server) = fixture(vec![(
                "/api/v1/datasets?",
                json!({"code": 109, "message": "Access denied"}),
            )])
            .await;
            let temp = tempfile::tempdir().unwrap();
            let state = KnowledgeState::from_path(temp.path().join("sources.json")).unwrap();
            let source = save_source(
                &state,
                KnowledgeSourceInput {
                    id: None,
                    name: "Example".into(),
                    kind: "ragflow".into(),
                    base_url: url,
                    api_key: Some("test-key".into()),
                },
            )
            .unwrap();
            assert!(
                list_spaces(&state, &source.id)
                    .await
                    .unwrap_err()
                    .contains("Access denied")
            );
            server.await.unwrap();
        }

        #[tokio::test]
        async fn uploads_starts_indexing_and_reads_document_status() {
            for (pipeline, parse_path) in [
                (false, "/api/v1/datasets/space/chunks"),
                (true, "/api/v1/documents/ingest"),
            ] {
                let (url, server) = fixture(vec![
                    (
                        "/api/v1/datasets/space/documents",
                        json!({"code":0,"data":[{"id":"doc"}]}),
                    ),
                    (parse_path, json!({"code":0})),
                    (
                        "/api/v1/datasets/space/documents?id=doc",
                        json!({"code":0,"data":{"docs":[{"id":"doc","run":"3"}]}}),
                    ),
                    ("/api/v1/datasets/space/documents?page=1", json!({"code":0,"data":{"docs":[{"id":"doc","name":"notes.txt","run":"3"}],"total":1}})),
                ])
                .await;
                let temp = tempfile::tempdir().unwrap();
                let state = KnowledgeState::from_path(temp.path().join("sources.json")).unwrap();
                let source = save_source(
                    &state,
                    KnowledgeSourceInput {
                        id: None,
                        name: "RAGFlow".into(),
                        kind: "ragflow".into(),
                        base_url: url,
                        api_key: Some("test-key".into()),
                    },
                )
                .unwrap();
                let source = state.source(&source.id).unwrap();
                let uploaded = upload_ragflow_data(
                    &state,
                    &source,
                    "space",
                    pipeline,
                    "notes.txt".into(),
                    b"hello".to_vec(),
                )
                .await
                .unwrap();
                assert_eq!(uploaded.status, "submitted");
                let status =
                    ragflow_document_status(&state, &source, "space", &uploaded.document_id)
                        .await
                        .unwrap();
                assert_eq!(status.status, "ready");
                let page = list_documents(&state, &source.id, "space", 1)
                    .await
                    .unwrap();
                assert_eq!(page.items[0].name, "notes.txt");
                assert_eq!(page.items[0].status, "ready");
                assert!(!page.has_more);
                server.await.unwrap();
            }
        }

        #[tokio::test]
        async fn indexing_error_reports_that_file_was_already_uploaded() {
            let (url, server) = fixture(vec![
                (
                    "/api/v1/datasets/space/documents",
                    json!({"code":0,"data":[{"id":"doc"}]}),
                ),
                (
                    "/api/v1/datasets/space/chunks",
                    json!({"code":102,"message":"parse failed"}),
                ),
            ])
            .await;
            let temp = tempfile::tempdir().unwrap();
            let state = KnowledgeState::from_path(temp.path().join("sources.json")).unwrap();
            let source = save_source(
                &state,
                KnowledgeSourceInput {
                    id: None,
                    name: "RAGFlow".into(),
                    kind: "ragflow".into(),
                    base_url: url,
                    api_key: Some("test-key".into()),
                },
            )
            .unwrap();
            let error = upload_ragflow_data(
                &state,
                &state.source(&source.id).unwrap(),
                "space",
                false,
                "notes.txt".into(),
                b"hello".to_vec(),
            )
            .await
            .unwrap_err();
            assert!(error.contains("file was uploaded"));
            assert!(error.contains("parse failed"));
            server.await.unwrap();
        }

        #[tokio::test]
        async fn discovers_tools_and_resources_from_a_real_mcp_server() {
            use std::io::{BufRead, BufReader};
            use std::process::{Child, Command, Stdio};

            struct ChildGuard(Child);
            impl Drop for ChildGuard {
                fn drop(&mut self) {
                    let _ = self.0.kill();
                    let _ = self.0.wait();
                }
            }

            let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../scripts/fixtures/knowledge-mcp-server.mjs");
            let mut child = ChildGuard(
                Command::new("node")
                    .arg(script)
                    .stdout(Stdio::piped())
                    .spawn()
                    .unwrap(),
            );
            let mut line = String::new();
            BufReader::new(child.0.stdout.take().unwrap())
                .read_line(&mut line)
                .unwrap();
            let port: u16 = line
                .trim()
                .parse()
                .expect("fixture must print its listening port");
            let temp = tempfile::tempdir().unwrap();
            let state = KnowledgeState::from_path(temp.path().join("sources.json")).unwrap();
            let source = save_source(
                &state,
                KnowledgeSourceInput {
                    id: None,
                    name: "MCP".into(),
                    kind: "mcp".into(),
                    base_url: format!("http://127.0.0.1:{port}/mcp"),
                    api_key: None,
                },
            )
            .unwrap();
            let catalog = inspect_mcp(&state, &state.source(&source.id).unwrap())
                .await
                .unwrap();
            assert_eq!(catalog.server_name, "knowledge-test");
            assert_eq!(catalog.tools[0].name, "search_documents");
            assert_eq!(catalog.resources[0].uri, "test://document");
            let result = call_mcp(
                &state,
                &state.source(&source.id).unwrap(),
                "search_documents".into(),
                json!({"query": "meeting"}),
            )
            .await
            .unwrap();
            assert_eq!(
                result.pointer("/content/0/text").and_then(Value::as_str),
                Some("found: meeting")
            );
        }
    }
}
