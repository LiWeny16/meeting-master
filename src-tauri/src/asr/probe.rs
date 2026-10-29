//! Lightweight provider connectivity probes.
//!
//! Providers whose credentials can be verified with a cheap GET use a plain
//! request. Providers without such an endpoint receive a one-second silent WAV
//! probe instead.

use std::time::Instant;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use hmac::{Hmac, Mac};
use md5::{Digest, Md5};
use reqwest::{Response, StatusCode};
use serde_json::{Value, json};
use sha1::Sha1;
use uuid::Uuid;

use crate::asr::crypto;
use crate::asr::providers::{FieldKind, ProviderSpec};
use crate::asr::state::{AsrState, StoredProvider};
use crate::asr::types::ProviderTestResult;
use crate::asr::util::{collapse_whitespace, now_unix_ms, truncate_chars};

const MAX_DETAIL_CHARS: usize = 300;
const IFLYTEK_RESULT_URL: &str = "https://raasr.xfyun.cn/v2/api/getResult";

pub(crate) async fn test(
    state: &AsrState,
    spec: &ProviderSpec,
    stored: &StoredProvider,
) -> Result<ProviderTestResult, String> {
    match spec.id {
        "local-websocket" => {
            let config = crate::asr::realtime::config_from_stored(stored)?;
            Ok(crate::asr::realtime::probe_provider(&config).await)
        }
        "iflytek" => probe_iflytek(state, spec, stored).await,
        "doubao" => probe_doubao(state, spec, stored).await,
        "mimo" => probe_mimo(state, spec, stored).await,
        "openai" => probe_openai(state, spec, stored).await,
        "deepgram" => probe_deepgram(state, spec, stored).await,
        "assemblyai" => probe_assemblyai(state, spec, stored).await,
        "groq" => probe_groq(state, spec, stored).await,
        "elevenlabs" => probe_elevenlabs(state, spec, stored).await,
        "azure" => probe_azure(state, spec, stored).await,
        other => Err(format!("Provider {other} has no connectivity probe.")),
    }
}

async fn probe_openai(
    state: &AsrState,
    spec: &ProviderSpec,
    stored: &StoredProvider,
) -> Result<ProviderTestResult, String> {
    let api_key = secret(stored, spec, "apiKey")?;
    let base = public_value(stored, "baseUrl", "https://api.openai.com/v1");
    let base = normalize_base_url(&base);
    let start = Instant::now();
    let response = state
        .http()
        .get(format!("{base}/models"))
        .bearer_auth(&api_key)
        .send()
        .await;
    Ok(simple_response(spec, start, response).await)
}

async fn probe_groq(
    state: &AsrState,
    spec: &ProviderSpec,
    stored: &StoredProvider,
) -> Result<ProviderTestResult, String> {
    let api_key = secret(stored, spec, "apiKey")?;
    let start = Instant::now();
    let response = state
        .http()
        .get("https://api.groq.com/openai/v1/models")
        .bearer_auth(&api_key)
        .send()
        .await;
    Ok(simple_response(spec, start, response).await)
}

async fn probe_deepgram(
    state: &AsrState,
    spec: &ProviderSpec,
    stored: &StoredProvider,
) -> Result<ProviderTestResult, String> {
    let api_key = secret(stored, spec, "apiKey")?;
    let start = Instant::now();
    let response = state
        .http()
        .get("https://api.deepgram.com/v1/projects")
        .header("Authorization", format!("Token {api_key}"))
        .send()
        .await;
    Ok(simple_response(spec, start, response).await)
}

async fn probe_assemblyai(
    state: &AsrState,
    spec: &ProviderSpec,
    stored: &StoredProvider,
) -> Result<ProviderTestResult, String> {
    let api_key = secret(stored, spec, "apiKey")?;
    let start = Instant::now();
    let response = state
        .http()
        .get("https://api.assemblyai.com/v2/transcript?limit=1")
        .header("authorization", api_key)
        .send()
        .await;
    Ok(simple_response(spec, start, response).await)
}

async fn probe_elevenlabs(
    state: &AsrState,
    spec: &ProviderSpec,
    stored: &StoredProvider,
) -> Result<ProviderTestResult, String> {
    let api_key = secret(stored, spec, "apiKey")?;
    let start = Instant::now();
    let response = state
        .http()
        .get("https://api.elevenlabs.io/v1/user")
        .header("xi-api-key", api_key)
        .send()
        .await;
    Ok(simple_response(spec, start, response).await)
}

