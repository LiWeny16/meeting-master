use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use hound::{SampleFormat, WavSpec, WavWriter};
use rubato::{FftFixedInOut, Resampler};

use crate::audio::error::AudioError;
use crate::audio::types::{
    ASR_REALTIME_CHUNK_FRAMES, ASR_SAMPLE_RATE, AsrPcmChunk, AudioPacket, CaptureLevel,
    RecordingConfig, RecordingSummary, SourceKind, SourceRecordingSummary, TARGET_CHANNELS,
    TARGET_SAMPLE_RATE,
};

const QPC_TICKS_PER_SECOND: u64 = 10_000_000;
/// Gaps up to 5 ms are treated as timestamp jitter and are not padded.
const GAP_THRESHOLD_HNS: u64 = 50_000;
const ASR_CHUNK_SIZE: usize = 1024;
const SILENCE_BLOCK_FRAMES: usize = 1024;
const MAX_PENDING_PACKETS: usize = 512;
const MAX_PENDING_FRAMES: u64 = TARGET_SAMPLE_RATE as u64 * 10;
const FRAMES_PER_MS: u64 = (TARGET_SAMPLE_RATE / 1_000) as u64;

pub struct RecordingSink {
    session_id: String,
    output_dir: PathBuf,
    timeline_path: PathBuf,
    started_at_unix_ms: u64,
    origin_qpc_hns: Option<u64>,
    pending: Vec<AudioPacket>,
    pending_frames: u64,
    stream_asr_enabled: bool,
    sources: [SourceSink; 2],
}

impl RecordingSink {
    pub fn new(config: RecordingConfig) -> Result<Self, AudioError> {
        Self::new_internal(config, false)
    }

    pub fn new_with_asr_stream(config: RecordingConfig) -> Result<Self, AudioError> {
        Self::new_internal(config, true)
    }

    fn new_internal(config: RecordingConfig, stream_asr_enabled: bool) -> Result<Self, AudioError> {
        let RecordingConfig {
            session_id,
            output_dir,
            max_seconds: _,
        } = config;
        let output_dir = absolute_path(&output_dir);
        std::fs::create_dir_all(&output_dir)?;
        let sources = [
            SourceSink::create(SourceKind::SystemOutput, &output_dir, stream_asr_enabled)?,
            SourceSink::create(SourceKind::Microphone, &output_dir, stream_asr_enabled)?,
        ];
        Ok(Self {
            session_id,
            timeline_path: output_dir.join("timeline.json"),
            output_dir,
            started_at_unix_ms: unix_now_ms(),
            origin_qpc_hns: None,
            pending: Vec::new(),
            pending_frames: 0,
            stream_asr_enabled,
            sources,
        })
    }

    pub fn begin(&mut self, origin_qpc_hns: u64) -> Result<(), AudioError> {
        if self.origin_qpc_hns.is_some() {
            return Err(AudioError::InvalidState(
                "recording session was already started".to_string(),
            ));
        }
        self.origin_qpc_hns = Some(origin_qpc_hns);
        self.started_at_unix_ms = unix_now_ms();
        self.flush_pending()
    }

    pub fn push(&mut self, packet: AudioPacket) -> Result<Option<CaptureLevel>, AudioError> {
        validate_packet(&packet)?;
        if packet.frames == 0 {
            return Ok(None);
        }

        let Some(origin_qpc_hns) = self.origin_qpc_hns else {
            let frames = u64::from(packet.frames);
            if self.pending.len() >= MAX_PENDING_PACKETS
                || self.pending_frames.saturating_add(frames) > MAX_PENDING_FRAMES
            {
                return Err(AudioError::InvalidState(format!(
                    "cannot buffer more than {MAX_PENDING_FRAMES} frames before begin() is called"
                )));
            }
            self.pending_frames += frames;
            self.pending.push(packet);
            return Ok(None);
        };

        let index = source_index(packet.source);
        self.sources[index].write_packet(packet, origin_qpc_hns)
    }

    pub fn finalize(self) -> Result<RecordingSummary, AudioError> {
        self.finalize_with_asr().map(|(summary, _)| summary)
    }

