use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::asr::realtime::{RealtimeAsrConfig, RealtimeAsrStreams};
use crate::asr::types::AsrStreamStatus;
use crate::audio::capture::{self, CaptureHandle};
use crate::audio::error::AudioError;
use crate::audio::pipeline::RecordingSink;
use crate::audio::types::{
    AudioEventSink, AudioPacket, CaptureEvent, CaptureStartRequest, CaptureStatus,
    DEFAULT_MAX_SECONDS, RecordingConfig, START_TIMEOUT_MS, SessionState, SourceKind, SourceState,
    SourceStatus, TARGET_SAMPLE_RATE,
};

const PUBLISH_INTERVAL: Duration = Duration::from_millis(200);
const LEVEL_INTERVAL: Duration = Duration::from_millis(50);
const STARTUP_WAIT: Duration = Duration::from_millis(START_TIMEOUT_MS);
const MAX_SESSION_SECONDS: u64 = 4 * 3600;
const MIN_SESSION_SECONDS: u64 = 5;
const QPC_TICKS_PER_SECOND: u64 = 10_000_000;
// ~10 seconds of 48 kHz stereo audio held while the sources start up.
const STARTUP_BUFFER_FRAMES: usize = 48_000 * 10;

struct ActiveSession {
    writer: JoinHandle<()>,
    stop_flag: Arc<AtomicBool>,
    started_at: Instant,
}

struct MeetingCapture {
    meeting_id: String,
    realtime_config: Option<RealtimeAsrConfig>,
    asr_unavailable: Option<String>,
}

pub struct AudioCoordinator {
    sink: Arc<dyn AudioEventSink>,
    output_root: PathBuf,
    status: Arc<Mutex<CaptureStatus>>,
    session: Mutex<Option<ActiveSession>>,
}

impl AudioCoordinator {
    pub fn new(sink: Arc<dyn AudioEventSink>, output_root: PathBuf) -> Self {
        Self {
            sink,
            output_root,
            status: Arc::new(Mutex::new(CaptureStatus::default())),
            session: Mutex::new(None),
        }
    }

    pub fn status(&self) -> CaptureStatus {
        lock_status(&self.status).clone()
    }

    pub fn start(&self, request: CaptureStartRequest) -> Result<CaptureStatus, AudioError> {
        self.start_internal(request, None)
    }

    pub fn start_meeting(
        &self,
        request: CaptureStartRequest,
        meeting_id: String,
        realtime_config: Option<RealtimeAsrConfig>,
        asr_unavailable: Option<String>,
    ) -> Result<CaptureStatus, AudioError> {
        self.start_internal(
            request,
            Some(MeetingCapture {
                meeting_id,
                realtime_config,
                asr_unavailable,
            }),
        )
    }

