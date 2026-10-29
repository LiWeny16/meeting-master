//! Authenticated local WebSocket ASR streaming.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};
use tokio::time::timeout;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::{HeaderValue, header::AUTHORIZATION};

use crate::asr::crypto;
use crate::asr::providers;
use crate::asr::state::{AsrState, StoredProvider};
use crate::asr::types::{AsrStreamStatus, ProviderTestResult, TranscriptUpdate};
use crate::audio::types::{
    ASR_REALTIME_CHUNK_FRAMES, ASR_SAMPLE_RATE, AsrPcmChunk, AudioEventSink, SourceKind,
};
use crate::meetings::TranscriptSegment;
use crate::meetings::transcript::TranscriptStore;

const PROVIDER_ID: &str = "local-websocket";
const DEFAULT_ENDPOINT: &str = "ws://192.168.0.200:8092/v1/asr/stream";
// Capture startup can replay up to ten seconds of buffered audio in a burst.
// A 64-chunk queue held only 2.56 s and could stop ASR before the UI subscribed.
// Keep the queue bounded while allowing startup and a slow final decode to drain.
const CHANNEL_CAPACITY: usize = 512;
const PRE_ROLL_CHUNKS: usize = 4;
const VOICE_RMS_THRESHOLD: f64 = 0.006;
// WASAPI render loopback can arrive tens of dB below the same audio heard on
// the endpoint. Keep this sensitivity source-specific and require both energy
// and a minimum peak so near-zero loopback noise does not open turns.
const SYSTEM_OUTPUT_VOICE_RMS_THRESHOLD: f64 = 0.0003;
const SYSTEM_OUTPUT_VOICE_PEAK_THRESHOLD: f64 = 0.0008;
const SYSTEM_OUTPUT_GAIN_MAX: f32 = 64.0;
const SYSTEM_OUTPUT_TARGET_PEAK: f32 = 0.25;
const SYSTEM_OUTPUT_LOUD_BYPASS_PEAK: f32 = 0.25;
const SYSTEM_OUTPUT_LIMIT_PEAK: f32 = 0.9;
// Allow ordinary thinking pauses within a sentence without closing the turn.
const END_SILENCE_FRAMES: u64 = ASR_SAMPLE_RATE as u64 * 1_500 / 1_000;
const MAX_TURN_FRAMES: u64 = ASR_SAMPLE_RATE as u64 * 15;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const SEND_TIMEOUT: Duration = Duration::from_secs(3);
const FINAL_TIMEOUT: Duration = Duration::from_secs(8);
// Capture delivers at realtime speed. When finalization creates a backlog,
// allow bounded catch-up instead of pacing queued audio at exactly 1x forever.
const MAX_CATCH_UP_MULTIPLIER: u128 = 2;

/// Runtime-only credentials resolved from DPAPI-protected ASR settings.
#[derive(Clone)]
pub struct RealtimeAsrConfig {
    endpoint: String,
    api_key: String,
}

/// The active ASR selection is considered realtime only when the dedicated
/// WebSocket provider is selected and its endpoint and credential are present.
pub fn active_stream_config(state: &AsrState) -> Result<RealtimeAsrConfig, String> {
    let settings = state.settings_snapshot()?;
    if settings.active.mode != "api"
        || settings.active.api_provider_id.as_deref() != Some(PROVIDER_ID)
    {
        return Err("Select Local WebSocket ASR to transcribe a live meeting.".to_string());
    }
    let spec = providers::find(PROVIDER_ID)
        .ok_or_else(|| "The Local WebSocket ASR provider is unavailable.".to_string())?;
    let stored = settings.providers.get(PROVIDER_ID).ok_or_else(|| {
        "Configure the Local WebSocket ASR endpoint and bearer token first.".to_string()
    })?;
    if !providers::is_configured(spec, Some(stored)) {
        return Err(
            "Configure the Local WebSocket ASR endpoint and bearer token first.".to_string(),
        );
    }
    config_from_stored(stored)
}

pub(crate) fn config_from_stored(stored: &StoredProvider) -> Result<RealtimeAsrConfig, String> {
    let endpoint = stored
        .public
        .get("baseUrl")
        .map(String::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(DEFAULT_ENDPOINT)
        .trim()
        .to_string();
    validate_endpoint(&endpoint)?;
    let encrypted = stored
        .secrets
        .get("apiKey")
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "A bearer token is required for Local WebSocket ASR.".to_string())?;
    let api_key = crypto::unprotect(encrypted)
        .map_err(|_| "Could not decrypt the Local WebSocket ASR bearer token.".to_string())?
        .trim()
        .to_string();
    if api_key.trim().is_empty() {
        return Err("A bearer token is required for Local WebSocket ASR.".to_string());
    }
    Ok(RealtimeAsrConfig { endpoint, api_key })
}

fn validate_endpoint(endpoint: &str) -> Result<(), String> {
    let url = reqwest::Url::parse(endpoint)
        .map_err(|_| "Enter a valid ws:// or wss:// realtime ASR endpoint.".to_string())?;
    if !matches!(url.scheme(), "ws" | "wss") || url.host_str().is_none() {
        return Err(
            "The realtime ASR endpoint must use ws:// or wss:// and include a host.".to_string(),
        );
    }
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return Err(
            "Keep credentials in the bearer-token field, not in the WebSocket URL.".to_string(),
        );
    }
    Ok(())
}

fn authenticated_request(
    endpoint: &str,
    api_key: &str,
) -> Result<tokio_tungstenite::tungstenite::handshake::client::Request, String> {
    validate_endpoint(endpoint)?;
    let mut request = endpoint
        .into_client_request()
        .map_err(|_| "Could not prepare the realtime ASR WebSocket request.".to_string())?;
    let authorization = HeaderValue::from_str(&format!("Bearer {api_key}")).map_err(|_| {
        "The realtime ASR bearer token contains invalid header characters.".to_string()
    })?;
    request.headers_mut().insert(AUTHORIZATION, authorization);
    Ok(request)
}