    pub fn finalize_with_asr(mut self) -> Result<(RecordingSummary, Vec<AsrPcmChunk>), AudioError> {
        if self.origin_qpc_hns.is_none() {
            if let Some(first) = self.pending.first() {
                self.origin_qpc_hns = Some(first.qpc_hns);
            }
        }
        if self.origin_qpc_hns.is_some() {
            self.flush_pending()?;
        }

        let mut summaries = Vec::with_capacity(SourceKind::ALL.len());
        let mut asr_chunks = Vec::new();
        let mut first_error: Option<AudioError> = None;
        for source in self.sources {
            match source.finish() {
                Ok((summary, chunks)) => {
                    summaries.push(summary);
                    asr_chunks.extend(chunks);
                }
                Err(error) => {
                    if first_error.is_none() {
                        first_error = Some(error);
                    }
                }
            }
        }
        if let Some(error) = first_error {
            return Err(error);
        }

        let max_frames = summaries
            .iter()
            .map(|summary| summary.frames)
            .max()
            .unwrap_or(0);
        let summary = RecordingSummary {
            session_id: self.session_id,
            output_dir: path_string(&self.output_dir),
            started_at_unix_ms: self.started_at_unix_ms,
            duration_ms: max_frames / FRAMES_PER_MS,
            sample_rate: TARGET_SAMPLE_RATE,
            channels: TARGET_CHANNELS,
            asr_sample_rate: ASR_SAMPLE_RATE,
            sources: summaries,
            timeline_path: path_string(&self.timeline_path),
        };

        let mut file = File::create(&self.timeline_path)?;
        serde_json::to_writer_pretty(&mut file, &summary)?;
        file.flush()?;
        Ok((summary, asr_chunks))
    }

    /// Take complete 40 ms chunks produced since the previous drain.
    pub fn drain_asr_chunks(&mut self) -> Vec<AsrPcmChunk> {
        if !self.stream_asr_enabled {
            return Vec::new();
        }
        let mut chunks = Vec::new();
        for source in &mut self.sources {
            chunks.append(&mut source.ready_asr_chunks);
        }
        chunks
    }

    pub fn enable_asr_stream(&mut self) {
        self.stream_asr_enabled = true;
        for source in &mut self.sources {
            source.stream_asr_enabled = true;
        }
    }

    pub fn started_at_unix_ms(&self) -> u64 {
        self.started_at_unix_ms
    }

    pub fn is_started(&self) -> bool {
        self.origin_qpc_hns.is_some()
    }

    pub fn origin_qpc_hns(&self) -> Option<u64> {
        self.origin_qpc_hns
    }

    pub fn source_end_qpc_hns(&self, source: SourceKind) -> Option<u64> {
        self.sources[source_index(source)].written_end_qpc_hns
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    fn flush_pending(&mut self) -> Result<(), AudioError> {
        let pending = std::mem::take(&mut self.pending);
        self.pending_frames = 0;
        for packet in pending {
            self.push(packet)?;
        }
        Ok(())
    }
}

struct SourceSink {
    kind: SourceKind,
    wav_path: PathBuf,
    asr_path: PathBuf,
    wav: WavWriter<BufWriter<File>>,
    asr: WavWriter<BufWriter<File>>,
    resampler: FftFixedInOut<f32>,
    chunk_in: usize,
    mono_pending: Vec<f32>,
    stream_asr_enabled: bool,
    stream_pending: Vec<i16>,
    stream_pending_start_frame: u64,
    ready_asr_chunks: Vec<AsrPcmChunk>,
    frames: u64,
    asr_frames: u64,
    silent_frames: u64,
    discontinuities: u64,
    first_qpc_hns: Option<u64>,
    last_qpc_hns: Option<u64>,
    written_end_qpc_hns: Option<u64>,
}

impl SourceSink {
    fn create(
        kind: SourceKind,
        output_dir: &Path,
        stream_asr_enabled: bool,
    ) -> Result<Self, AudioError> {
        let resampler = FftFixedInOut::<f32>::new(
            TARGET_SAMPLE_RATE as usize,
            ASR_SAMPLE_RATE as usize,
            ASR_CHUNK_SIZE,
            1,
        )
        .map_err(|error| {
            AudioError::Resampler(format!(
                "failed to create the {} ASR resampler: {error}",
                kind.label()
            ))
        })?;
        // FftFixedInOut rounds the chunk up to a multiple of three input frames
        // so that the 48 kHz -> 16 kHz ratio stays integral (1024 requests 1026).
        let chunk_in = resampler.input_frames_next();

        let wav_path = output_dir.join(kind.wav_file_name());
        let asr_path = output_dir.join(kind.asr_file_name());
        let wav = WavWriter::create(
            &wav_path,
            WavSpec {
                channels: TARGET_CHANNELS,
                sample_rate: TARGET_SAMPLE_RATE,
                bits_per_sample: 32,
                sample_format: SampleFormat::Float,
            },
        )?;
        let asr = WavWriter::create(
            &asr_path,
            WavSpec {
                channels: 1,
                sample_rate: ASR_SAMPLE_RATE,
                bits_per_sample: 32,
                sample_format: SampleFormat::Float,
            },
        )?;

        Ok(Self {
            kind,
            wav_path,
            asr_path,
            wav,
            asr,
            resampler,
            chunk_in,
            mono_pending: Vec::new(),
            stream_asr_enabled,
            stream_pending: Vec::with_capacity(ASR_REALTIME_CHUNK_FRAMES * 2),
            stream_pending_start_frame: 0,
            ready_asr_chunks: Vec::new(),
            frames: 0,
            asr_frames: 0,
            silent_frames: 0,
            discontinuities: 0,
            first_qpc_hns: None,
            last_qpc_hns: None,
            written_end_qpc_hns: None,
        })
    }