    fn start_internal(
        &self,
        request: CaptureStartRequest,
        meeting: Option<MeetingCapture>,
    ) -> Result<CaptureStatus, AudioError> {
        let CaptureStartRequest {
            system_device_id,
            microphone_device_id,
            application,
            output_dir: requested_output_dir,
            max_seconds: requested_max_seconds,
        } = request;

        let started_at_unix_ms = unix_millis();
        let session_id = format!("session-{started_at_unix_ms}");
        let output_dir = requested_output_dir
            .map(PathBuf::from)
            .unwrap_or_else(|| self.output_root.join(&session_id));
        let max_seconds = requested_max_seconds
            .unwrap_or(DEFAULT_MAX_SECONDS)
            .min(MAX_SESSION_SECONDS)
            .max(MIN_SESSION_SECONDS);

        let starting = CaptureStatus {
            state: SessionState::Starting,
            session_id: Some(session_id.clone()),
            output_dir: Some(output_dir.to_string_lossy().into_owned()),
            started_at_unix_ms: Some(started_at_unix_ms),
            elapsed_ms: 0,
            max_seconds,
            sources: SourceKind::ALL
                .into_iter()
                .map(SourceStatus::pending)
                .collect(),
            message: None,
        };

        {
            let mut session_guard = lock_session(&self.session);
            {
                let status = lock_status(&self.status);
                if matches!(
                    status.state,
                    SessionState::Starting | SessionState::Recording | SessionState::Stopping
                ) {
                    return Err(AudioError::InvalidState(format!(
                        "cannot start capture while state is {:?}",
                        status.state
                    )));
                }
            }
            if let Some(stale) = session_guard.take() {
                stale.stop_flag.store(true, Ordering::SeqCst);
                let _ = stale.writer.join();
            }
            *lock_status(&self.status) = starting.clone();
        }
        self.sink.emit_status(starting.clone());
        if let Some(meeting) = meeting.as_ref()
            && let Some(message) = meeting.asr_unavailable.as_deref()
        {
            for source in SourceKind::ALL {
                self.sink.emit_asr_stream_status(AsrStreamStatus {
                    meeting_id: meeting.meeting_id.clone(),
                    session_id: session_id.clone(),
                    source,
                    state: "error".to_string(),
                    message: Some(message.to_string()),
                    latency_ms: None,
                });
            }
        }

        let config = RecordingConfig {
            session_id,
            output_dir: output_dir.clone(),
            max_seconds,
        };
        let mut sink = match RecordingSink::new(config) {
            Ok(sink) => sink,
            Err(error) => {
                self.publish_failure(&format!(
                    "failed to create recording sink: {}",
                    error.to_message()
                ));
                return Err(error);
            }
        };

        let (sender, receiver) = mpsc::channel::<CaptureEvent>();
        let mut system_handle = match capture::start_capture(
            SourceKind::SystemOutput,
            system_device_id,
            application,
            sender.clone(),
        ) {
            Ok(handle) => handle,
            Err(error) => {
                drop(sender);
                self.publish_failure(&format!(
                    "failed to start system output capture: {}",
                    error.to_message()
                ));
                return Err(error);
            }
        };

        let microphone_handle = match capture::start_capture(
            SourceKind::Microphone,
            microphone_device_id,
            None,
            sender.clone(),
        ) {
            Ok(handle) => handle,
            Err(error) => {
                drop(sender);
                system_handle.request_stop();
                system_handle.join();
                self.publish_failure(&format!(
                    "failed to start microphone capture: {}",
                    error.to_message()
                ));
                return Err(error);
            }
        };
        drop(sender);

        if meeting
            .as_ref()
            .is_some_and(|meeting| meeting.realtime_config.is_some())
        {
            sink.enable_asr_stream();
        }

        let writer_stop_flag = Arc::new(AtomicBool::new(false));
        let writer_stop = Arc::clone(&writer_stop_flag);
        let writer_status = Arc::clone(&self.status);
        let writer_sink = Arc::clone(&self.sink);
        let writer_started_at = Instant::now();
        let writer_output_dir = output_dir.clone();
        let max_deadline = writer_started_at + Duration::from_secs(max_seconds);

        let mut session_guard = lock_session(&self.session);
        let writer = thread::Builder::new()
            .name("audio-writer".to_string())
            .spawn(move || {
                writer_main(
                    sink,
                    [system_handle, microphone_handle],
                    receiver,
                    writer_status,
                    writer_sink,
                    writer_stop,
                    writer_started_at,
                    max_deadline,
                    writer_output_dir,
                    meeting,
                );
            });
        match writer {
            Ok(writer) => {
                *session_guard = Some(ActiveSession {
                    writer,
                    stop_flag: writer_stop_flag,
                    started_at: writer_started_at,
                });
                drop(session_guard);
                Ok(starting)
            }
            Err(error) => {
                drop(session_guard);
                let message = format!("failed to spawn audio writer thread: {error}");
                self.publish_failure(&message);
                Err(AudioError::Capture(message))
            }
        }
    }