async fn probe_azure(
    state: &AsrState,
    spec: &ProviderSpec,
    stored: &StoredProvider,
) -> Result<ProviderTestResult, String> {
    let api_key = secret(stored, spec, "apiKey")?;
    let region = public_value(stored, "region", "eastasia");
    let region = region.trim();
    let url = format!("https://{region}.api.cognitive.microsoft.com/sts/v1.0/issueToken");
    let start = Instant::now();
    let response = state
        .http()
        .post(url)
        .header("Ocp-Apim-Subscription-Key", api_key)
        .send()
        .await;
    Ok(simple_response(spec, start, response).await)
}

async fn probe_mimo(
    state: &AsrState,
    spec: &ProviderSpec,
    stored: &StoredProvider,
) -> Result<ProviderTestResult, String> {
    let api_key = secret(stored, spec, "apiKey")?;
    let audio = silence_wav_base64(1);
    let body = json!({
        "model": "mimo-v2.5-asr",
        "messages": [{
            "role": "user",
            "content": [{
                "type": "input_audio",
                "input_audio": {
                    "data": format!("data:audio/wav;base64,{audio}")
                }
            }]
        }],
        "max_tokens": 8
    });

    let start = Instant::now();
    let response = state
        .http()
        .post("https://api.xiaomimimo.com/v1/chat/completions")
        .header("api-key", api_key)
        .json(&body)
        .send()
        .await;
    Ok(simple_response(spec, start, response).await)
}

async fn probe_doubao(
    state: &AsrState,
    spec: &ProviderSpec,
    stored: &StoredProvider,
) -> Result<ProviderTestResult, String> {
    let app_key = required_public(stored, spec, "appKey")?;
    let access_key = secret(stored, spec, "accessKey")?;
    let request_id = Uuid::new_v4().to_string();
    let body = json!({
        "user": { "uid": "meeting-master" },
        "audio": {
            "format": "wav",
            "data": silence_wav_base64(1)
        },
        "request": {
            "model_name": "bigmodel",
            "enable_itn": true,
            "enable_punc": true
        }
    });

    let start = Instant::now();
    let response = state
        .http()
        .post("https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash")
        .header("X-Api-App-Key", app_key)
        .header("X-Api-Access-Key", access_key)
        .header("X-Api-Resource-Id", "volc.bigasr.auc_turbo")
        .header("X-Api-Request-Id", request_id)
        .header("X-Api-Sequence", "-1")
        .json(&body)
        .send()
        .await;

    let response = match response {
        Ok(response) => response,
        Err(error) => return Ok(transport_failure(start, &error)),
    };
    let status = response.status();
    let latency = latency_ms(start);
    let api_code = header_value(&response, "X-Api-Status-Code");
    let api_message = header_value(&response, "X-Api-Message").unwrap_or_default();

    if status.is_success() {
        match api_code.as_deref() {
            Some("20000000") => Ok(ProviderTestResult {
                ok: true,
                message: format!("{} connection verified in {latency} ms.", spec.name),
                latency_ms: latency,
            }),
            Some(code) => {
                let body = response.text().await.unwrap_or_default();
                let detail = if api_message.is_empty() {
                    server_detail(&body)
                } else {
                    api_message
                };
                let message = append_detail(
                    format!("Doubao rejected the probe (code {code}, HTTP {status})."),
                    &detail,
                );
                Ok(failure(message, latency))
            }
            None => Ok(ProviderTestResult {
                ok: true,
                message: format!(
                    "Doubao responded with HTTP {status}, but the X-Api-Status-Code header was missing; credentials could not be fully verified."
                ),
                latency_ms: latency,
            }),
        }
    } else {
        let body = response.text().await.unwrap_or_default();
        let detail = if api_message.is_empty() {
            server_detail(&body)
        } else {
            api_message
        };
        let prefix = if is_auth_failure(status) {
            "Authentication failed"
        } else {
            "Request failed"
        };
        let message = append_detail(format!("{prefix} (HTTP {status})."), &detail);
        Ok(failure(message, latency))
    }
}