    fn write_packet(
        &mut self,
        packet: AudioPacket,
        origin_qpc_hns: u64,
    ) -> Result<Option<CaptureLevel>, AudioError> {
        let AudioPacket {
            qpc_hns,
            frames,
            samples,
            silent,
            discontinuity,
            timestamp_error,
            ..
        } = packet;

        let qpc_hns = if timestamp_error {
            self.written_end_qpc_hns.unwrap_or(origin_qpc_hns)
        } else {
            qpc_hns
        };

        let mut written_frames = u64::from(frames);
        let mut sample_offset = 0usize;
        let mut inserted_gap = false;

        match self.written_end_qpc_hns {
            Some(end_qpc_hns) => {
                if qpc_hns > end_qpc_hns {
                    let gap_hns = qpc_hns - end_qpc_hns;
                    if gap_hns > GAP_THRESHOLD_HNS {
                        self.write_padding(hns_to_frames_round(gap_hns))?;
                        inserted_gap = true;
                    }
                } else if qpc_hns < end_qpc_hns {
                    let overlap = hns_to_frames_round(end_qpc_hns - qpc_hns).min(written_frames);
                    sample_offset = (overlap * u64::from(TARGET_CHANNELS)) as usize;
                    written_frames -= overlap;
                }
            }
            None => {
                // This source's clock started late; align its first frame to t0.
                let late_by = qpc_hns.saturating_sub(origin_qpc_hns);
                self.write_padding(hns_to_frames_round(late_by))?;
            }
        }

        self.first_qpc_hns.get_or_insert(qpc_hns);
        self.last_qpc_hns = Some(qpc_hns);
        if discontinuity || inserted_gap {
            self.discontinuities += 1;
        }
        if written_frames == 0 {
            return Ok(None);
        }

        let sample_count = (written_frames * u64::from(TARGET_CHANNELS)) as usize;
        let data = &samples[sample_offset..sample_offset + sample_count];

        let (rms, peak) = if silent {
            for _ in 0..sample_count {
                self.wav.write_sample(0.0_f32)?;
            }
            self.silent_frames += written_frames;
            self.feed_asr_silence(written_frames)?;
            (0.0, 0.0)
        } else {
            let (rms, peak) = measure_level(data);
            for &sample in data {
                self.wav.write_sample(sample)?;
            }
            self.feed_asr_stereo(data)?;
            (rms, peak)
        };

        self.frames += written_frames;
        self.written_end_qpc_hns = Some(qpc_hns + frames_to_hns(u64::from(frames)));
        Ok(Some(CaptureLevel {
            source: self.kind,
            qpc_hns,
            rms,
            peak,
            frames: written_frames as u32,
        }))
    }

    fn write_padding(&mut self, frames: u64) -> Result<(), AudioError> {
        if frames == 0 {
            return Ok(());
        }
        let zeros = [0.0_f32; SILENCE_BLOCK_FRAMES * TARGET_CHANNELS as usize];
        let mut remaining = frames;
        while remaining > 0 {
            let count = remaining.min(SILENCE_BLOCK_FRAMES as u64) as usize;
            for &sample in &zeros[..count * TARGET_CHANNELS as usize] {
                self.wav.write_sample(sample)?;
            }
            remaining -= count as u64;
        }
        self.frames += frames;
        self.feed_asr_silence(frames)
    }

    fn feed_asr_stereo(&mut self, interleaved: &[f32]) -> Result<(), AudioError> {
        self.mono_pending.reserve(interleaved.len() / 2);
        for pair in interleaved.chunks_exact(2) {
            self.mono_pending.push(stereo_to_mono(pair[0], pair[1]));
        }
        self.flush_asr_chunks()
    }