/// Owns the two independent source streams for a meeting. Each stream uses a
/// bounded queue so recognition cannot block or grow behind audio capture.
pub struct RealtimeAsrStreams {
    system_output: SourceStreamHandle,
    microphone: SourceStreamHandle,
    event_sink: Arc<dyn AudioEventSink>,
    meeting_id: String,
    session_id: String,
}

struct SourceStreamHandle {
    sender: Option<mpsc::Sender<StreamMessage>>,
    done: Option<oneshot::Receiver<()>>,
    failed: Arc<AtomicBool>,
}

enum StreamMessage {
    Pcm(AsrPcmChunk),
    Stop,
}

impl RealtimeAsrStreams {
    pub fn spawn(
        config: RealtimeAsrConfig,
        meeting_id: String,
        session_id: String,
        recording_dir: PathBuf,
        started_at_unix_ms: u64,
        event_sink: Arc<dyn AudioEventSink>,
    ) -> Result<Self, String> {
        let transcript_store = Arc::new(TranscriptStore::open(
            recording_dir.join("transcript.jsonl"),
        )?);
        let system_output = spawn_source(
            SourceKind::SystemOutput,
            config.clone(),
            meeting_id.clone(),
            session_id.clone(),
            started_at_unix_ms,
            Arc::clone(&transcript_store),
            Arc::clone(&event_sink),
        );
        let microphone = spawn_source(
            SourceKind::Microphone,
            config,
            meeting_id.clone(),
            session_id.clone(),
            started_at_unix_ms,
            transcript_store,
            Arc::clone(&event_sink),
        );
        Ok(Self {
            system_output,
            microphone,
            event_sink,
            meeting_id,
            session_id,
        })
    }

    pub fn send(&mut self, chunk: AsrPcmChunk) {
        let source = chunk.source;
        let Some(sender) = self.handle_mut(source).sender.as_ref().cloned() else {
            return;
        };
        if self.handle_mut(source).failed.load(Ordering::SeqCst) {
            return;
        }
        match sender.try_send(StreamMessage::Pcm(chunk)) {
            Ok(()) => {}
            Err(mpsc::error::TrySendError::Full(_)) => {
                self.fail_source(
                    source,
                    "Realtime ASR fell behind its bounded audio queue. Recognition stopped; the WAV recording continues.",
                );
            }
            Err(mpsc::error::TrySendError::Closed(_)) => {
                self.fail_source(
                    source,
                    "Realtime ASR disconnected. Recognition stopped; the WAV recording continues.",
                );
            }
        }
    }

    pub fn finish(mut self) {
        self.stop_source(SourceKind::SystemOutput);
        self.stop_source(SourceKind::Microphone);
        self.wait_source(SourceKind::SystemOutput);
        self.wait_source(SourceKind::Microphone);
    }

    fn handle_mut(&mut self, source: SourceKind) -> &mut SourceStreamHandle {
        match source {
            SourceKind::SystemOutput => &mut self.system_output,
            SourceKind::Microphone => &mut self.microphone,
        }
    }

    fn fail_source(&mut self, source: SourceKind, message: &str) {
        let handle = self.handle_mut(source);
        if !handle.failed.swap(true, Ordering::SeqCst) {
            handle.sender.take();
            self.event_sink.emit_asr_stream_status(AsrStreamStatus {
                meeting_id: self.meeting_id.clone(),
                session_id: self.session_id.clone(),
                source,
                state: "error".to_string(),
                message: Some(message.to_string()),
                latency_ms: None,
            });
        }
    }

    fn stop_source(&mut self, source: SourceKind) {
        let handle = self.handle_mut(source);
        if let Some(sender) = handle.sender.take() {
            if !handle.failed.load(Ordering::SeqCst) {
                let _ = sender.blocking_send(StreamMessage::Stop);
            }
        }
    }

    fn wait_source(&mut self, source: SourceKind) {
        let handle = self.handle_mut(source);
        if let Some(done) = handle.done.take() {
            let _ = done.blocking_recv();
        }
    }
}

fn spawn_source(
    source: SourceKind,
    config: RealtimeAsrConfig,
    meeting_id: String,
    session_id: String,
    started_at_unix_ms: u64,
    transcript_store: Arc<TranscriptStore>,
    event_sink: Arc<dyn AudioEventSink>,
) -> SourceStreamHandle {
    let (sender, receiver) = mpsc::channel(CHANNEL_CAPACITY);
    let (done_sender, done) = oneshot::channel();
    let failed = Arc::new(AtomicBool::new(false));
    let worker_failed = Arc::clone(&failed);
    let worker_sink = Arc::clone(&event_sink);
    let context = SourceContext {
        source,
        meeting_id: meeting_id.clone(),
        session_id: session_id.clone(),
        started_at_unix_ms,
    };
    event_sink.emit_asr_stream_status(AsrStreamStatus {
        meeting_id,
        session_id,
        source,
        state: "connecting".to_string(),
        message: None,
        latency_ms: None,
    });
    tauri::async_runtime::spawn(async move {
        if let Err(message) = run_source(
            config,
            context.clone(),
            receiver,
            transcript_store,
            Arc::clone(&worker_sink),
            Arc::clone(&worker_failed),
        )
        .await
        {
            report_error(&context, worker_sink.as_ref(), &worker_failed, &message);
        } else if !worker_failed.load(Ordering::SeqCst) {
            emit_status(&context, worker_sink.as_ref(), "stopped", None, None);
        }
        let _ = done_sender.send(());
    });
    SourceStreamHandle {
        sender: Some(sender),
        done: Some(done),
        failed,
    }
}

#[derive(Clone)]
struct SourceContext {
    source: SourceKind,
    meeting_id: String,
    session_id: String,
    started_at_unix_ms: u64,
}

