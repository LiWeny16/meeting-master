use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender, SyncSender};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use wasapi::{
    AudioCaptureClient, AudioClient, DeviceEnumerator, Direction, Handle, SampleType, StreamMode,
    WaveFormat, initialize_mta,
};

use crate::audio::error::AudioError;
use crate::audio::types::{
    ApplicationTarget, AudioPacket, CaptureEvent, SourceKind, TARGET_CHANNELS, TARGET_SAMPLE_RATE,
};

const BUFFER_DURATION_HNS: i64 = 200_000;
const START_TIMEOUT: Duration = Duration::from_secs(5);
const WAIT_TIMEOUT_MS: u32 = 200;
const BYTES_PER_FRAME: usize = TARGET_CHANNELS as usize * std::mem::size_of::<f32>();

pub struct CaptureHandle {
    pub source: SourceKind,
    pub device_name: String,
    pub stop_flag: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}

impl CaptureHandle {
    pub fn new(
        source: SourceKind,
        device_name: String,
        stop_flag: Arc<AtomicBool>,
        join: JoinHandle<()>,
    ) -> Self {
        Self {
            source,
            device_name,
            stop_flag,
            join: Some(join),
        }
    }

    pub fn stop_flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.stop_flag)
    }

    pub fn request_stop(&self) {
        self.stop_flag.store(true, Ordering::SeqCst);
    }

    pub fn join(&mut self) {
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

impl Drop for CaptureHandle {
    fn drop(&mut self) {
        self.request_stop();
    }
}

enum SetupError {
    DeviceNotFound(String),
    Capture(String),
}

impl SetupError {
    fn into_audio_error(self) -> AudioError {
        match self {
            SetupError::DeviceNotFound(message) => AudioError::DeviceNotFound(message),
            SetupError::Capture(message) => AudioError::Capture(message),
        }
    }
}

enum LoopExit {
    Stopped,
    ChannelClosed,
    Failed(String),
}

struct InitializedCapture {
    audio_client: AudioClient,
    device_id: String,
    device_name: String,
}

pub fn start_capture(
    source: SourceKind,
    device_id: Option<String>,
    application: Option<ApplicationTarget>,
    sender: Sender<CaptureEvent>,
) -> Result<CaptureHandle, AudioError> {
    let stop_flag = Arc::new(AtomicBool::new(false));
    let thread_stop = Arc::clone(&stop_flag);
    let (setup_tx, setup_rx) = mpsc::sync_channel(1);

    let thread_name = match (source, application.is_some()) {
        (SourceKind::SystemOutput, true) => "audio-process-loopback",
        (SourceKind::SystemOutput, false) => "audio-system-loopback",
        (SourceKind::Microphone, _) => "audio-microphone",
    };

    let join = thread::Builder::new()
        .name(thread_name.to_string())
        .spawn(move || {
            run_capture(
                source,
                device_id,
                application,
                sender,
                thread_stop,
                setup_tx,
            );
        })
        .map_err(AudioError::Io)?;

    match setup_rx.recv_timeout(START_TIMEOUT) {
        Ok(Ok(device_name)) => Ok(CaptureHandle::new(source, device_name, stop_flag, join)),
        Ok(Err(error)) => {
            stop_flag.store(true, Ordering::SeqCst);
            let _ = join.join();
            Err(error.into_audio_error())
        }
        Err(error) => {
            stop_flag.store(true, Ordering::SeqCst);
            let _ = join.join();
            let message = match error {
                mpsc::RecvTimeoutError::Timeout => format!(
                    "{} capture did not start within {} seconds",
                    source.label(),
                    START_TIMEOUT.as_secs()
                ),
                mpsc::RecvTimeoutError::Disconnected => format!(
                    "{} capture thread exited before startup completed",
                    source.label()
                ),
            };
            Err(AudioError::Capture(message))
        }
    }
}

fn run_capture(
    source: SourceKind,
    device_id: Option<String>,
    application: Option<ApplicationTarget>,
    sender: Sender<CaptureEvent>,
    stop_flag: Arc<AtomicBool>,
    setup_tx: SyncSender<Result<String, SetupError>>,
) {
    let _ = initialize_mta();

    let InitializedCapture {
        audio_client,
        device_id,
        device_name,
    } = match initialize_capture(source, device_id, application) {
        Ok(capture) => capture,
        Err(error) => {
            let _ = setup_tx.send(Err(error));
            return;
        }
    };

    let h_event = match audio_client.set_get_eventhandle() {
        Ok(handle) => handle,
        Err(error) => {
            let _ = setup_tx.send(Err(SetupError::Capture(format!(
                "{} failed to create capture event: {error}",
                source.label()
            ))));
            return;
        }
    };

    let capture_client = match audio_client.get_audiocaptureclient() {
        Ok(client) => client,
        Err(error) => {
            let _ = setup_tx.send(Err(SetupError::Capture(format!(
                "{} failed to get capture client: {error}",
                source.label()
            ))));
            return;
        }
    };

    if let Err(error) = audio_client.start_stream() {
        let _ = setup_tx.send(Err(SetupError::Capture(format!(
            "{} failed to start capture stream: {error}",
            source.label()
        ))));
        return;
    }

    if stop_flag.load(Ordering::SeqCst) {
        // Startup outlived the waiter: do not announce a capture nobody owns.
        let _ = audio_client.stop_stream();
        let _ = setup_tx.send(Err(SetupError::Capture(format!(
            "{} capture startup was cancelled",
            source.label()
        ))));
        return;
    }

    // Report readiness immediately: a loopback stream may stay silent for a long time.
    let started = CaptureEvent::Started {
        source,
        device_id,
        device_name: device_name.clone(),
    };
    if sender.send(started).is_err() {
        let _ = audio_client.stop_stream();
        let _ = setup_tx.send(Err(SetupError::Capture(format!(
            "{} event channel closed during startup",
            source.label()
        ))));
        return;
    }

    if setup_tx.send(Ok(device_name)).is_err() {
        // The starter gave up waiting, so no one owns this capture.
        let _ = audio_client.stop_stream();
        return;
    }

    match capture_loop(source, &capture_client, &h_event, &sender, &stop_flag) {
        LoopExit::Stopped => {
            let _ = audio_client.stop_stream();
            let _ = sender.send(CaptureEvent::Finished {
                source,
                reason: "stopped".to_string(),
            });
        }
        LoopExit::ChannelClosed => {
            let _ = audio_client.stop_stream();
        }
        LoopExit::Failed(message) => {
            log::error!("{} capture failed: {message}", source.label());
            let _ = sender.send(CaptureEvent::Failed { source, message });
            let _ = audio_client.stop_stream();
        }
    }
}

fn initialize_capture(
    source: SourceKind,
    device_id: Option<String>,
    application: Option<ApplicationTarget>,
) -> Result<InitializedCapture, SetupError> {
    if source == SourceKind::SystemOutput {
        if let Some(application) = application {
            match initialize_process_loopback(&application) {
                Ok(capture) => return Ok(capture),
                Err(message) => {
                    log::warn!(
                        "process loopback for PID {} failed ({message}); falling back to endpoint loopback",
                        application.process_id
                    );
                }
            }
        }
    }

    initialize_endpoint(source, device_id.as_deref())
}

fn initialize_process_loopback(
    application: &ApplicationTarget,
) -> Result<InitializedCapture, String> {
    let mut audio_client = AudioClient::new_application_loopback_client(
        application.process_id,
        application.include_tree,
    )
    .map_err(|error| format!("activation failed: {error}"))?;

    let format = capture_format();
    let mode = StreamMode::EventsShared {
        autoconvert: true,
        buffer_duration_hns: BUFFER_DURATION_HNS,
    };
    audio_client
        .initialize_client(&format, &Direction::Capture, &mode)
        .map_err(|error| format!("initialization failed: {error}"))?;

    Ok(InitializedCapture {
        audio_client,
        device_id: format!("pid:{}", application.process_id),
        device_name: format!("Application (PID {})", application.process_id),
    })
}

fn initialize_endpoint(
    source: SourceKind,
    device_id: Option<&str>,
) -> Result<InitializedCapture, SetupError> {
    let enumerator = DeviceEnumerator::new().map_err(|error| {
        SetupError::Capture(format!("failed to create audio device enumerator: {error}"))
    })?;

    let endpoint_direction = match source {
        SourceKind::SystemOutput => Direction::Render,
        SourceKind::Microphone => Direction::Capture,
    };

    let requested_id = device_id.map(str::trim).filter(|id| !id.is_empty());
    let device = match requested_id {
        Some(id) => enumerator.get_device(id).map_err(|error| {
            SetupError::DeviceNotFound(format!("could not open audio device '{id}': {error}"))
        })?,
        None => enumerator
            .get_default_device(&endpoint_direction)
            .map_err(|error| {
                SetupError::DeviceNotFound(format!(
                    "no default {} device is available: {error}",
                    endpoint_label(source)
                ))
            })?,
    };

    if device.get_direction() != endpoint_direction {
        return Err(SetupError::DeviceNotFound(format!(
            "audio device '{}' is not a {} endpoint",
            requested_id.unwrap_or("<default>"),
            endpoint_label(source)
        )));
    }

    let device_id = device.get_id().map_err(|error| {
        SetupError::Capture(format!(
            "failed to read {} device id: {error}",
            source.label()
        ))
    })?;
    let device_name = device.get_friendlyname().map_err(|error| {
        SetupError::Capture(format!(
            "failed to read {} device name: {error}",
            source.label()
        ))
    })?;
    let mut audio_client = device.get_iaudioclient().map_err(|error| {
        SetupError::Capture(format!(
            "failed to open {} audio client: {error}",
            source.label()
        ))
    })?;

    let format = capture_format();
    let mode = StreamMode::EventsShared {
        autoconvert: true,
        buffer_duration_hns: BUFFER_DURATION_HNS,
    };
    // A render endpoint opened with Direction::Capture is WASAPI endpoint loopback;
    // a capture endpoint is a normal microphone stream.
    audio_client
        .initialize_client(&format, &Direction::Capture, &mode)
        .map_err(|error| {
            SetupError::Capture(format!(
                "failed to initialize {} capture at 48 kHz stereo f32: {error}",
                source.label()
            ))
        })?;

    Ok(InitializedCapture {
        audio_client,
        device_id,
        device_name,
    })
}

fn endpoint_label(source: SourceKind) -> &'static str {
    match source {
        SourceKind::SystemOutput => "output",
        SourceKind::Microphone => "input",
    }
}