    fn feed_asr_silence(&mut self, frames: u64) -> Result<(), AudioError> {
        let zeros = [0.0_f32; SILENCE_BLOCK_FRAMES];
        let mut remaining = frames;
        while remaining > 0 {
            let count = remaining.min(SILENCE_BLOCK_FRAMES as u64) as usize;
            self.mono_pending.extend_from_slice(&zeros[..count]);
            self.flush_asr_chunks()?;
            remaining -= count as u64;
        }
        Ok(())
    }

    fn flush_asr_chunks(&mut self) -> Result<(), AudioError> {
        let label = self.kind.label();
        let mut consumed = 0usize;
        while self.mono_pending.len() - consumed >= self.chunk_in {
            let output = self
                .resampler
                .process(
                    &[&self.mono_pending[consumed..consumed + self.chunk_in]],
                    None,
                )
                .map_err(|error| {
                    AudioError::Resampler(format!("{label} ASR resampling failed: {error}"))
                })?;
            consumed += self.chunk_in;
            self.write_asr(&output[0])?;
        }
        if consumed > 0 {
            self.mono_pending.drain(..consumed);
        }
        Ok(())
    }

    fn write_asr(&mut self, samples: &[f32]) -> Result<(), AudioError> {
        for &sample in samples {
            self.asr.write_sample(sample)?;
        }
        self.asr_frames += samples.len() as u64;
        if self.stream_asr_enabled {
            self.stream_pending.reserve(samples.len());
            for &sample in samples {
                self.stream_pending.push(float_to_pcm16(sample));
            }
            while self.stream_pending.len() >= ASR_REALTIME_CHUNK_FRAMES {
                let samples = self
                    .stream_pending
                    .drain(..ASR_REALTIME_CHUNK_FRAMES)
                    .collect();
                self.ready_asr_chunks.push(AsrPcmChunk {
                    source: self.kind,
                    start_frame: self.stream_pending_start_frame,
                    samples,
                });
                self.stream_pending_start_frame = self
                    .stream_pending_start_frame
                    .saturating_add(ASR_REALTIME_CHUNK_FRAMES as u64);
            }
        }
        Ok(())
    }

    fn finish(mut self) -> Result<(SourceRecordingSummary, Vec<AsrPcmChunk>), AudioError> {
        let flush_result = self.flush_asr_remainder();
        let wav_result = self.wav.finalize();
        let asr_result = self.asr.finalize();
        flush_result?;
        wav_result?;
        asr_result?;

        let mut stream_chunks = std::mem::take(&mut self.ready_asr_chunks);
        if self.stream_asr_enabled && !self.stream_pending.is_empty() {
            stream_chunks.push(AsrPcmChunk {
                source: self.kind,
                start_frame: self.stream_pending_start_frame,
                samples: std::mem::take(&mut self.stream_pending),
            });
        }

        Ok((
            SourceRecordingSummary {
                source: self.kind,
                wav_path: path_string(&self.wav_path),
                asr_path: path_string(&self.asr_path),
                frames: self.frames,
                asr_frames: self.asr_frames,
                silent_frames: self.silent_frames,
                discontinuities: self.discontinuities,
                first_qpc_hns: self.first_qpc_hns,
                last_qpc_hns: self.last_qpc_hns,
            },
            stream_chunks,
        ))
    }

