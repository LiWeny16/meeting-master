//! Windows hardware detection used to recommend a local ASR model.

use std::mem::size_of;

use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE, IDXGIFactory1,
};
use windows::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx, CoUninitialize};
use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
use winreg::RegKey;
use winreg::enums::HKEY_LOCAL_MACHINE;

use crate::asr::types::HardwareProfile;

const GIB: u64 = 1024 * 1024 * 1024;

pub(crate) fn detect() -> HardwareProfile {
    let mut notes = Vec::new();

    let (gpu_name, vram_bytes) = detect_gpu(&mut notes);
    let total_ram_bytes = detect_total_ram(&mut notes);
    let cpu_name = detect_cpu(&mut notes);
    let logical_cores = match std::thread::available_parallelism() {
        Ok(cores) => cores.get(),
        Err(error) => {
            notes.push(format!(
                "Could not determine the logical CPU count: {error}."
            ));
            1
        }
    };

    let tier = tier_for(vram_bytes);
    let recommended_model_id = recommended_model(tier).map(str::to_string);
    let detection_note = if notes.is_empty() {
        None
    } else {
        Some(notes.join(" "))
    };

    HardwareProfile {
        gpu_name,
        vram_bytes,
        total_ram_bytes,
        cpu_name,
        logical_cores,
        tier: tier.to_string(),
        recommended_model_id,
        detection_note,
    }
}

fn detect_gpu(notes: &mut Vec<String>) -> (String, u64) {
    // DXGI requires COM; failure is non-fatal (another thread may already have
    // initialized a different apartment).
    let com_initialized = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).is_ok() };
    let best = dxgi_best_adapter(notes);
    if com_initialized {
        // SAFETY: balanced against a successful CoInitializeEx above.
        unsafe { CoUninitialize() };
    }

    match best {
        Some(profile) => profile,
        None => ("Unknown GPU".to_string(), 0),
    }
}

fn dxgi_best_adapter(notes: &mut Vec<String>) -> Option<(String, u64)> {
    let mut best: Option<(String, u64)> = None;

    // SAFETY: all handles are released at the end of the scope; DXGI methods
    // are called with valid interface pointers.
    unsafe {
        let factory = match CreateDXGIFactory1::<IDXGIFactory1>() {
            Ok(factory) => factory,
            Err(error) => {
                notes.push(format!("DXGI GPU detection failed: {error}."));
                return None;
            }
        };

        let mut index = 0u32;
        loop {
            let adapter = match factory.EnumAdapters1(index) {
                Ok(adapter) => adapter,
                Err(_) => break,
            };
            index += 1;

            let Ok(description) = adapter.GetDesc1() else {
                continue;
            };
            let is_software = (description.Flags & (DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32)) != 0;
            if is_software {
                continue;
            }

            let name = utf16_description(&description.Description);
            let vram = description.DedicatedVideoMemory as u64;
            let is_better = best.as_ref().is_none_or(|(_, best_vram)| vram > *best_vram);
            if is_better {
                best = Some((name, vram));
            }
        }
    }

    if best.is_none() {
        notes.push("No hardware GPU was detected; CPU-only ASR is recommended.".to_string());
    }
    best
}

fn utf16_description(raw: &[u16; 128]) -> String {
    let len = raw.iter().position(|unit| *unit == 0).unwrap_or(raw.len());
    let name = String::from_utf16_lossy(&raw[..len]).trim().to_string();
    if name.is_empty() {
        "Unknown GPU".to_string()
    } else {
        name
    }
}

fn detect_total_ram(notes: &mut Vec<String>) -> u64 {
    let mut status = MEMORYSTATUSEX {
        dwLength: size_of::<MEMORYSTATUSEX>() as u32,
        ..Default::default()
    };
    // SAFETY: `status` is a valid, correctly sized MEMORYSTATUSEX.
    match unsafe { GlobalMemoryStatusEx(&mut status) } {
        Ok(()) => status.ullTotalPhys,
        Err(error) => {
            notes.push(format!("Physical memory detection failed: {error}."));
            0
        }
    }
}

fn detect_cpu(notes: &mut Vec<String>) -> String {
    if let Ok(name) = registry_cpu_name() {
        let name = name.trim().to_string();
        if !name.is_empty() {
            return name;
        }
    }
    if let Ok(identifier) = std::env::var("PROCESSOR_IDENTIFIER") {
        let identifier = identifier.trim().to_string();
        if !identifier.is_empty() {
            return identifier;
        }
    }
    notes.push("The CPU model name could not be read.".to_string());
    "Unknown CPU".to_string()
}

fn registry_cpu_name() -> std::io::Result<String> {
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let cpu = hklm.open_subkey("HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0")?;
    cpu.get_value::<String, _>("ProcessorNameString")
}

fn tier_for(vram_bytes: u64) -> &'static str {
    if vram_bytes < 4 * GIB {
        "cpu"
    } else if vram_bytes < 6 * GIB {
        "entry"
    } else if vram_bytes < 8 * GIB {
        "mid"
    } else if vram_bytes < 12 * GIB {
        "upper"
    } else {
        "high"
    }
}

fn recommended_model(tier: &str) -> Option<&'static str> {
    match tier {
        "cpu" => Some("sensevoice-small"),
        "entry" | "mid" => Some("qwen3-asr-0.6b"),
        "upper" | "high" => Some("firered-asr2-large"),
        _ => None,
    }
}
