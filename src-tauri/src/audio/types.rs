use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::asr::types::{AsrStreamStatus, TranscriptUpdate};

pub const TARGET_SAMPLE_RATE: u32 = 48_000;
pub const TARGET_CHANNELS: u16 = 2;
pub const ASR_SAMPLE_RATE: u32 = 16_000;
pub const ASR_REALTIME_CHUNK_FRAMES: usize = 640;
pub const DEFAULT_MAX_SECONDS: u64 = 4 * 60 * 60;
pub const START_TIMEOUT_MS: u64 = 2_500;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SourceKind {
    SystemOutput,
    Microphone,
}

impl SourceKind {
    pub const ALL: [SourceKind; 2] = [SourceKind::SystemOutput, SourceKind::Microphone];

    pub fn label(self) -> &'static str {
        match self {
            SourceKind::SystemOutput => "system output",
            SourceKind::Microphone => "microphone",
        }
    }

    pub fn direction(self) -> DeviceDirection {
        match self {
            SourceKind::SystemOutput => DeviceDirection::Render,
            SourceKind::Microphone => DeviceDirection::Capture,
        }
    }

    pub fn wav_file_name(self) -> &'static str {
        match self {
            SourceKind::SystemOutput => "system-output.wav",
            SourceKind::Microphone => "microphone.wav",
        }
    }

    pub fn asr_file_name(self) -> &'static str {
        match self {
            SourceKind::SystemOutput => "system-output.16k.wav",
            SourceKind::Microphone => "microphone.16k.wav",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DeviceDirection {
    Render,
    Capture,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AudioDeviceInfo {
    pub id: String,
    pub name: String,
    pub direction: DeviceDirection,
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationTarget {
    pub process_id: u32,
    #[serde(default = "default_include_tree")]
    pub include_tree: bool,
}

fn default_include_tree() -> bool {
    true
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStartRequest {
    #[serde(default)]
    pub system_device_id: Option<String>,
    #[serde(default)]
    pub microphone_device_id: Option<String>,
    #[serde(default)]
    pub application: Option<ApplicationTarget>,
    #[serde(default)]
    pub output_dir: Option<String>,
    #[serde(default)]
    pub max_seconds: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SessionState {
    Idle,
    Starting,
    Recording,
    Stopping,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SourceState {
    Pending,
    Recording,
    Stopped,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SourceStatus {
    pub source: SourceKind,
    pub state: SourceState,
    pub device_id: Option<String>,
    pub device_name: Option<String>,
    pub packets: u64,
    pub frames: u64,
    pub silent_frames: u64,
    pub discontinuities: u64,
    pub rms: f32,
    pub peak: f32,
    pub last_packet_qpc_hns: Option<u64>,
    pub message: Option<String>,
}

impl SourceStatus {
    pub fn pending(source: SourceKind) -> Self {
        Self {
            source,
            state: SourceState::Pending,
            device_id: None,
            device_name: None,
            packets: 0,
            frames: 0,
            silent_frames: 0,
            discontinuities: 0,
            rms: 0.0,
            peak: 0.0,
            last_packet_qpc_hns: None,
            message: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStatus {
    pub state: SessionState,
    pub session_id: Option<String>,
    pub output_dir: Option<String>,
    pub started_at_unix_ms: Option<u64>,
    pub elapsed_ms: u64,
    pub max_seconds: u64,
    pub sources: Vec<SourceStatus>,
    pub message: Option<String>,
}

impl Default for CaptureStatus {
    fn default() -> Self {
        Self {
            state: SessionState::Idle,
            session_id: None,
            output_dir: None,
            started_at_unix_ms: None,
            elapsed_ms: 0,
            max_seconds: DEFAULT_MAX_SECONDS,
            sources: SourceKind::ALL
                .into_iter()
                .map(SourceStatus::pending)
                .collect(),
            message: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CaptureLevel {
    pub source: SourceKind,
    pub qpc_hns: u64,
    pub rms: f32,
    pub peak: f32,
    pub frames: u32,
}

#[derive(Debug, Clone)]
pub struct AudioPacket {
    pub source: SourceKind,
    /// QPC timestamp of the first frame, in 100 ns units.
    pub qpc_hns: u64,
    pub frames: u32,
    /// Interleaved stereo f32 samples at 48 kHz.
    pub samples: Vec<f32>,
    pub silent: bool,
    pub discontinuity: bool,
    pub timestamp_error: bool,
}

/// A contiguous 16 kHz mono PCM chunk produced by the recording resampler.
#[derive(Debug, Clone)]
pub struct AsrPcmChunk {
    pub source: SourceKind,
    /// Absolute source frame offset from the aligned recording origin.
    pub start_frame: u64,
    pub samples: Vec<i16>,
}

#[derive(Debug, Clone)]
pub enum CaptureEvent {
    Started {
        source: SourceKind,
        device_id: String,
        device_name: String,
    },
    Packet(AudioPacket),
    Failed {
        source: SourceKind,
        message: String,
    },
    Finished {
        source: SourceKind,
        reason: String,
    },
}

#[derive(Debug, Clone)]
pub struct RecordingConfig {
    pub session_id: String,
    pub output_dir: PathBuf,
    pub max_seconds: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRecordingSummary {
    pub source: SourceKind,
    pub wav_path: String,
    pub asr_path: String,
    pub frames: u64,
    pub asr_frames: u64,
    pub silent_frames: u64,
    pub discontinuities: u64,
    pub first_qpc_hns: Option<u64>,
    pub last_qpc_hns: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingSummary {
    pub session_id: String,
    pub output_dir: String,
    pub started_at_unix_ms: u64,
    pub duration_ms: u64,
    pub sample_rate: u32,
    pub channels: u16,
    pub asr_sample_rate: u32,
    pub sources: Vec<SourceRecordingSummary>,
    pub timeline_path: String,
}

pub trait AudioEventSink: Send + Sync {
    fn emit_level(&self, level: CaptureLevel);
    fn emit_status(&self, status: CaptureStatus);
    fn emit_transcript_update(&self, update: TranscriptUpdate);
    fn emit_asr_stream_status(&self, status: AsrStreamStatus);
}