    pub fn stop(&self) -> Result<CaptureStatus, AudioError> {
        let session = {
            let mut session_guard = lock_session(&self.session);
            match session_guard.take() {
                Some(session) => session,
                None => return Ok(self.status()),
            }
        };

        let stopping = {
            let mut status = lock_status(&self.status);
            if matches!(
                status.state,
                SessionState::Starting | SessionState::Recording
            ) {
                status.state = SessionState::Stopping;
                Some(status.clone())
            } else {
                None
            }
        };
        if let Some(status) = stopping {
            self.sink.emit_status(status);
        }

        let ActiveSession {
            writer,
            stop_flag,
            started_at,
        } = session;
        stop_flag.store(true, Ordering::SeqCst);
        if writer.join().is_err() {
            let snapshot = {
                let mut status = lock_status(&self.status);
                status.state = SessionState::Failed;
                status.elapsed_ms = started_at.elapsed().as_millis() as u64;
                status.message = Some(format!(
                    "audio writer thread panicked before finalizing (output: {})",
                    status.output_dir.as_deref().unwrap_or("-")
                ));
                status.clone()
            };
            self.sink.emit_status(snapshot.clone());
            return Ok(snapshot);
        }

        Ok(self.status())
    }

    fn publish_failure(&self, message: &str) {
        let snapshot = {
            let mut status = lock_status(&self.status);
            status.state = SessionState::Failed;
            status.message = Some(message.to_string());
            status.clone()
        };
        self.sink.emit_status(snapshot);
    }
}