fn emit_status(
    context: &SourceContext,
    event_sink: &dyn AudioEventSink,
    state: &str,
    message: Option<String>,
    latency_ms: Option<u64>,
) {
    event_sink.emit_asr_stream_status(AsrStreamStatus {
        meeting_id: context.meeting_id.clone(),
        session_id: context.session_id.clone(),
        source: context.source,
        state: state.to_string(),
        message,
        latency_ms,
    });
}

fn report_error(
    context: &SourceContext,
    event_sink: &dyn AudioEventSink,
    failed: &AtomicBool,
    message: &str,
) {
    let already_failed = failed.swap(true, Ordering::SeqCst);
    if !already_failed {
        emit_status(
            context,
            event_sink,
            "error",
            Some(message.to_string()),
            None,
        );
    }
}

async fn run_source(
    config: RealtimeAsrConfig,
    context: SourceContext,
    receiver: mpsc::Receiver<StreamMessage>,
    transcript_store: Arc<TranscriptStore>,
    event_sink: Arc<dyn AudioEventSink>,
    failed: Arc<AtomicBool>,
) -> Result<(), String> {
    let request = authenticated_request(&config.endpoint, &config.api_key)?;
    let connected = timeout(CONNECT_TIMEOUT, connect_async(request)).await;
    let (mut socket, _) = match connected {
        Err(_) => return Err("Realtime ASR connection timed out.".to_string()),
        Ok(Err(_)) => {
            return Err("Could not connect to the configured realtime ASR WebSocket endpoint. Check the endpoint and bearer token.".to_string());
        }
        Ok(Ok(connection)) => connection,
    };
    emit_status(&context, event_sink.as_ref(), "streaming", None, None);
    run_stream_loop(
        &mut socket,
        config,
        context,
        receiver,
        transcript_store,
        event_sink,
        failed,
    )
    .await
}

struct ActiveTurn {
    id: String,
    start_frame: u64,
    sent_frames: u64,
    quiet_frames: u64,
    last_sequence: Option<u64>,
    last_text: String,
    last_stable_text: Option<String>,
    last_frame_end: Option<u64>,
    sent_marks: VecDeque<(u64, Instant)>,
    next_pcm_at: Option<Instant>,
    stream_gain: f32,
}

impl ActiveTurn {
    fn note_sent(&mut self, frames: usize, sent_at: Instant) {
        self.sent_frames = self.sent_frames.saturating_add(frames as u64);
        self.sent_marks.push_back((self.sent_frames, sent_at));
    }

    fn latency_for(&self, frame_end: u64) -> u64 {
        // The service's frame_end is correlated to the nearest outbound chunk
        // boundary. This is an approximate processing latency, not an end-to-end
        // microphone-to-text measurement.
        let sent_at = self
            .sent_marks
            .iter()
            .find(|(frames, _)| *frames >= frame_end)
            .or_else(|| self.sent_marks.back())
            .map(|(_, at)| *at)
            .unwrap_or_else(Instant::now);
        Instant::now()
            .saturating_duration_since(sent_at)
            .as_millis()
            .min(u128::from(u64::MAX)) as u64
    }

    fn accept_server_update(
        &mut self,
        is_final: bool,
        sequence: u64,
        text: &str,
        stable_text: Option<&str>,
    ) -> bool {
        if !is_final {
            if self
                .last_sequence
                .is_some_and(|last_sequence| sequence < last_sequence)
            {
                return false;
            }
            let duplicate = self.last_sequence == Some(sequence)
                && self.last_text == text
                && self.last_stable_text.as_deref() == stable_text;
            if duplicate {
                return false;
            }
        }
        self.last_sequence = Some(
            self.last_sequence
                .map_or(sequence, |last_sequence| last_sequence.max(sequence)),
        );
        self.last_text = text.to_string();
        self.last_stable_text = stable_text.map(str::to_string);
        true
    }

    fn accept_frame_end(&mut self, is_final: bool, frame_end: u64) -> Result<(), String> {
        if frame_end > self.sent_frames {
            return Err(
                "Realtime ASR returned a frame_end beyond the audio already sent.".to_string(),
            );
        }
        if is_final && frame_end != self.sent_frames {
            return Err(
                "Realtime ASR final frame_end did not match the audio sent for the turn."
                    .to_string(),
            );
        }
        if !is_final
            && self
                .last_frame_end
                .is_some_and(|previous| frame_end < previous)
        {
            return Err("Realtime ASR partial frame_end moved backwards.".to_string());
        }
        self.last_frame_end = Some(frame_end);
        Ok(())
    }
}