async fn probe_iflytek(
    state: &AsrState,
    spec: &ProviderSpec,
    stored: &StoredProvider,
) -> Result<ProviderTestResult, String> {
    let app_id = required_public(stored, spec, "appId")?;
    let api_secret = secret(stored, spec, "apiSecret")?;
    let ts = now_unix_ms().to_string();
    let order_id = Uuid::new_v4().to_string();

    let md5_hex = format!("{:x}", Md5::digest(format!("{app_id}{ts}").as_bytes()));
    let mut mac = Hmac::<Sha1>::new_from_slice(api_secret.as_bytes())
        .map_err(|_| "The iFlytek API secret is not a valid HMAC key.".to_string())?;
    mac.update(md5_hex.as_bytes());
    let signa = BASE64.encode(mac.finalize().into_bytes());

    let start = Instant::now();
    let mut url = reqwest::Url::parse(IFLYTEK_RESULT_URL)
        .map_err(|error| format!("Could not build the iFlytek probe URL: {error}"))?;
    url.query_pairs_mut()
        .append_pair("appId", &app_id)
        .append_pair("ts", &ts)
        .append_pair("signa", &signa)
        .append_pair("orderId", &order_id);
    let response = state.http().get(url).send().await;

    let response = match response {
        Ok(response) => response,
        Err(error) => return Ok(transport_failure(start, &error)),
    };
    let status = response.status();
    let latency = latency_ms(start);
    let body = response.text().await.unwrap_or_default();

    if is_auth_failure(status) {
        return Ok(failure(
            append_detail(
                format!("Authentication failed (HTTP {status})."),
                &server_detail(&body),
            ),
            latency,
        ));
    }

    match serde_json::from_str::<Value>(&body) {
        Ok(value) => {
            let code = value
                .get("code")
                .and_then(scalar_to_string)
                .unwrap_or_else(|| "unknown".to_string());
            let detail = value
                .get("descInfo")
                .or_else(|| value.get("message"))
                .or_else(|| value.get("desc"))
                .and_then(Value::as_str)
                .map(collapse_whitespace)
                .filter(|message| !message.is_empty());

            if code == "26601" {
                let message = append_detail(
                    "Authentication failed: iFlytek rejected the signature (code 26601)."
                        .to_string(),
                    &detail.unwrap_or_default(),
                );
                return Ok(failure(message, latency));
            }

            if status.is_success() {
                let message = append_detail(
                    format!("iFlytek credentials accepted (response code {code})."),
                    &detail.unwrap_or_default(),
                );
                Ok(ProviderTestResult {
                    ok: true,
                    message: truncate_chars(&message, MAX_DETAIL_CHARS),
                    latency_ms: latency,
                })
            } else {
                let message = append_detail(
                    format!("Request failed (HTTP {status}, response code {code})."),
                    &detail.unwrap_or_default(),
                );
                Ok(failure(message, latency))
            }
        }
        Err(_) => {
            let detail = server_detail(&body);
            let message = append_detail(
                format!("iFlytek returned HTTP {status} with a non-JSON body."),
                &detail,
            );
            Ok(ProviderTestResult {
                ok: status.is_success(),
                message: truncate_chars(&message, MAX_DETAIL_CHARS),
                latency_ms: latency,
            })
        }
    }
}

async fn simple_response(
    spec: &ProviderSpec,
    start: Instant,
    response: Result<Response, reqwest::Error>,
) -> ProviderTestResult {
    match response {
        Err(error) => transport_failure(start, &error),
        Ok(response) => {
            let status = response.status();
            let latency = latency_ms(start);
            if status.is_success() {
                ProviderTestResult {
                    ok: true,
                    message: format!("{} connection verified in {latency} ms.", spec.name),
                    latency_ms: latency,
                }
            } else {
                let body = response.text().await.unwrap_or_default();
                let prefix = if is_auth_failure(status) {
                    "Authentication failed"
                } else {
                    "Request failed"
                };
                failure(
                    append_detail(format!("{prefix} (HTTP {status})."), &server_detail(&body)),
                    latency,
                )
            }
        }
    }
}

fn secret(stored: &StoredProvider, spec: &ProviderSpec, key: &str) -> Result<String, String> {
    let field = spec
        .fields
        .iter()
        .find(|field| field.key == key && field.kind == FieldKind::Secret)
        .ok_or_else(|| format!("Unknown credential field {key} for {}.", spec.name))?;
    let encrypted = stored
        .secrets
        .get(key)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("{} is not configured for {}.", field.label, spec.name))?;
    crypto::unprotect(encrypted).map_err(|error| {
        format!(
            "Could not decrypt {} for {}: {error}",
            field.label, spec.name
        )
    })
}