    fn flush_asr_remainder(&mut self) -> Result<(), AudioError> {
        if self.mono_pending.is_empty() {
            return Ok(());
        }
        debug_assert!(self.mono_pending.len() < self.chunk_in);
        self.mono_pending.resize(self.chunk_in, 0.0);
        let label = self.kind.label();
        let output = self
            .resampler
            .process(&[&self.mono_pending[..]], None)
            .map_err(|error| {
                AudioError::Resampler(format!("{label} ASR resampler flush failed: {error}"))
            })?;
        self.write_asr(&output[0])?;
        self.mono_pending.clear();
        Ok(())
    }
}

fn source_index(kind: SourceKind) -> usize {
    match kind {
        SourceKind::SystemOutput => 0,
        SourceKind::Microphone => 1,
    }
}

fn validate_packet(packet: &AudioPacket) -> Result<(), AudioError> {
    let expected = u64::from(packet.frames) * u64::from(TARGET_CHANNELS);
    if packet.samples.len() as u64 != expected {
        return Err(AudioError::Capture(format!(
            "{} packet at QPC {} declared {} frames ({} interleaved samples) but carried {} samples",
            packet.source.label(),
            packet.qpc_hns,
            packet.frames,
            expected,
            packet.samples.len()
        )));
    }
    Ok(())
}

fn hns_to_frames_round(hns: u64) -> u64 {
    let numerator = hns as u128 * TARGET_SAMPLE_RATE as u128 + QPC_TICKS_PER_SECOND as u128 / 2;
    (numerator / QPC_TICKS_PER_SECOND as u128) as u64
}

fn frames_to_hns(frames: u64) -> u64 {
    (frames as u128 * QPC_TICKS_PER_SECOND as u128 / TARGET_SAMPLE_RATE as u128) as u64
}

fn stereo_to_mono(left: f32, right: f32) -> f32 {
    (left + right) * 0.5
}

fn float_to_pcm16(sample: f32) -> i16 {
    let sample = if sample.is_finite() {
        sample.clamp(-1.0, 1.0)
    } else {
        0.0
    };
    let scale = if sample < 0.0 { 32_768.0 } else { 32_767.0 };
    (sample * scale).round() as i16
}

fn measure_level(samples: &[f32]) -> (f32, f32) {
    if samples.is_empty() {
        return (0.0, 0.0);
    }
    let mut sum_squares = 0.0_f64;
    let mut peak = 0.0_f32;
    for &sample in samples {
        let magnitude = sample.abs();
        if magnitude > peak {
            peak = magnitude;
        }
        sum_squares += f64::from(sample) * f64::from(sample);
    }
    let rms = (sum_squares / samples.len() as f64).sqrt() as f32;
    (rms, peak)
}

fn absolute_path(path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map(|current_dir| current_dir.join(path))
            .unwrap_or_else(|_| path.to_path_buf())
    }
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn unix_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or_default();
            Self(std::env::temp_dir().join(format!(
                "meeting-master-pipeline-{label}-{}-{nonce}",
                std::process::id()
            )))
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn converts_qpc_gaps_to_frames() {
        assert_eq!(hns_to_frames_round(0), 0);
        assert_eq!(hns_to_frames_round(GAP_THRESHOLD_HNS), 240);
        assert_eq!(hns_to_frames_round(QPC_TICKS_PER_SECOND), 48_000);
        // One frame is 208.33 QPC ticks; just over half a frame rounds up.
        assert_eq!(hns_to_frames_round(QPC_TICKS_PER_SECOND / 48_000), 1);
        assert_eq!(hns_to_frames_round(105), 1);
        assert_eq!(hns_to_frames_round(104), 0);
        assert_eq!(frames_to_hns(480), 100_000);
        assert_eq!(frames_to_hns(48_000), QPC_TICKS_PER_SECOND);
        assert_eq!(frames_to_hns(1), 208);
    }

    #[test]
    fn mixes_stereo_and_measures_level() {
        assert_eq!(stereo_to_mono(0.5, -0.5), 0.0);
        assert_eq!(stereo_to_mono(0.25, 0.75), 0.5);

        let (rms, peak) = measure_level(&[0.5, -0.5, 1.0, -1.0]);
        assert!((rms - 0.790_569_4).abs() < 1e-6);
        assert_eq!(peak, 1.0);
        assert_eq!(measure_level(&[]), (0.0, 0.0));
    }

