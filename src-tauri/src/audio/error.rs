use std::string::FromUtf16Error;

#[derive(Debug, thiserror::Error)]
pub enum AudioError {
    #[error("Windows audio error: {0}")]
    Wasapi(#[from] wasapi::WasapiError),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("WAV error: {0}")]
    Wav(#[from] hound::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("audio device name could not be decoded: {0}")]
    DeviceName(#[from] FromUtf16Error),
    #[error("resampler error: {0}")]
    Resampler(String),
    #[error("audio device not found: {0}")]
    DeviceNotFound(String),
    #[error("invalid capture state: {0}")]
    InvalidState(String),
    #[error("capture thread failed: {0}")]
    Capture(String),
    #[error("unsupported audio operation: {0}")]
    Unsupported(String),
}

impl AudioError {
    pub fn to_message(&self) -> String {
        self.to_string()
    }
}