async fn run_stream_loop<S>(
    socket: &mut S,
    config: RealtimeAsrConfig,
    context: SourceContext,
    mut receiver: mpsc::Receiver<StreamMessage>,
    transcript_store: Arc<TranscriptStore>,
    event_sink: Arc<dyn AudioEventSink>,
    failed: Arc<AtomicBool>,
) -> Result<(), String>
where
    S: futures_util::Sink<Message>
        + futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>>
        + Unpin,
    S::Error: std::fmt::Debug,
{
    let mut pre_roll = VecDeque::with_capacity(PRE_ROLL_CHUNKS);
    let mut active: Option<ActiveTurn> = None;
    let mut turn_index = 0_u64;

    loop {
        if failed.load(Ordering::SeqCst) {
            return Ok(());
        }
        tokio::select! {
            biased;
            frame = socket.next() => {
                let Some(frame) = frame else {
                    return Err("Realtime ASR WebSocket closed unexpectedly.".to_string());
                };
                match frame {
                    Ok(Message::Text(text)) => {
                        if let Some(turn) = active.as_mut() {
                            let is_final = handle_server_text(
                                text.as_str(), turn, &context, &config, &transcript_store,
                                event_sink.as_ref(),
                            )?;
                            if is_final {
                                active = None;
                                pre_roll.clear();
                            }
                        } else if let Some(error) = server_error(text.as_str(), &config.api_key) {
                            return Err(error);
                        }
                    }
                    Ok(Message::Close(_)) => {
                        return Err("Realtime ASR WebSocket closed unexpectedly.".to_string());
                    }
                    Ok(Message::Ping(payload)) => {
                        send_message(socket, Message::Pong(payload)).await?;
                    }
                    Ok(_) => {}
                    Err(_) => return Err("Realtime ASR WebSocket disconnected.".to_string()),
                }
            }
            incoming = receiver.recv() => {
                match incoming {
                    Some(StreamMessage::Pcm(chunk)) => {
                        if let Some(turn) = active.as_mut() {
                            let voice = is_voiced(context.source, &chunk.samples);
                            send_turn_pcm(socket, turn, &chunk.samples).await?;
                            if voice {
                                turn.quiet_frames = 0;
                            } else {
                                turn.quiet_frames = turn.quiet_frames.saturating_add(chunk.samples.len() as u64);
                            }
                            if should_finish_turn(turn.quiet_frames, turn.sent_frames) {
                                let turn = active.take().expect("active turn is present");
                                finish_turn(
                                    socket, turn, &context, &config, &transcript_store,
                                    event_sink.as_ref(),
                                ).await?;
                                pre_roll.clear();
                            }
                        } else if is_voiced(context.source, &chunk.samples) {
                            let mut turn_chunks: Vec<AsrPcmChunk> = pre_roll.drain(..).collect();
                            turn_chunks.push(chunk);
                            let stream_gain = turn_gain(context.source, &turn_chunks);
                            turn_index = turn_index.saturating_add(1);
                            let start_frame = turn_chunks
                                .first()
                                .map(|item| item.start_frame)
                                .unwrap_or_default();
                            let turn_id = format!(
                                "{}-{}-{turn_index}",
                                context.session_id,
                                source_key(context.source),
                            );
                            send_json(socket, json!({
                                "type": "start",
                                "turn_id": turn_id,
                                "sample_rate": ASR_SAMPLE_RATE,
                                "channels": 1,
                                "encoding": "pcm_s16le"
                            })).await?;
                            let mut turn = ActiveTurn {
                                id: turn_id,
                                start_frame,
                                sent_frames: 0,
                                quiet_frames: 0,
                                last_sequence: None,
                                last_text: String::new(),
                                last_stable_text: None,
                                last_frame_end: None,
                                sent_marks: VecDeque::new(),
                                next_pcm_at: None,
                                stream_gain,
                            };
                            for earlier in turn_chunks {
                                send_turn_pcm(socket, &mut turn, &earlier.samples).await?;
                            }
                            active = Some(turn);
                        } else {
                            pre_roll.push_back(chunk);
                            while pre_roll.len() > PRE_ROLL_CHUNKS {
                                pre_roll.pop_front();
                            }
                        }
                    }
                    Some(StreamMessage::Stop) | None => {
                        if let Some(turn) = active.take() {
                            finish_turn(
                                socket, turn, &context, &config, &transcript_store,
                                event_sink.as_ref(),
                            ).await?;
                        }
                        return Ok(());
                    }
                }
            }
        }
    }
}

async fn finish_turn<S>(
    socket: &mut S,
    turn: ActiveTurn,
    context: &SourceContext,
    config: &RealtimeAsrConfig,
    transcript_store: &TranscriptStore,
    event_sink: &dyn AudioEventSink,
) -> Result<(), String>
where
    S: futures_util::Sink<Message>
        + futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>>
        + Unpin,
    S::Error: std::fmt::Debug,
{
    send_json(
        socket,
        json!({
            "type": "end",
            "last_frame": turn.sent_frames,
        }),
    )
    .await?;

    let deadline = Instant::now() + FINAL_TIMEOUT;
    let mut turn = turn;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(
                "Realtime ASR did not return a final transcript before the drain timeout."
                    .to_string(),
            );
        }
        let next = timeout(remaining, socket.next()).await;
        let message = match next {
            Err(_) => {
                return Err(
                    "Realtime ASR did not return a final transcript before the drain timeout."
                        .to_string(),
                );
            }
            Ok(None) => {
                return Err(
                    "Realtime ASR WebSocket closed before the final transcript arrived."
                        .to_string(),
                );
            }
            Ok(Some(Err(_))) => {
                return Err(
                    "Realtime ASR disconnected before the final transcript arrived.".to_string(),
                );
            }
            Ok(Some(Ok(message))) => message,
        };
        match message {
            Message::Text(text) => {
                if handle_server_text(
                    text.as_str(),
                    &mut turn,
                    context,
                    config,
                    transcript_store,
                    event_sink,
                )? {
                    return Ok(());
                }
            }
            Message::Ping(payload) => send_message(socket, Message::Pong(payload)).await?,
            Message::Close(_) => {
                return Err(
                    "Realtime ASR WebSocket closed before the final transcript arrived."
                        .to_string(),
                );
            }
            _ => {}
        }
    }
}

async fn send_json<S>(socket: &mut S, value: Value) -> Result<(), String>
where
    S: futures_util::Sink<Message> + Unpin,
    S::Error: std::fmt::Debug,
{
    send_message(socket, Message::Text(value.to_string().into())).await
}