fn writer_main(
    mut sink: RecordingSink,
    mut handles: [CaptureHandle; 2],
    receiver: Receiver<CaptureEvent>,
    status: Arc<Mutex<CaptureStatus>>,
    event_sink: Arc<dyn AudioEventSink>,
    stop_flag: Arc<AtomicBool>,
    started_at: Instant,
    max_deadline: Instant,
    output_dir: PathBuf,
    meeting: Option<MeetingCapture>,
) {
    let mut realtime_streams: Option<RealtimeAsrStreams> = None;
    let mut failure: Option<String> = None;
    let mut buffered: VecDeque<AudioPacket> = VecDeque::new();
    let mut buffered_frames: usize = 0;
    let mut started = [false; 2];
    let mut terminal = [false; 2];
    let mut last_publish: Option<Instant> = None;
    let mut last_level_emit: [Option<Instant>; 2] = [None; 2];
    let max_duration_hns = max_deadline
        .saturating_duration_since(started_at)
        .as_secs()
        .saturating_mul(QPC_TICKS_PER_SECOND);

    let startup_deadline = Instant::now() + STARTUP_WAIT;
    while !(started[0] && started[1]) && !(terminal[0] && terminal[1]) {
        if stop_flag.load(Ordering::SeqCst) || Instant::now() >= startup_deadline {
            break;
        }
        match receiver.recv_timeout(Duration::from_millis(50)) {
            Ok(CaptureEvent::Packet(packet)) => {
                buffer_packet(&mut buffered, &mut buffered_frames, packet);
            }
            Ok(event) => {
                apply_event(&event, &status, &mut started, &mut terminal);
                publish_status(
                    &status,
                    event_sink.as_ref(),
                    started_at,
                    &mut last_publish,
                    true,
                );
            }
            Err(RecvTimeoutError::Timeout) => {
                publish_status(
                    &status,
                    event_sink.as_ref(),
                    started_at,
                    &mut last_publish,
                    false,
                );
            }
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }

    let mut origin = buffered.iter().map(|packet| packet.qpc_hns).min();
    if origin.is_none() {
        let first_packet_deadline = Instant::now() + STARTUP_WAIT;
        loop {
            if stop_flag.load(Ordering::SeqCst) || Instant::now() >= first_packet_deadline {
                break;
            }
            match receiver.recv_timeout(Duration::from_millis(50)) {
                Ok(CaptureEvent::Packet(packet)) => {
                    origin = Some(match origin {
                        Some(current) => current.min(packet.qpc_hns),
                        None => packet.qpc_hns,
                    });
                    buffer_packet(&mut buffered, &mut buffered_frames, packet);
                    break;
                }
                Ok(event) => {
                    apply_event(&event, &status, &mut started, &mut terminal);
                    publish_status(
                        &status,
                        event_sink.as_ref(),
                        started_at,
                        &mut last_publish,
                        true,
                    );
                }
                Err(RecvTimeoutError::Timeout) => {
                    publish_status(
                        &status,
                        event_sink.as_ref(),
                        started_at,
                        &mut last_publish,
                        false,
                    );
                }
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
    }

    let Some(origin) = origin else {
        finish_session(
            sink,
            &mut handles,
            &status,
            Arc::clone(&event_sink),
            started_at,
            &output_dir,
            failure,
            realtime_streams,
            receiver,
            meeting,
            max_duration_hns,
            None,
        );
        return;
    };

    if let Err(error) = sink.begin(origin) {
        failure = Some(format!("failed to begin recording: {}", error.to_message()));
    } else {
        realtime_streams = spawn_asr_streams(&sink, meeting.as_ref(), &output_dir, &event_sink);
        send_ready_asr_chunks(&mut sink, realtime_streams.as_mut());
        {
            let mut status = lock_status(&status);
            status.state = SessionState::Recording;
            status.message = None;
        }
        publish_status(
            &status,
            event_sink.as_ref(),
            started_at,
            &mut last_publish,
            true,
        );

        let mut feed_error = false;
        while let Some(packet) = buffered.pop_front() {
            buffered_frames = buffered_frames.saturating_sub(packet.frames as usize);
            let Some(packet) =
                clip_packet_to_qpc_end(&sink, packet, origin.saturating_add(max_duration_hns))
            else {
                continue;
            };
            let source = packet.source;
            if let Err(error) = push_packet(
                &mut sink,
                &status,
                event_sink.as_ref(),
                packet,
                &mut last_level_emit,
                realtime_streams.as_mut(),
            ) {
                let message = format!(
                    "failed to write {} audio: {}",
                    source.label(),
                    error.to_message()
                );
                mark_failed(&status, source, &message);
                failure = Some(message);
                feed_error = true;
                break;
            }
        }

        if !feed_error {
            loop {
                if stop_flag.load(Ordering::SeqCst) || Instant::now() >= max_deadline {
                    break;
                }
                match receiver.recv_timeout(Duration::from_millis(200)) {
                    Ok(CaptureEvent::Packet(packet)) => {
                        let Some(packet) = clip_packet_to_qpc_end(
                            &sink,
                            packet,
                            origin.saturating_add(max_duration_hns),
                        ) else {
                            continue;
                        };
                        let source = packet.source;
                        if let Err(error) = push_packet(
                            &mut sink,
                            &status,
                            event_sink.as_ref(),
                            packet,
                            &mut last_level_emit,
                            realtime_streams.as_mut(),
                        ) {
                            let message = format!(
                                "failed to write {} audio: {}",
                                source.label(),
                                error.to_message()
                            );
                            mark_failed(&status, source, &message);
                            failure = Some(message);
                            break;
                        }
                        publish_status(
                            &status,
                            event_sink.as_ref(),
                            started_at,
                            &mut last_publish,
                            false,
                        );
                    }
                    Ok(event) => {
                        apply_event(&event, &status, &mut started, &mut terminal);
                        publish_status(
                            &status,
                            event_sink.as_ref(),
                            started_at,
                            &mut last_publish,
                            true,
                        );
                        if terminal[0] && terminal[1] {
                            break;
                        }
                    }
                    Err(RecvTimeoutError::Timeout) => {
                        publish_status(
                            &status,
                            event_sink.as_ref(),
                            started_at,
                            &mut last_publish,
                            false,
                        );
                    }
                    Err(RecvTimeoutError::Disconnected) => break,
                }
            }
        }
    }

    if failure.is_none() {
        failure = lock_status(&status)
            .sources
            .iter()
            .find(|source| source.state == SourceState::Failed)
            .and_then(|source| source.message.clone());
    }

    finish_session(
        sink,
        &mut handles,
        &status,
        Arc::clone(&event_sink),
        started_at,
        &output_dir,
        failure,
        realtime_streams,
        receiver,
        meeting,
        max_duration_hns,
        Some(origin),
    );
}

fn finish_session(
    mut sink: RecordingSink,
    handles: &mut [CaptureHandle; 2],
    status: &Arc<Mutex<CaptureStatus>>,
    event_sink: Arc<dyn AudioEventSink>,
    started_at: Instant,
    output_dir: &PathBuf,
    mut failure: Option<String>,
    mut realtime_streams: Option<RealtimeAsrStreams>,
    receiver: Receiver<CaptureEvent>,
    meeting: Option<MeetingCapture>,
    max_duration_hns: u64,
    mut origin_qpc_hns: Option<u64>,
) {
    for handle in handles.iter() {
        handle.request_stop();
    }
    for handle in handles.iter_mut() {
        handle.join();
    }

    // Capture sends are unbounded, so producers can be joined before draining.
    // Replay every packet accepted by the channel before finalizing the WAV and
    // the corresponding ASR turns.
    let mut tail_packets = VecDeque::new();
    let mut tail_started = [false; 2];
    let mut tail_terminal = [false; 2];
    while let Ok(event) = receiver.try_recv() {
        match event {
            CaptureEvent::Packet(packet) => {
                origin_qpc_hns = Some(
                    origin_qpc_hns.map_or(packet.qpc_hns, |origin| origin.min(packet.qpc_hns)),
                );
                tail_packets.push_back(packet);
            }
            event => apply_event(&event, status, &mut tail_started, &mut tail_terminal),
        }
    }

    if !sink.is_started() {
        if let Some(origin) = origin_qpc_hns {
            if let Err(error) = sink.begin(origin) {
                failure.get_or_insert_with(|| {
                    format!("failed to begin recording: {}", error.to_message())
                });
            } else {
                realtime_streams =
                    spawn_asr_streams(&sink, meeting.as_ref(), output_dir, &event_sink);
                send_ready_asr_chunks(&mut sink, realtime_streams.as_mut());
            }
        } else {
            failure.get_or_insert_with(|| "no audio packets received".to_string());
        }
    }

    if let Some(origin) = sink.origin_qpc_hns() {
        let qpc_end = origin.saturating_add(max_duration_hns);
        let mut last_level_emit = [None; 2];
        while let Some(packet) = tail_packets.pop_front() {
            let Some(packet) = clip_packet_to_qpc_end(&sink, packet, qpc_end) else {
                continue;
            };
            let source = packet.source;
            if let Err(error) = push_packet(
                &mut sink,
                status,
                event_sink.as_ref(),
                packet,
                &mut last_level_emit,
                realtime_streams.as_mut(),
            ) {
                let message = format!(
                    "failed to write {} audio: {}",
                    source.label(),
                    error.to_message()
                );
                mark_failed(status, source, &message);
                failure.get_or_insert(message);
            }
        }
    }

    let duration_ms = started_at.elapsed().as_millis() as u64;
    let finalized = sink.finalize_with_asr();
    let (state, message) = match finalized {
        Ok((summary, chunks)) => {
            if let Some(streams) = realtime_streams.as_mut() {
                for chunk in chunks {
                    streams.send(chunk);
                }
            }
            if let Some(streams) = realtime_streams.take() {
                streams.finish();
            }
            match failure {
                Some(reason) => (
                    SessionState::Failed,
                    format!("{reason}; partial recording at {}", summary.output_dir),
                ),
                None => (
                    SessionState::Completed,
                    format!("recording saved to {}", summary.output_dir),
                ),
            }
        }
        Err(error) => {
            if let Some(streams) = realtime_streams.take() {
                streams.finish();
            }
            match failure {
                Some(reason) => (
                    SessionState::Failed,
                    format!(
                        "{reason}; finalize failed: {} (output: {})",
                        error.to_message(),
                        output_dir.display()
                    ),
                ),
                None => (
                    SessionState::Failed,
                    format!(
                        "finalize failed: {} (output: {})",
                        error.to_message(),
                        output_dir.display()
                    ),
                ),
            }
        }
    };

    let final_status = {
        let mut status = lock_status(status);
        status.state = state;
        status.elapsed_ms = duration_ms;
        status.message = Some(message);
        for source in &mut status.sources {
            if source.state != SourceState::Failed {
                source.state = SourceState::Stopped;
            }
        }
        status.clone()
    };
    event_sink.emit_status(final_status);
}

fn spawn_asr_streams(
    sink: &RecordingSink,
    meeting: Option<&MeetingCapture>,
    output_dir: &PathBuf,
    event_sink: &Arc<dyn AudioEventSink>,
) -> Option<RealtimeAsrStreams> {
    let meeting = meeting?;
    let config = meeting.realtime_config.clone()?;
    match RealtimeAsrStreams::spawn(
        config,
        meeting.meeting_id.clone(),
        sink.session_id().to_string(),
        output_dir.clone(),
        sink.started_at_unix_ms(),
        Arc::clone(event_sink),
    ) {
        Ok(streams) => Some(streams),
        Err(message) => {
            for source in SourceKind::ALL {
                event_sink.emit_asr_stream_status(AsrStreamStatus {
                    meeting_id: meeting.meeting_id.clone(),
                    session_id: sink.session_id().to_string(),
                    source,
                    state: "error".to_string(),
                    message: Some(message.clone()),
                    latency_ms: None,
                });
            }
            None
        }
    }
}

fn clip_packet_to_qpc_end(
    sink: &RecordingSink,
    mut packet: AudioPacket,
    qpc_end_hns: u64,
) -> Option<AudioPacket> {
    if packet.frames == 0 {
        return None;
    }
    let packet_start_hns = if packet.timestamp_error {
        sink.source_end_qpc_hns(packet.source)
            .or_else(|| sink.origin_qpc_hns())
            .unwrap_or(packet.qpc_hns)
    } else {
        packet.qpc_hns
    };
    if packet_start_hns >= qpc_end_hns {
        return None;
    }

    let available_frames = (((qpc_end_hns - packet_start_hns) as u128
        * u128::from(TARGET_SAMPLE_RATE))
        / u128::from(QPC_TICKS_PER_SECOND)) as u64;
    let frames = u64::from(packet.frames).min(available_frames) as u32;
    if frames == 0 {
        return None;
    }
    if frames < packet.frames {
        packet.frames = frames;
        packet.samples.truncate(frames as usize * 2);
    }
    Some(packet)
}

fn push_packet(
    sink: &mut RecordingSink,
    status: &Mutex<CaptureStatus>,
    event_sink: &dyn AudioEventSink,
    packet: AudioPacket,
    last_level_emit: &mut [Option<Instant>; 2],
    realtime_streams: Option<&mut RealtimeAsrStreams>,
) -> Result<(), AudioError> {
    let index = source_index(packet.source);
    let frames = u64::from(packet.frames);
    let silent = packet.silent;
    let discontinuity = packet.discontinuity;
    let qpc_hns = packet.qpc_hns;

    let level = sink.push(packet)?;
    send_ready_asr_chunks(sink, realtime_streams);

    {
        let mut status = lock_status(status);
        if let Some(source) = status.sources.get_mut(index) {
            source.packets = source.packets.saturating_add(1);
            source.frames = source.frames.saturating_add(frames);
            if silent {
                source.silent_frames = source.silent_frames.saturating_add(frames);
            }
            if discontinuity {
                source.discontinuities = source.discontinuities.saturating_add(1);
            }
            source.last_packet_qpc_hns = Some(qpc_hns);
            if let Some(level) = level.as_ref() {
                source.rms = level.rms;
                source.peak = level.peak;
            }
        }
    }

    if let Some(level) = level {
        let now = Instant::now();
        let due = match last_level_emit[index] {
            Some(previous) => now.duration_since(previous) >= LEVEL_INTERVAL,
            None => true,
        };
        if due {
            event_sink.emit_level(level);
            last_level_emit[index] = Some(now);
        }
    }
    Ok(())
}

fn send_ready_asr_chunks(sink: &mut RecordingSink, streams: Option<&mut RealtimeAsrStreams>) {
    let chunks = sink.drain_asr_chunks();
    if let Some(streams) = streams {
        for chunk in chunks {
            streams.send(chunk);
        }
    }
}

fn apply_event(
    event: &CaptureEvent,
    status: &Mutex<CaptureStatus>,
    started: &mut [bool; 2],
    terminal: &mut [bool; 2],
) {
    let mut status = lock_status(status);
    match event {
        CaptureEvent::Started {
            source,
            device_id,
            device_name,
        } => {
            let index = source_index(*source);
            if terminal[index] {
                return;
            }
            started[index] = true;
            if let Some(source_status) = status.sources.get_mut(index) {
                source_status.state = SourceState::Recording;
                source_status.device_id = Some(device_id.clone());
                source_status.device_name = Some(device_name.clone());
                source_status.message = None;
            }
        }
        CaptureEvent::Failed { source, message } => {
            let index = source_index(*source);
            terminal[index] = true;
            if let Some(source_status) = status.sources.get_mut(index) {
                source_status.state = SourceState::Failed;
                source_status.message = Some(message.clone());
            }
        }
        CaptureEvent::Finished { source, reason } => {
            let index = source_index(*source);
            terminal[index] = true;
            if let Some(source_status) = status.sources.get_mut(index) {
                if source_status.state != SourceState::Failed {
                    source_status.state = SourceState::Stopped;
                    source_status.message = Some(reason.clone());
                }
            }
        }
        CaptureEvent::Packet(_) => {}
    }
}

fn mark_failed(status: &Mutex<CaptureStatus>, source: SourceKind, message: &str) {
    let mut status = lock_status(status);
    status.state = SessionState::Failed;
    status.message = Some(message.to_string());
    if let Some(source_status) = status.sources.get_mut(source_index(source)) {
        source_status.state = SourceState::Failed;
        source_status.message = Some(message.to_string());
    }
}

fn publish_status(
    status: &Mutex<CaptureStatus>,
    event_sink: &dyn AudioEventSink,
    started_at: Instant,
    last_publish: &mut Option<Instant>,
    force: bool,
) {
    let now = Instant::now();
    if !force {
        if let Some(last) = *last_publish {
            if now.duration_since(last) < PUBLISH_INTERVAL {
                return;
            }
        }
    }

    let snapshot = {
        let mut status = lock_status(status);
        status.elapsed_ms = started_at.elapsed().as_millis() as u64;
        status.clone()
    };
    event_sink.emit_status(snapshot);
    *last_publish = Some(now);
}

fn buffer_packet(
    queue: &mut VecDeque<AudioPacket>,
    buffered_frames: &mut usize,
    packet: AudioPacket,
) {
    let packet_frames = packet.frames as usize;
    let mut dropped = 0usize;
    while *buffered_frames + packet_frames > STARTUP_BUFFER_FRAMES {
        let Some(oldest) = queue.pop_front() else {
            break;
        };
        *buffered_frames = buffered_frames.saturating_sub(oldest.frames as usize);
        dropped += 1;
    }
    if packet_frames <= STARTUP_BUFFER_FRAMES {
        *buffered_frames += packet_frames;
        queue.push_back(packet);
    }
    if dropped > 0 {
        log::warn!("audio startup buffer full; dropped {dropped} oldest packet(s)");
    }
}

fn source_index(source: SourceKind) -> usize {
    match source {
        SourceKind::SystemOutput => 0,
        SourceKind::Microphone => 1,
    }
}

fn lock_status(status: &Mutex<CaptureStatus>) -> MutexGuard<'_, CaptureStatus> {
    status
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn lock_session(session: &Mutex<Option<ActiveSession>>) -> MutexGuard<'_, Option<ActiveSession>> {
    session
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn unix_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tail_packet_is_clipped_to_capture_duration() {
        let directory =
            std::env::temp_dir().join(format!("meeting-master-asr-tail-{}", uuid::Uuid::new_v4()));
        let mut sink = RecordingSink::new(RecordingConfig {
            session_id: "tail-test".to_string(),
            output_dir: directory.clone(),
            max_seconds: 1,
        })
        .unwrap();
        let origin = 30_000_000;
        sink.begin(origin).unwrap();

        let packet = AudioPacket {
            source: SourceKind::Microphone,
            qpc_hns: origin + 9_500_000,
            frames: 4_800,
            samples: vec![0.25; 4_800 * 2],
            silent: false,
            discontinuity: false,
            timestamp_error: false,
        };
        let clipped = clip_packet_to_qpc_end(&sink, packet, origin + QPC_TICKS_PER_SECOND)
            .expect("the first 50 ms should remain inside the capture limit");

        assert_eq!(clipped.frames, 2_400);
        assert_eq!(clipped.samples.len(), 2_400 * 2);

        sink.finalize().unwrap();
        std::fs::remove_dir_all(directory).unwrap();
    }
}