    #[test]
    fn records_late_packet_with_padding_and_asr() {
        let dir = TempDir::new("late-packet");
        let mut sink = RecordingSink::new(RecordingConfig {
            session_id: "test-session".to_string(),
            output_dir: dir.0.clone(),
            max_seconds: 60,
        })
        .unwrap();
        sink.begin(1_000_000).unwrap();

        let level = sink
            .push(AudioPacket {
                source: SourceKind::SystemOutput,
                qpc_hns: 2_000_000,
                frames: 480,
                samples: vec![0.25; 480 * 2],
                silent: false,
                discontinuity: false,
                timestamp_error: false,
            })
            .unwrap()
            .expect("level for a written packet");
        assert_eq!(level.frames, 480);
        assert_eq!(level.qpc_hns, 2_000_000);
        assert!((level.rms - 0.25).abs() < 1e-6);
        assert!((level.peak - 0.25).abs() < 1e-6);

        let summary = sink.finalize().unwrap();
        assert_eq!(summary.duration_ms, 110);
        assert_eq!(summary.sample_rate, 48_000);
        assert_eq!(summary.channels, 2);
        assert_eq!(summary.asr_sample_rate, 16_000);
        assert_eq!(summary.sources.len(), 2);

        let system = &summary.sources[0];
        assert_eq!(system.source, SourceKind::SystemOutput);
        assert_eq!(system.frames, 4_800 + 480);
        assert_eq!(system.first_qpc_hns, Some(2_000_000));
        assert_eq!(system.last_qpc_hns, Some(2_000_000));
        assert_eq!(system.discontinuities, 0);
        assert_eq!(system.asr_frames % 342, 0);
        assert!(system.asr_frames >= system.frames / 3);

        let wav = hound::WavReader::open(&system.wav_path).unwrap();
        assert_eq!(wav.spec().channels, 2);
        assert_eq!(wav.spec().sample_rate, 48_000);
        assert_eq!(wav.spec().sample_format, SampleFormat::Float);
        assert_eq!(u64::from(wav.len()), system.frames * 2);

        let asr = hound::WavReader::open(&system.asr_path).unwrap();
        assert_eq!(asr.spec().channels, 1);
        assert_eq!(asr.spec().sample_rate, 16_000);
        assert_eq!(u64::from(asr.len()), system.asr_frames);

        let microphone = &summary.sources[1];
        assert_eq!(microphone.source, SourceKind::Microphone);
        assert_eq!(microphone.frames, 0);
        assert_eq!(microphone.asr_frames, 0);
        assert!(microphone.first_qpc_hns.is_none());
        assert!(Path::new(&microphone.wav_path).exists());
        assert!(Path::new(&microphone.asr_path).exists());

        let timeline = std::fs::read_to_string(&summary.timeline_path).unwrap();
        let parsed: RecordingSummary = serde_json::from_str(&timeline).unwrap();
        assert_eq!(parsed.session_id, "test-session");
        assert_eq!(parsed.duration_ms, 110);
        assert_eq!(parsed.timeline_path, summary.timeline_path);
    }

    #[test]
    fn invalid_timestamps_fall_back_to_expected_end() {
        let dir = TempDir::new("timestamp-error");
        let mut sink = RecordingSink::new(RecordingConfig {
            session_id: "test-session".to_string(),
            output_dir: dir.0.clone(),
            max_seconds: 60,
        })
        .unwrap();
        sink.begin(0).unwrap();

        let packet = |timestamp_error| AudioPacket {
            source: SourceKind::SystemOutput,
            qpc_hns: 0,
            frames: 480,
            samples: vec![0.1; 480 * 2],
            silent: false,
            discontinuity: false,
            timestamp_error,
        };
        sink.push(packet(false)).unwrap();
        sink.push(packet(true)).unwrap();

        let summary = sink.finalize().unwrap();
        assert_eq!(summary.sources[0].frames, 960);
        assert_eq!(summary.sources[0].discontinuities, 0);
    }

    #[test]
    fn streaming_emits_40ms_pcm_and_flushes_resampler_remainder() {
        let dir = TempDir::new("asr-stream-chunks");
        let mut sink = RecordingSink::new_with_asr_stream(RecordingConfig {
            session_id: "test-session".to_string(),
            output_dir: dir.0.clone(),
            max_seconds: 60,
        })
        .unwrap();
        sink.begin(0).unwrap();
        sink.push(AudioPacket {
            source: SourceKind::Microphone,
            qpc_hns: 0,
            frames: 2_052,
            samples: vec![0.25; 2_052 * 2],
            silent: false,
            discontinuity: false,
            timestamp_error: false,
        })
        .unwrap();
        sink.push(AudioPacket {
            source: SourceKind::Microphone,
            qpc_hns: frames_to_hns(2_052),
            frames: 100,
            samples: vec![0.25; 100 * 2],
            silent: false,
            discontinuity: false,
            timestamp_error: false,
        })
        .unwrap();

        let ready = sink.drain_asr_chunks();
        assert_eq!(ready.len(), 1);
        assert_eq!(ready[0].source, SourceKind::Microphone);
        assert_eq!(ready[0].start_frame, 0);
        assert_eq!(ready[0].samples.len(), ASR_REALTIME_CHUNK_FRAMES);

        let (summary, tail) = sink.finalize_with_asr().unwrap();
        assert_eq!(tail.len(), 1);
        assert_eq!(tail[0].start_frame, ASR_REALTIME_CHUNK_FRAMES as u64);
        assert_eq!(tail[0].samples.len(), 386);
        assert_eq!(summary.sources[1].asr_frames, 1_026);
        assert!(ready[0].samples.iter().any(|sample| *sample > 0));
    }
}