async fn send_pcm<S>(socket: &mut S, samples: &[i16]) -> Result<(), String>
where
    S: futures_util::Sink<Message> + Unpin,
    S::Error: std::fmt::Debug,
{
    let mut bytes = Vec::with_capacity(samples.len() * 2);
    for sample in samples {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    send_message(socket, Message::Binary(bytes.into())).await
}

async fn send_turn_pcm<S>(
    socket: &mut S,
    turn: &mut ActiveTurn,
    samples: &[i16],
) -> Result<(), String>
where
    S: futures_util::Sink<Message> + Unpin,
    S::Error: std::fmt::Debug,
{
    let due = turn.next_pcm_at.unwrap_or_else(Instant::now);
    tokio::time::sleep(due.saturating_duration_since(Instant::now())).await;
    let send_started = Instant::now();
    if turn.stream_gain > 1.0 {
        let scaled_samples = scale_stream_samples(samples, turn.stream_gain);
        send_pcm(socket, &scaled_samples).await?;
    } else {
        send_pcm(socket, samples).await?;
    }
    let sent_at = Instant::now();
    turn.note_sent(samples.len(), sent_at);
    turn.next_pcm_at = Some(send_started + pcm_send_spacing(samples.len()));
    Ok(())
}

fn pcm_send_spacing(samples: usize) -> Duration {
    let micros =
        (samples as u128 * 1_000_000 / u128::from(ASR_SAMPLE_RATE) / MAX_CATCH_UP_MULTIPLIER)
            .min(u128::from(u64::MAX)) as u64;
    Duration::from_micros(micros)
}

async fn send_message<S>(socket: &mut S, message: Message) -> Result<(), String>
where
    S: futures_util::Sink<Message> + Unpin,
    S::Error: std::fmt::Debug,
{
    match timeout(SEND_TIMEOUT, socket.send(message)).await {
        Ok(Ok(())) => Ok(()),
        _ => Err("Could not send audio to the realtime ASR WebSocket service.".to_string()),
    }
}

fn handle_server_text(
    text: &str,
    turn: &mut ActiveTurn,
    context: &SourceContext,
    config: &RealtimeAsrConfig,
    transcript_store: &TranscriptStore,
    event_sink: &dyn AudioEventSink,
) -> Result<bool, String> {
    let value: Value = serde_json::from_str(text)
        .map_err(|_| "Realtime ASR returned an invalid JSON message.".to_string())?;
    let kind = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if kind == "error" {
        return Err(server_error(text, &config.api_key)
            .unwrap_or_else(|| "Realtime ASR reported a server error.".to_string()));
    }
    if kind != "partial" && kind != "final" {
        return Ok(false);
    }
    let is_final = kind == "final";
    let text_value = value
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let stable_text = value
        .get("stable_text")
        .and_then(Value::as_str)
        .map(str::to_string);
    let sequence = value
        .get("sequence")
        .and_then(Value::as_u64)
        .unwrap_or_else(|| turn.last_sequence.map_or(0, |last| last.saturating_add(1)));
    if !is_final
        && turn
            .last_sequence
            .is_some_and(|last_sequence| sequence < last_sequence)
    {
        return Ok(false);
    }
    let frame_end = value
        .get("frame_end")
        .and_then(Value::as_u64)
        .ok_or_else(|| "Realtime ASR response did not include a valid frame_end.".to_string())?;
    turn.accept_frame_end(is_final, frame_end)?;
    if !turn.accept_server_update(is_final, sequence, &text_value, stable_text.as_deref()) {
        return Ok(false);
    }
    let absolute_end = turn.start_frame.saturating_add(frame_end);
    let started_at_ms = context
        .started_at_unix_ms
        .saturating_add(frame_to_ms(turn.start_frame))
        .min(i64::MAX as u64) as i64;
    let ended_at_ms = context
        .started_at_unix_ms
        .saturating_add(frame_to_ms(absolute_end))
        .min(i64::MAX as u64) as i64;
    let update = TranscriptUpdate {
        meeting_id: context.meeting_id.clone(),
        session_id: context.session_id.clone(),
        turn_id: turn.id.clone(),
        segment_id: turn.id.clone(),
        source: context.source,
        kind: kind.to_string(),
        text: text_value.clone(),
        stable_text,
        sequence,
        start_frame: turn.start_frame,
        end_frame: absolute_end,
        started_at_ms,
        ended_at_ms,
    };
    let latency = turn.latency_for(frame_end);

    if is_final {
        if !text_value.trim().is_empty() {
            let segment = TranscriptSegment {
                id: turn.id.clone(),
                meeting_id: context.meeting_id.clone(),
                session_id: context.session_id.clone(),
                turn_id: turn.id.clone(),
                source: context.source,
                text: text_value,
                sequence,
                start_frame: turn.start_frame,
                end_frame: absolute_end,
                started_at_ms,
                ended_at_ms,
            };
            transcript_store.append(&segment)?;
        }
        event_sink.emit_transcript_update(update);
    } else {
        event_sink.emit_transcript_update(update);
    }
    emit_status(context, event_sink, "streaming", None, Some(latency));
    Ok(is_final)
}

fn server_error(text: &str, api_key: &str) -> Option<String> {
    let value: Value = serde_json::from_str(text).ok()?;
    if value.get("type").and_then(Value::as_str) != Some("error") {
        return None;
    }
    let message = value
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("Realtime ASR reported a server error.");
    let mut message = message.chars().take(300).collect::<String>();
    if !api_key.is_empty() {
        message = message.replace(api_key, "[redacted]");
    }
    Some(message)
}

fn is_voiced(source: SourceKind, samples: &[i16]) -> bool {
    if samples.is_empty() {
        return false;
    }
    let (rms, peak) = signal_level(samples);
    match source {
        SourceKind::Microphone => rms >= VOICE_RMS_THRESHOLD,
        SourceKind::SystemOutput => {
            rms >= SYSTEM_OUTPUT_VOICE_RMS_THRESHOLD && peak >= SYSTEM_OUTPUT_VOICE_PEAK_THRESHOLD
        }
    }
}

fn should_finish_turn(quiet_frames: u64, sent_frames: u64) -> bool {
    quiet_frames >= END_SILENCE_FRAMES || sent_frames >= MAX_TURN_FRAMES
}

fn signal_level(samples: &[i16]) -> (f64, f64) {
    let mut sum_squares = 0.0;
    let mut peak = 0.0_f64;
    for sample in samples {
        let normalized = f64::from(*sample) / 32_768.0;
        sum_squares += normalized * normalized;
        peak = peak.max(normalized.abs());
    }
    ((sum_squares / samples.len() as f64).sqrt(), peak)
}

fn turn_gain(source: SourceKind, chunks: &[AsrPcmChunk]) -> f32 {
    if source != SourceKind::SystemOutput {
        return 1.0;
    }
    let peak = chunks
        .iter()
        .flat_map(|chunk| chunk.samples.iter())
        .map(|sample| sample.unsigned_abs() as f32 / 32_768.0)
        .fold(0.0_f32, f32::max);
    if peak == 0.0 || peak >= SYSTEM_OUTPUT_LOUD_BYPASS_PEAK {
        return 1.0;
    }
    (SYSTEM_OUTPUT_TARGET_PEAK / peak).clamp(1.0, SYSTEM_OUTPUT_GAIN_MAX)
}

fn scale_stream_samples(samples: &[i16], requested_gain: f32) -> Vec<i16> {
    if requested_gain <= 1.0 || samples.is_empty() {
        return samples.to_vec();
    }
    let input_peak = samples
        .iter()
        .map(|sample| sample.unsigned_abs() as f32 / 32_768.0)
        .fold(0.0_f32, f32::max);
    let safe_gain = if input_peak > 0.0 {
        SYSTEM_OUTPUT_LIMIT_PEAK / input_peak
    } else {
        requested_gain
    };
    let gain = requested_gain.min(safe_gain);
    let output_limit = (i16::MAX as f32 * SYSTEM_OUTPUT_LIMIT_PEAK).round();
    samples
        .iter()
        .map(|sample| (f32::from(*sample) * gain).clamp(-output_limit, output_limit) as i16)
        .collect()
}

fn frame_to_ms(frames: u64) -> u64 {
    ((frames as u128 * 1_000) / ASR_SAMPLE_RATE as u128).min(u128::from(u64::MAX)) as u64
}

fn source_key(source: SourceKind) -> &'static str {
    match source {
        SourceKind::SystemOutput => "system-output",
        SourceKind::Microphone => "microphone",
    }
}