fn capture_format() -> WaveFormat {
    WaveFormat::new(
        32,
        32,
        &SampleType::Float,
        TARGET_SAMPLE_RATE as usize,
        TARGET_CHANNELS as usize,
        None,
    )
}

fn capture_loop(
    source: SourceKind,
    capture_client: &AudioCaptureClient,
    h_event: &Handle,
    sender: &Sender<CaptureEvent>,
    stop_flag: &AtomicBool,
) -> LoopExit {
    loop {
        if stop_flag.load(Ordering::SeqCst) {
            return LoopExit::Stopped;
        }

        let packet_size = match capture_client.get_next_packet_size() {
            Ok(size) => size,
            Err(error) => {
                return LoopExit::Failed(format!(
                    "{} packet size query failed: {error}",
                    source.label()
                ));
            }
        };

        let frames = match packet_size {
            Some(frames) if frames > 0 => frames,
            _ => {
                let _ = h_event.wait_for_event(WAIT_TIMEOUT_MS);
                continue;
            }
        };

        let mut buffer = vec![0u8; frames as usize * BYTES_PER_FRAME];
        let (frames_read, info) = match capture_client.read_from_device(&mut buffer) {
            Ok(read) => read,
            Err(error) => {
                return LoopExit::Failed(format!("{} read failed: {error}", source.label()));
            }
        };
        if frames_read == 0 {
            continue;
        }

        let silent = info.flags.silent;
        let data_len = (frames_read as usize * BYTES_PER_FRAME).min(buffer.len());
        let data = &mut buffer[..data_len];
        if silent {
            data.fill(0);
        }
        let samples = data
            .chunks_exact(std::mem::size_of::<f32>())
            .map(|bytes| f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
            .collect::<Vec<f32>>();

        let packet = AudioPacket {
            source,
            // WASAPI timestamps are QPC values in 100 ns units.
            qpc_hns: info.timestamp,
            frames: frames_read,
            samples,
            silent,
            discontinuity: info.flags.data_discontinuity,
            timestamp_error: info.flags.timestamp_error,
        };

        if sender.send(CaptureEvent::Packet(packet)).is_err() {
            return LoopExit::ChannelClosed;
        }
    }
}
