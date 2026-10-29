//! Static API provider registry plus credential persistence rules.

use std::collections::HashMap;

use crate::asr::crypto;
use crate::asr::state::{AsrState, StoredProvider};
use crate::asr::types::{AsrSelection, ProviderField, ProviderInfo};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FieldKind {
    Text,
    Secret,
}

impl FieldKind {
    fn as_str(self) -> &'static str {
        match self {
            FieldKind::Text => "text",
            FieldKind::Secret => "secret",
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct FieldSpec {
    pub key: &'static str,
    pub label: &'static str,
    pub kind: FieldKind,
    pub placeholder: Option<&'static str>,
    pub required: bool,
    pub default_value: Option<&'static str>,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct ProviderSpec {
    pub id: &'static str,
    pub name: &'static str,
    pub region: &'static str,
    pub description: &'static str,
    pub fields: &'static [FieldSpec],
}

pub(crate) const PROVIDERS: &[ProviderSpec] = &[
    ProviderSpec {
        id: "local-websocket",
        name: "Local WebSocket ASR",
        region: "local",
        description: "Realtime streaming over a configurable WebSocket endpoint",
        fields: &[
            FieldSpec {
                key: "baseUrl",
                label: "WebSocket URL",
                kind: FieldKind::Text,
                placeholder: Some("ws://192.168.0.200:8092/v1/asr/stream"),
                required: true,
                default_value: Some("ws://192.168.0.200:8092/v1/asr/stream"),
            },
            FieldSpec {
                key: "apiKey",
                label: "Bearer token",
                kind: FieldKind::Secret,
                placeholder: None,
                required: true,
                default_value: None,
            },
        ],
    },
    ProviderSpec {
        id: "iflytek",
        name: "iFlytek 讯飞",
        region: "cn",
        description: "Real-time and file transcription",
        fields: &[
            FieldSpec {
                key: "appId",
                label: "App ID",
                kind: FieldKind::Text,
                placeholder: Some("App ID from the iFlytek console"),
                required: true,
                default_value: None,
            },
            FieldSpec {
                key: "apiSecret",
                label: "API Secret",
                kind: FieldKind::Secret,
                placeholder: None,
                required: true,
                default_value: None,
            },
        ],
    },
    ProviderSpec {
        id: "doubao",
        name: "Doubao 豆包",
        region: "cn",
        description: "Volcengine big-model file ASR",
        fields: &[
            FieldSpec {
                key: "appKey",
                label: "App Key",
                kind: FieldKind::Text,
                placeholder: Some("Volcengine speech app key"),
                required: true,
                default_value: None,
            },
            FieldSpec {
                key: "accessKey",
                label: "Access Key",
                kind: FieldKind::Secret,
                placeholder: None,
                required: true,
                default_value: None,
            },
        ],
    },
    ProviderSpec {
        id: "mimo",
        name: "MiMo ASR",
        region: "cn",
        description: "Xiaomi MiMo-V2.5-ASR, OpenAI compatible",
        fields: &[FieldSpec {
            key: "apiKey",
            label: "API Key",
            kind: FieldKind::Secret,
            placeholder: None,
            required: true,
            default_value: None,
        }],
    },
    ProviderSpec {
        id: "openai",
        name: "OpenAI",
        region: "global",
        description: "OpenAI speech-to-text API",
        fields: &[
            FieldSpec {
                key: "apiKey",
                label: "API Key",
                kind: FieldKind::Secret,
                placeholder: None,
                required: true,
                default_value: None,
            },
            FieldSpec {
                key: "baseUrl",
                label: "Base URL",
                kind: FieldKind::Text,
                placeholder: None,
                required: false,
                default_value: Some("https://api.openai.com/v1"),
            },
        ],
    },
    ProviderSpec {
        id: "deepgram",
        name: "Deepgram",
        region: "global",
        description: "Low-latency speech recognition",
        fields: &[FieldSpec {
            key: "apiKey",
            label: "API Key",
            kind: FieldKind::Secret,
            placeholder: None,
            required: true,
            default_value: None,
        }],
    },
    ProviderSpec {
        id: "assemblyai",
        name: "AssemblyAI",
        region: "global",
        description: "Speech AI transcription API",
        fields: &[FieldSpec {
            key: "apiKey",
            label: "API Key",
            kind: FieldKind::Secret,
            placeholder: None,
            required: true,
            default_value: None,
        }],
    },
    ProviderSpec {
        id: "groq",
        name: "Groq",
        region: "global",
        description: "Fast Whisper inference",
        fields: &[FieldSpec {
            key: "apiKey",
            label: "API Key",
            kind: FieldKind::Secret,
            placeholder: None,
            required: true,
            default_value: None,
        }],
    },
    ProviderSpec {
        id: "elevenlabs",
        name: "ElevenLabs",
        region: "global",
        description: "Speech-to-text with speaker diarization",
        fields: &[FieldSpec {
            key: "apiKey",
            label: "API Key",
            kind: FieldKind::Secret,
            placeholder: None,
            required: true,
            default_value: None,
        }],
    },
    ProviderSpec {
        id: "azure",
        name: "Azure Speech",
        region: "global",
        description: "Microsoft Azure AI Speech",
        fields: &[
            FieldSpec {
                key: "apiKey",
                label: "API Key",
                kind: FieldKind::Secret,
                placeholder: None,
                required: true,
                default_value: None,
            },
            FieldSpec {
                key: "region",
                label: "Region",
                kind: FieldKind::Text,
                placeholder: Some("eastasia"),
                required: false,
                default_value: Some("eastasia"),
            },
        ],
    },
];

pub(crate) fn find(provider_id: &str) -> Option<&'static ProviderSpec> {
    PROVIDERS.iter().find(|provider| provider.id == provider_id)
}

/// Resolve public field values, applying defaults and ignoring empty values.
pub(crate) fn resolved_public(
    spec: &ProviderSpec,
    stored: Option<&StoredProvider>,
) -> HashMap<String, String> {
    let mut values = HashMap::new();
    for field in spec.fields {
        if field.kind != FieldKind::Text {
            continue;
        }
        let stored_value = stored
            .and_then(|stored| stored.public.get(field.key))
            .map(|value| value.trim())
            .filter(|value| !value.is_empty());
        if let Some(value) = stored_value {
            values.insert(field.key.to_string(), value.to_string());
        } else if let Some(default) = field.default_value {
            values.insert(field.key.to_string(), default.to_string());
        }
    }
    values
}

pub(crate) fn is_configured(spec: &ProviderSpec, stored: Option<&StoredProvider>) -> bool {
    let public = resolved_public(spec, stored);
    for field in spec.fields {
        match field.kind {
            FieldKind::Text if field.required => {
                let present = public
                    .get(field.key)
                    .is_some_and(|value| !value.trim().is_empty());
                if !present {
                    return false;
                }
            }
            FieldKind::Secret if field.required => {
                let present = stored
                    .and_then(|stored| stored.secrets.get(field.key))
                    .is_some_and(|value| !value.is_empty());
                if !present {
                    return false;
                }
            }
            _ => {}
        }
    }
    true
}

pub(crate) fn provider_info(
    spec: &ProviderSpec,
    stored: Option<&StoredProvider>,
    active: &AsrSelection,
) -> ProviderInfo {
    ProviderInfo {
        id: spec.id.to_string(),
        name: spec.name.to_string(),
        region: spec.region.to_string(),
        description: spec.description.to_string(),
        fields: spec
            .fields
            .iter()
            .map(|field| ProviderField {
                key: field.key.to_string(),
                label: field.label.to_string(),
                kind: field.kind.as_str().to_string(),
                placeholder: field.placeholder.map(str::to_string),
                required: field.required,
                default_value: field.default_value.map(str::to_string),
            })
            .collect(),
        configured: is_configured(spec, stored),
        key_hint: if spec.id == "local-websocket" {
            None
        } else {
            stored.and_then(|stored| stored.key_hint.clone())
        },
        public_values: resolved_public(spec, stored),
        active: active.mode == "api" && active.api_provider_id.as_deref() == Some(spec.id),
    }
}

pub(crate) fn list(state: &AsrState) -> Result<Vec<ProviderInfo>, String> {
    let settings = state.settings_snapshot()?;
    Ok(PROVIDERS
        .iter()
        .map(|spec| provider_info(spec, settings.providers.get(spec.id), &settings.active))
        .collect())
}

/// Save credentials for one provider. Secrets are encrypted with DPAPI and are
/// retained when an empty value is submitted.
pub(crate) fn save(
    state: &AsrState,
    provider_id: &str,
    fields: HashMap<String, String>,
) -> Result<ProviderInfo, String> {
    let spec = find(provider_id).ok_or_else(|| format!("Unknown ASR provider: {provider_id}"))?;

    state.mutate_settings(|settings| {
        let existing = settings.providers.get(spec.id).cloned().unwrap_or_default();
        let mut public = existing.public;
        let mut secrets = existing.secrets;
        let primary = primary_secret(spec);
        let mut submitted_primary_secret: Option<String> = None;

        for field in spec.fields {
            let submitted = fields
                .get(field.key)
                .map(String::as_str)
                .unwrap_or_default();

            match field.kind {
                FieldKind::Text => {
                    let mut value = submitted.trim().to_string();
                    if value.is_empty()
                        && let Some(default) = field.default_value
                    {
                        value = default.to_string();
                    }
                    if value.is_empty() {
                        public.remove(field.key);
                    } else {
                        public.insert(field.key.to_string(), value);
                    }
                }
                FieldKind::Secret => {
                    if submitted.trim().is_empty() {
                        // Keep the previously stored secret.
                        continue;
                    }
                    let encrypted = crypto::protect(submitted)
                        .map_err(|error| format!("Could not encrypt {}: {error}", field.label))?;
                    secrets.insert(field.key.to_string(), encrypted);
                    if primary.is_some_and(|primary| primary.key == field.key) {
                        submitted_primary_secret = Some(submitted.to_string());
                    }
                }
            }
        }

        for field in spec.fields {
            if !field.required {
                continue;
            }
            match field.kind {
                FieldKind::Text => {
                    let present = public
                        .get(field.key)
                        .is_some_and(|value| !value.trim().is_empty());
                    if !present {
                        return Err(format!("{} is required for {}.", field.label, spec.name));
                    }
                }
                FieldKind::Secret => {
                    let present = secrets
                        .get(field.key)
                        .is_some_and(|value| !value.is_empty());
                    if !present {
                        return Err(format!(
                            "{} is required for {}. Enter a value to store it securely.",
                            field.label, spec.name
                        ));
                    }
                }
            }
        }

        public.retain(|key, _| {
            spec.fields
                .iter()
                .any(|field| field.key == key && field.kind == FieldKind::Text)
        });
        secrets.retain(|key, _| {
            spec.fields
                .iter()
                .any(|field| field.key == key && field.kind == FieldKind::Secret)
        });

        let key_hint = if spec.id == "local-websocket" {
            // Do not expose even a token suffix for the local recognizer.
            None
        } else {
            primary.and_then(|primary| {
                if let Some(secret) = submitted_primary_secret.as_deref() {
                    return key_hint(secret);
                }
                secrets
                    .get(primary.key)
                    .and_then(|encrypted| crypto::unprotect(encrypted).ok())
                    .and_then(|plaintext| key_hint(&plaintext))
                    .or_else(|| existing.key_hint.clone())
            })
        };

        let stored = StoredProvider {
            public,
            secrets,
            key_hint,
        };
        settings
            .providers
            .insert(spec.id.to_string(), stored.clone());

        Ok(provider_info(spec, Some(&stored), &settings.active))
    })
}

/// Remove stored credentials. If the provider was active, the ASR selection is
/// reset to `none`.
pub(crate) fn clear(state: &AsrState, provider_id: &str) -> Result<ProviderInfo, String> {
    let spec = find(provider_id).ok_or_else(|| format!("Unknown ASR provider: {provider_id}"))?;

    state.mutate_settings(|settings| {
        settings.providers.remove(spec.id);
        if settings.active.mode == "api"
            && settings.active.api_provider_id.as_deref() == Some(spec.id)
        {
            settings.active = AsrSelection::none();
        }
        Ok(provider_info(spec, None, &settings.active))
    })
}

fn primary_secret(spec: &ProviderSpec) -> Option<&FieldSpec> {
    spec.fields
        .iter()
        .find(|field| field.kind == FieldKind::Secret)
}

fn key_hint(secret: &str) -> Option<String> {
    let trimmed = secret.trim();
    if trimmed.is_empty() {
        return None;
    }
    let chars: Vec<char> = trimmed.chars().collect();
    let start = chars.len().saturating_sub(4);
    Some(chars[start..].iter().collect())
}