fn required_public(
    stored: &StoredProvider,
    spec: &ProviderSpec,
    key: &str,
) -> Result<String, String> {
    stored
        .public
        .get(key)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("Required field {key} is not configured for {}.", spec.name))
}

fn public_value(stored: &StoredProvider, key: &str, fallback: &str) -> String {
    stored
        .public
        .get(key)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| fallback.to_string())
}

fn normalize_base_url(base: &str) -> String {
    let trimmed = base.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return "https://api.openai.com/v1".to_string();
    }
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    }
}

fn latency_ms(start: Instant) -> u64 {
    start.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
}

fn is_auth_failure(status: StatusCode) -> bool {
    status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN
}

fn transport_failure(start: Instant, error: &reqwest::Error) -> ProviderTestResult {
    let latency = latency_ms(start);
    let message = if error.is_timeout() {
        "The connection test timed out after 30 seconds.".to_string()
    } else if error.is_connect() {
        format!("Could not connect to the provider: {error}")
    } else {
        format!("The connection test failed: {error}")
    };
    failure(message, latency)
}

fn failure(message: String, latency: u64) -> ProviderTestResult {
    ProviderTestResult {
        ok: false,
        message: truncate_chars(&message, MAX_DETAIL_CHARS),
        latency_ms: latency,
    }
}

fn append_detail(mut message: String, detail: &str) -> String {
    let detail = detail.trim();
    if !detail.is_empty() {
        message.push(' ');
        message.push_str(detail);
    }
    message
}

fn header_value(response: &Response, name: &str) -> Option<String> {
    response
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn server_detail(body: &str) -> String {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        for pointer in ["/error/message", "/message", "/detail", "/desc", "/error"] {
            if let Some(text) = value.pointer(pointer).and_then(Value::as_str) {
                let text = collapse_whitespace(text);
                if !text.is_empty() {
                    return truncate_chars(&text, MAX_DETAIL_CHARS);
                }
            }
        }
    }

    truncate_chars(&collapse_whitespace(trimmed), MAX_DETAIL_CHARS)
}

fn scalar_to_string(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

/// Build a canonical 16 kHz, mono, 16-bit PCM WAV containing digital silence.
pub(crate) fn silence_wav(seconds: u32) -> Vec<u8> {
    const SAMPLE_RATE: u32 = 16_000;
    const CHANNELS: u16 = 1;
    const BITS_PER_SAMPLE: u16 = 16;

    let block_align = CHANNELS * (BITS_PER_SAMPLE / 8);
    let byte_rate = SAMPLE_RATE * u32::from(block_align);
    let data_len = SAMPLE_RATE * seconds * u32::from(block_align);
    let mut wav = Vec::with_capacity(44 + data_len as usize);

    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_len).to_le_bytes());
    wav.extend_from_slice(b"WAVE");
    wav.extend_from_slice(b"fmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&CHANNELS.to_le_bytes());
    wav.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    wav.extend_from_slice(&byte_rate.to_le_bytes());
    wav.extend_from_slice(&block_align.to_le_bytes());
    wav.extend_from_slice(&BITS_PER_SAMPLE.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    wav.resize(44 + data_len as usize, 0);
    wav
}

fn silence_wav_base64(seconds: u32) -> String {
    BASE64.encode(silence_wav(seconds))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_wav_has_a_canonical_one_second_header() {
        let wav = silence_wav(1);
        assert_eq!(wav.len(), 44 + 16_000 * 2);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(&wav[12..16], b"fmt ");
        assert_eq!(&wav[36..40], b"data");
        assert_eq!(u32::from_le_bytes(wav[24..28].try_into().unwrap()), 16_000);
        assert_eq!(u16::from_le_bytes(wav[22..24].try_into().unwrap()), 1);
        assert_eq!(u32::from_le_bytes(wav[40..44].try_into().unwrap()), 32_000);
        assert!(wav[44..].iter().all(|byte| *byte == 0));
    }

    #[test]
    fn probe_wav_base64_round_trips() {
        let encoded = silence_wav_base64(1);
        let decoded = BASE64.decode(encoded).expect("valid base64");
        assert_eq!(decoded, silence_wav(1));
    }
}
