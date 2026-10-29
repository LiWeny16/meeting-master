use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use meeting_master_lib::audio::{coordinator::AudioCoordinator, devices::list_devices, types::*};

struct Cli {
    seconds: u64,
    output_root: Option<PathBuf>,
    pid: Option<u32>,
}

fn main() {
    let cli = match parse_args() {
        Ok(cli) => cli,
        Err(message) => {
            eprintln!("audio_poc: {message}");
            print_usage();
            std::process::exit(2);
        }
    };

    if let Err(message) = run(cli) {
        eprintln!("audio_poc: {message}");
        std::process::exit(1);
    }
}

fn run(cli: Cli) -> Result<(), String> {
    println!("Meeting Master audio proof of concept");

    match list_devices() {
        Ok(devices) => {
            println!("Detected audio devices ({}):", devices.len());
            for device in devices {
                println!(
                    "  {:<7} {}{}  {}",
                    match device.direction {
                        DeviceDirection::Render => "render",
                        DeviceDirection::Capture => "capture",
                    },
                    device.name,
                    if device.is_default { " (default)" } else { "" },
                    device.id
                );
            }
        }
        Err(error) => println!("Could not list audio devices: {}", error.to_message()),
    }

    let output_root = cli
        .output_root
        .unwrap_or_else(|| std::env::temp_dir().join("meeting-master-audio-poc"));
    let sink: Arc<dyn AudioEventSink> = Arc::new(ConsoleSink::new());
    let coordinator = AudioCoordinator::new(sink, output_root.clone());

    let request = CaptureStartRequest {
        system_device_id: None,
        microphone_device_id: None,
        application: cli.pid.map(|process_id| ApplicationTarget {
            process_id,
            include_tree: true,
        }),
        output_dir: None,
        max_seconds: Some(cli.seconds),
    };

    println!(
        "Starting capture for up to {}s (output root: {})",
        cli.seconds,
        output_root.display()
    );
    let starting = coordinator
        .start(request)
        .map_err(|error| error.to_message())?;
    println!(
        "Session {} requested; waiting for audio...",
        starting.session_id.as_deref().unwrap_or("<unknown>")
    );

    let deadline = Instant::now() + Duration::from_secs(cli.seconds.saturating_add(5));
    let mut latest = coordinator.status();
    while Instant::now() < deadline
        && !matches!(latest.state, SessionState::Completed | SessionState::Failed)
    {
        std::thread::sleep(Duration::from_millis(100));
        latest = coordinator.status();
    }
    if !matches!(latest.state, SessionState::Completed | SessionState::Failed) {
        println!("Duration reached; stopping capture.");
    }

    let final_status = coordinator.stop().map_err(|error| error.to_message())?;

    println!();
    println!("Final state: {:?}", final_status.state);
    println!(
        "Output directory: {}",
        final_status.output_dir.as_deref().unwrap_or("<none>")
    );
    println!(
        "Message: {}",
        final_status.message.as_deref().unwrap_or("<none>")
    );
    Ok(())
}

fn parse_args() -> Result<Cli, String> {
    let mut cli = Cli {
        seconds: 10,
        output_root: None,
        pid: None,
    };
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--seconds" => {
                let value = next_value(&mut args, "--seconds")?;
                cli.seconds = value
                    .parse()
                    .map_err(|_| format!("invalid --seconds value: {value}"))?;
            }
            "--output" => {
                cli.output_root = Some(PathBuf::from(next_value(&mut args, "--output")?));
            }
            "--pid" => {
                let value = next_value(&mut args, "--pid")?;
                cli.pid = Some(
                    value
                        .parse()
                        .map_err(|_| format!("invalid --pid value: {value}"))?,
                );
            }
            "--help" | "-h" => {
                print_usage();
                std::process::exit(0);
            }
            other => return Err(format!("unknown argument: {other}")),
        }
    }
    if cli.seconds == 0 {
        return Err("--seconds must be greater than zero".to_string());
    }
    Ok(cli)
}

fn next_value(args: &mut impl Iterator<Item = String>, flag: &str) -> Result<String, String> {
    args.next()
        .ok_or_else(|| format!("{flag} requires a value"))
}

fn print_usage() {
    println!(
        "Usage: cargo run --example audio_poc -- --seconds 10 [--output DIR] [--pid PID]\n\
         \n\
         --seconds N   Capture duration in seconds (the coordinator clamps it to 5..=14400).\n\
         --output DIR  Output root; each session is written to a session subdirectory.\n\
         --pid PID     Capture system audio from this process tree instead of the default output."
    );
}

struct ConsoleSink {
    levels: Mutex<LevelState>,
    last_status: Mutex<Option<CaptureStatus>>,
}

impl ConsoleSink {
    fn new() -> Self {
        Self {
            levels: Mutex::new(LevelState::default()),
            last_status: Mutex::new(None),
        }
    }
}

#[derive(Default)]
struct LevelState {
    last_print: Option<Instant>,
    rms: [f32; 2],
    peak: [f32; 2],
}

impl AudioEventSink for ConsoleSink {
    fn emit_level(&self, level: CaptureLevel) {
        let mut state = self
            .levels
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let index = source_index(level.source);
        state.rms[index] = level.rms;
        state.peak[index] = level.peak;

        let now = Instant::now();
        let due = state.last_print.map_or(true, |last| {
            now.duration_since(last) >= Duration::from_millis(250)
        });
        if !due {
            return;
        }
        state.last_print = Some(now);
        println!(
            "[level] system {} rms {:>6.3} peak {:>6.3} | microphone {} rms {:>6.3} peak {:>6.3}",
            bar(state.rms[0]),
            state.rms[0],
            state.peak[0],
            bar(state.rms[1]),
            state.rms[1],
            state.peak[1]
        );
    }

    fn emit_status(&self, status: CaptureStatus) {
        let mut last_status = self
            .last_status
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !is_transition(last_status.as_ref(), &status) {
            return;
        }
        *last_status = Some(status.clone());
        drop(last_status);

        println!(
            "[status] {:?} elapsed {:.1}s / {}s dir {}",
            status.state,
            status.elapsed_ms as f64 / 1000.0,
            status.max_seconds,
            status.output_dir.as_deref().unwrap_or("-")
        );
        for source in &status.sources {
            println!(
                "         {:<13} {:<9} device={} packets={} rms={:.3}{}",
                source.source.label(),
                format!("{:?}", source.state),
                source.device_name.as_deref().unwrap_or("-"),
                source.packets,
                source.rms,
                source
                    .message
                    .as_deref()
                    .map(|message| format!(" message={message}"))
                    .unwrap_or_default()
            );
        }
    }
}

fn is_transition(previous: Option<&CaptureStatus>, next: &CaptureStatus) -> bool {
    let Some(previous) = previous else {
        return true;
    };
    if previous.state != next.state {
        return true;
    }
    previous
        .sources
        .iter()
        .zip(next.sources.iter())
        .any(|(before, after)| {
            before.state != after.state
                || before.device_id != after.device_id
                || before.device_name != after.device_name
        })
}

fn source_index(source: SourceKind) -> usize {
    match source {
        SourceKind::SystemOutput => 0,
        SourceKind::Microphone => 1,
    }
}

fn bar(rms: f32) -> String {
    const WIDTH: usize = 16;
    let normalized = (rms.max(0.0).sqrt() * 2.0).clamp(0.0, 1.0);
    let filled = (normalized * WIDTH as f32).round() as usize;
    let filled = filled.min(WIDTH);
    format!("{}{}", "#".repeat(filled), ".".repeat(WIDTH - filled))
}