/// Authenticated protocol probe: stream digital silence, end the turn, and
/// require a server final instead of accepting a health endpoint response.
pub async fn probe_provider(config: &RealtimeAsrConfig) -> ProviderTestResult {
    let started = Instant::now();
    let failure = |message: String, started: Instant| ProviderTestResult {
        ok: false,
        message,
        latency_ms: started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
    };
    let request = match authenticated_request(&config.endpoint, &config.api_key) {
        Ok(request) => request,
        Err(message) => return failure(message, started),
    };
    let connected = timeout(CONNECT_TIMEOUT, connect_async(request)).await;
    let (mut socket, _) = match connected {
        Err(_) => return failure("Realtime ASR connection timed out.".to_string(), started),
        Ok(Err(_)) => {
            return failure(
                "Could not connect to the realtime ASR WebSocket endpoint. Check the endpoint and bearer token.".to_string(),
                started,
            );
        }
        Ok(Ok(connection)) => connection,
    };
    let turn_id = format!("meeting-master-probe-{}", uuid::Uuid::new_v4());
    if let Err(message) = send_json(
        &mut socket,
        json!({
            "type": "start",
            "turn_id": turn_id,
            "sample_rate": ASR_SAMPLE_RATE,
            "channels": 1,
            "encoding": "pcm_s16le"
        }),
    )
    .await
    {
        return failure(message, started);
    }
    if let Err(message) = send_pcm(&mut socket, &[0_i16; ASR_REALTIME_CHUNK_FRAMES]).await {
        return failure(message, started);
    }
    if let Err(message) = send_json(
        &mut socket,
        json!({ "type": "end", "last_frame": ASR_REALTIME_CHUNK_FRAMES }),
    )
    .await
    {
        return failure(message, started);
    }
    let final_result = timeout(FINAL_TIMEOUT, async {
        loop {
            match socket.next().await {
                Some(Ok(Message::Text(text))) => {
                    let value: Value = match serde_json::from_str(text.as_str()) {
                        Ok(value) => value,
                        Err(_) => return Err("Realtime ASR returned an invalid JSON response.".to_string()),
                    };
                    match value.get("type").and_then(Value::as_str) {
                        Some("final") => {
                            let frame_end = value.get("frame_end").and_then(Value::as_u64);
                            if frame_end != Some(ASR_REALTIME_CHUNK_FRAMES as u64) {
                                return Err("Realtime ASR returned a mismatched final frame_end for the test turn.".to_string());
                            }
                            return Ok(());
                        }
                        Some("error") => {
                            return Err(server_error(text.as_str(), &config.api_key)
                                .unwrap_or_else(|| "Realtime ASR rejected the test turn.".to_string()));
                        }
                        _ => {}
                    }
                }
                Some(Ok(Message::Ping(payload))) => {
                    if let Err(message) = send_message(&mut socket, Message::Pong(payload)).await {
                        return Err(message);
                    }
                }
                Some(Ok(Message::Close(_))) | None => {
                    return Err("Realtime ASR closed before returning a final response.".to_string());
                }
                Some(Err(_)) => return Err("Realtime ASR disconnected before returning a final response.".to_string()),
                _ => {}
            }
        }
    })
    .await;
    match final_result {
        Ok(Ok(())) => ProviderTestResult {
            ok: true,
            message: "Realtime WebSocket authentication and PCM turn finalization verified."
                .to_string(),
            latency_ms: started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
        },
        Ok(Err(message)) => failure(message, started),
        Err(_) => failure(
            "Realtime ASR did not finalize the test turn before the timeout.".to_string(),
            started,
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queued_pcm_can_catch_up_at_a_bounded_rate() {
        assert_eq!(pcm_send_spacing(640), Duration::from_millis(20));
        assert_eq!(pcm_send_spacing(320), Duration::from_millis(10));
        assert_eq!(pcm_send_spacing(0), Duration::ZERO);
    }

    #[tokio::test]
    #[ignore = "requires the configured ASR endpoint and synthetic PCM"]
    async fn sustained_audio_does_not_exhaust_the_live_queue() {
        use crate::audio::types::{AudioEventSink, CaptureLevel, CaptureStatus};
        use std::sync::Mutex;
        struct Sink(Mutex<Vec<TranscriptUpdate>>);
        impl AudioEventSink for Sink {
            fn emit_level(&self, _: CaptureLevel) {}
            fn emit_status(&self, _: CaptureStatus) {}
            fn emit_transcript_update(&self, update: TranscriptUpdate) {
                self.0.lock().unwrap().push(update);
            }
            fn emit_asr_stream_status(&self, _: AsrStreamStatus) {}
        }
        let token = std::env::var("MM_ASR_TEST_TOKEN").expect("test token is required");
        let bytes = std::fs::read(
            std::env::var("MM_ASR_TEST_PCM").expect("synthetic PCM path is required"),
        )
        .expect("read synthetic PCM");
        let samples: Vec<i16> = bytes
            .chunks_exact(2)
            .map(|pair| i16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        assert!(!samples.is_empty());
        let transcript_path = std::env::temp_dir().join(format!(
            "meeting-master-asr-sustained-{}.jsonl",
            std::process::id()
        ));
        let store = Arc::new(TranscriptStore::open(transcript_path.clone()).unwrap());
        let sink = Arc::new(Sink(Mutex::new(Vec::new())));
        let event_sink: Arc<dyn AudioEventSink> = sink.clone();
        let (sender, receiver) = mpsc::channel(CHANNEL_CAPACITY);
        let worker = tokio::spawn(run_source(
            RealtimeAsrConfig {
                endpoint: DEFAULT_ENDPOINT.into(),
                api_key: token,
            },
            SourceContext {
                source: SourceKind::SystemOutput,
                meeting_id: "synthetic-sustained".into(),
                session_id: "synthetic-session".into(),
                started_at_unix_ms: 0,
            },
            receiver,
            store,
            event_sink,
            Arc::new(AtomicBool::new(false)),
        ));
        let mut interval = tokio::time::interval(Duration::from_millis(40));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut minimum_capacity = CHANNEL_CAPACITY;
        // Exceed the previously observed two-minute failure window.
        for index in 0..3_750_u64 {
            interval.tick().await;
            let chunk = (0..ASR_REALTIME_CHUNK_FRAMES)
                .map(|i| samples[(index as usize * ASR_REALTIME_CHUNK_FRAMES + i) % samples.len()])
                .collect();
            sender
                .try_send(StreamMessage::Pcm(AsrPcmChunk {
                    source: SourceKind::SystemOutput,
                    start_frame: index * ASR_REALTIME_CHUNK_FRAMES as u64,
                    samples: chunk,
                }))
                .expect("live audio queue must remain available");
            minimum_capacity = minimum_capacity.min(sender.capacity());
        }
        sender.send(StreamMessage::Stop).await.unwrap();
        let result = timeout(Duration::from_secs(45), worker)
            .await
            .expect("ASR drain timed out")
            .expect("ASR task failed");
        let final_count = sink
            .0
            .lock()
            .unwrap()
            .iter()
            .filter(|item| item.kind == "final" && !item.text.trim().is_empty())
            .count();
        let _ = std::fs::remove_file(transcript_path);
        assert!(
            result.is_ok(),
            "ASR stream returned error: {:?}",
            result.err()
        );
        assert!(
            final_count >= 3,
            "expected multiple nonempty final turns, got {final_count}"
        );
        println!(
            "Sustained synthetic speech: {final_count} final turns, minimum queue capacity {minimum_capacity}"
        );
    }

    #[test]
    fn normal_pause_keeps_turn_open_but_long_pause_and_max_turn_end_it() {
        assert!(!should_finish_turn(
            ASR_SAMPLE_RATE as u64 * 700 / 1_000,
            ASR_SAMPLE_RATE as u64 * 4
        ));
        assert!(!should_finish_turn(
            END_SILENCE_FRAMES - 1,
            ASR_SAMPLE_RATE as u64 * 4
        ));
        assert!(should_finish_turn(
            END_SILENCE_FRAMES,
            ASR_SAMPLE_RATE as u64 * 4
        ));
        assert!(should_finish_turn(0, MAX_TURN_FRAMES));
    }

    #[test]
    fn ten_seconds_of_startup_audio_fits_the_bounded_queue() {
        let (sender, _receiver) = mpsc::channel(CHANNEL_CAPACITY);
        for index in 0..250 {
            assert!(
                sender
                    .try_send(StreamMessage::Pcm(AsrPcmChunk {
                        source: SourceKind::Microphone,
                        start_frame: index * ASR_REALTIME_CHUNK_FRAMES as u64,
                        samples: vec![0; ASR_REALTIME_CHUNK_FRAMES],
                    }))
                    .is_ok(),
                "startup burst should not disconnect ASR"
            );
        }
    }

    #[tokio::test]
    #[ignore = "requires the configured ASR endpoint and generated synthetic PCM"]
    async fn live_synthetic_speech_passes_through_production_stream_loop() {
        use crate::audio::types::{AudioEventSink, CaptureLevel, CaptureStatus};
        use std::sync::Mutex;
        struct Sink(Mutex<Vec<TranscriptUpdate>>);
        impl AudioEventSink for Sink {
            fn emit_level(&self, _: CaptureLevel) {}
            fn emit_status(&self, _: CaptureStatus) {}
            fn emit_transcript_update(&self, update: TranscriptUpdate) {
                self.0.lock().unwrap().push(update);
            }
            fn emit_asr_stream_status(&self, _: AsrStreamStatus) {}
        }
        let token = std::env::var("MM_ASR_TEST_TOKEN").expect("test token is required");
        let path = std::env::var("MM_ASR_TEST_PCM").expect("synthetic PCM path is required");
        let bytes = std::fs::read(path).expect("read synthetic PCM");
        let samples: Vec<i16> = bytes
            .chunks_exact(2)
            .map(|pair| i16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        let transcript_path = std::env::temp_dir().join(format!(
            "meeting-master-asr-probe-{}.jsonl",
            std::process::id()
        ));
        let store = Arc::new(
            TranscriptStore::open(transcript_path.clone()).expect("open temporary transcript"),
        );
        let sink = Arc::new(Sink(Mutex::new(Vec::new())));
        let event_sink: Arc<dyn AudioEventSink> = sink.clone();
        let (sender, receiver) = mpsc::channel(CHANNEL_CAPACITY);
        let context = SourceContext {
            source: SourceKind::SystemOutput,
            meeting_id: "synthetic-asr-test".into(),
            session_id: "synthetic-asr-session".into(),
            started_at_unix_ms: 0,
        };
        let config = RealtimeAsrConfig {
            endpoint: DEFAULT_ENDPOINT.into(),
            api_key: token,
        };
        let worker = tokio::spawn(run_source(
            config,
            context,
            receiver,
            store,
            event_sink,
            Arc::new(AtomicBool::new(false)),
        ));
        for (index, chunk) in samples.chunks(ASR_REALTIME_CHUNK_FRAMES).enumerate() {
            sender
                .send(StreamMessage::Pcm(AsrPcmChunk {
                    source: SourceKind::SystemOutput,
                    start_frame: (index * ASR_REALTIME_CHUNK_FRAMES) as u64,
                    samples: chunk.to_vec(),
                }))
                .await
                .unwrap();
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
        for index in 0..25 {
            sender
                .send(StreamMessage::Pcm(AsrPcmChunk {
                    source: SourceKind::SystemOutput,
                    start_frame: samples.len() as u64 + index * 640,
                    samples: vec![0; 640],
                }))
                .await
                .unwrap();
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
        sender.send(StreamMessage::Stop).await.unwrap();
        let result = timeout(Duration::from_secs(30), worker)
            .await
            .expect("ASR timed out")
            .expect("ASR task failed");
        let updates = sink.0.lock().unwrap().clone();
        let _ = std::fs::remove_file(transcript_path);
        assert!(
            result.is_ok(),
            "production ASR stream returned an error: {:?}",
            result.err()
        );
        assert!(
            updates
                .iter()
                .any(|item| item.kind == "final" && item.text.contains("会议")),
            "synthetic speech did not produce the expected final transcript"
        );
    }

    fn turn() -> ActiveTurn {
        ActiveTurn {
            id: "turn-1".to_string(),
            start_frame: 0,
            sent_frames: 640,
            quiet_frames: 0,
            last_sequence: None,
            last_text: String::new(),
            last_stable_text: None,
            last_frame_end: None,
            sent_marks: VecDeque::new(),
            next_pcm_at: None,
            stream_gain: 1.0,
        }
    }

    #[test]
    fn accepts_sequence_zero_deduplicates_repeat_and_keeps_stable_text_changes() {
        let mut active_turn = turn();
        assert!(active_turn.accept_server_update(false, 0, "hello", Some("hel")));
        assert!(!active_turn.accept_server_update(false, 0, "hello", Some("hel")));
        assert!(active_turn.accept_server_update(false, 0, "hello", Some("hello")));
        assert!(active_turn.accept_server_update(false, 1, "hello there", Some("hello")));
        assert!(active_turn.accept_server_update(true, 1, "hello there", Some("hello there")));
        assert!(active_turn.accept_frame_end(false, 480).is_ok());
        assert!(active_turn.accept_frame_end(true, 640).is_ok());

        let mut invalid_final = turn();
        assert!(invalid_final.accept_frame_end(true, 639).is_err());
    }

    #[test]
    fn system_output_vad_accepts_quiet_speech_without_lowering_mic_threshold() {
        let quiet_speech = vec![30_i16; ASR_REALTIME_CHUNK_FRAMES];
        let near_zero = vec![10_i16; ASR_REALTIME_CHUNK_FRAMES];
        let silence = vec![0_i16; ASR_REALTIME_CHUNK_FRAMES];

        assert!(is_voiced(SourceKind::SystemOutput, &quiet_speech));
        assert!(!is_voiced(SourceKind::Microphone, &quiet_speech));
        assert!(!is_voiced(SourceKind::SystemOutput, &near_zero));
        assert!(!is_voiced(SourceKind::SystemOutput, &silence));
        assert!(!is_voiced(SourceKind::Microphone, &silence));
    }

    #[test]
    fn system_output_gain_is_bounded_source_specific_and_loud_safe() {
        let quiet = AsrPcmChunk {
            source: SourceKind::SystemOutput,
            start_frame: 0,
            samples: vec![117_i16; ASR_REALTIME_CHUNK_FRAMES],
        };
        let loud = AsrPcmChunk {
            samples: vec![8_192_i16; ASR_REALTIME_CHUNK_FRAMES],
            ..quiet.clone()
        };
        assert_eq!(turn_gain(SourceKind::SystemOutput, &[quiet.clone()]), 64.0);
        assert_eq!(turn_gain(SourceKind::SystemOutput, &[loud.clone()]), 1.0);
        assert_eq!(turn_gain(SourceKind::Microphone, &[quiet.clone()]), 1.0);
        assert_eq!(turn_gain(SourceKind::SystemOutput, &[]), 1.0);

        let amplified = scale_stream_samples(&quiet.samples, 64.0);
        assert_eq!(amplified, vec![7_488_i16; ASR_REALTIME_CHUNK_FRAMES]);
        let silence = vec![0_i16; ASR_REALTIME_CHUNK_FRAMES];
        assert_eq!(scale_stream_samples(&silence, 64.0), silence);
        assert_eq!(scale_stream_samples(&loud.samples, 1.0), loud.samples);

        let limited = scale_stream_samples(&[i16::MAX, i16::MIN], 64.0);
        assert!(limited.iter().all(|sample| sample.unsigned_abs() <= 29_490));
        assert_eq!(scale_stream_samples(&[1_000, -1_000], 1.0), [1_000, -1_000]);
    }
}
