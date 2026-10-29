//! ASR provider credentials, hardware detection, and local model management.
//!
//! This module is intentionally self-contained: the application registers
//! [`AsrState`] as managed state and the commands in [`commands`].

pub mod catalog;
pub mod commands;
pub mod crypto;
pub mod download;
pub mod hardware;
pub mod probe;
pub mod providers;
pub mod realtime;
pub mod state;
pub mod types;
pub mod util;

pub use state::AsrState;
pub use types::{
    AsrLocalSnapshot, AsrSelection, DownloadProgress, HardwareProfile, LocalModelInfo,
    ProviderField, ProviderInfo, ProviderTestResult,
};
