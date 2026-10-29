use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::process::Command;

use chrono::{Local, TimeZone};

use crate::audio::types::{ASR_SAMPLE_RATE, SourceKind};

use super::{Meeting, TranscriptExport, TranscriptSegment};

const EXPORT_DIR_NAME: &str = "exports";
const SLUG_MAX_CHARS: usize = 60;
const NAME_ATTEMPTS: u32 = 50;
const INVALID_SLUG_CHARS: [char; 9] = ['\\', '/', ':', '*', '?', '"', '<', '>', '|'];
const NATIVE_ONLY: &str = "Revealing files in Explorer requires the Windows desktop app.";
const OUTSIDE_DATA: &str = "That path is outside the meeting data folder.";

pub fn dir(data_root: &Path) -> PathBuf {
    data_root.join(EXPORT_DIR_NAME)
}

pub fn write(
    meeting: &Meeting,
    segments: &[TranscriptSegment],
    exports_dir: &Path,
) -> Result<TranscriptExport, String> {
    if segments.is_empty() {
        return Err("This meeting has no transcript to export.".to_string());
    }
    let mut ordered: Vec<&TranscriptSegment> = segments.iter().collect();
    ordered.sort_by_key(|segment| segment.sequence);

    let timestamp = meeting.ended_at.unwrap_or(meeting.created_at);
    let stamp = format_local(timestamp, "%Y%m%d-%H%M%S")?;
    let date = format_local(timestamp, "%Y-%m-%d %H:%M")?;
    let body = render(meeting, &date, &ordered);

    fs::create_dir_all(exports_dir)
        .map_err(|error| format!("Could not create {}: {error}", exports_dir.display()))?;
    let path = write_new_file(exports_dir, &slug(&meeting.title), &stamp, body.as_bytes())?;

    Ok(TranscriptExport {
        path: path.to_string_lossy().into_owned(),
        file_name: path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
        segment_count: ordered.len(),
        bytes: body.len() as u64,
    })
}

// The webview can hand this command any path, so only existing files inside
// <data root>/exports are revealed; everything else is refused.
pub fn reveal(path: &str, data_root: &Path) -> Result<(), String> {
    if !cfg!(windows) {
        return Err(NATIVE_ONLY.to_string());
    }
    let target = fs::canonicalize(path).map_err(|error| match error.kind() {
        ErrorKind::NotFound => format!("That file no longer exists: {path}"),
        _ => format!("Could not open Explorer: {error}"),
    })?;
    let exports_dir = dir(data_root);
    let allowed_root = fs::canonicalize(&exports_dir).unwrap_or(exports_dir);
    if !target.starts_with(&allowed_root) || !target.is_file() {
        return Err(OUTSIDE_DATA.to_string());
    }
    Command::new("explorer.exe")
        .arg(format!("/select,{}", target.display()))
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Could not open Explorer: {error}"))
}

fn render(meeting: &Meeting, date: &str, segments: &[&TranscriptSegment]) -> String {
    let mut body = String::new();
    push_line(&mut body, &format!("Title: {}", meeting.title));
    push_line(&mut body, &format!("Meeting ID: {}", meeting.id));
    push_line(&mut body, &format!("Date: {date}"));
    push_line(&mut body, &format!("Segments: {}", segments.len()));
    push_line(&mut body, "");
    for segment in segments {
        let line = format!(
            "[{}] {}: {}",
            clock(segment.start_frame),
            source_key(segment.source),
            single_line(&segment.text)
        );
        push_line(&mut body, &line);
    }
    body
}

fn push_line(body: &mut String, line: &str) {
    body.push_str(line);
    body.push_str("\r\n");
}

fn clock(start_frame: u64) -> String {
    let total_seconds = start_frame / ASR_SAMPLE_RATE as u64;
    format!(
        "{:02}:{:02}:{:02}",
        total_seconds / 3600,
        (total_seconds / 60) % 60,
        total_seconds % 60
    )
}

fn source_key(source: SourceKind) -> &'static str {
    match source {
        SourceKind::SystemOutput => "system-output",
        SourceKind::Microphone => "microphone",
    }
}

fn single_line(text: &str) -> String {
    text.replace(['\r', '\n'], " ")
}

fn slug(title: &str) -> String {
    let mut slug = String::new();
    for character in title.chars() {
        let character = if character.is_control() || INVALID_SLUG_CHARS.contains(&character) {
            '-'
        } else {
            character
        };
        if character == '-' && slug.ends_with('-') {
            continue;
        }
        slug.push(character);
    }
    let bounded: String = slug
        .trim_matches(|character: char| {
            character == '-' || character == '.' || character.is_whitespace()
        })
        .chars()
        .take(SLUG_MAX_CHARS)
        .collect();
    let bounded = bounded.trim_end_matches(['-', '.']);
    if bounded.is_empty() {
        "meeting".to_string()
    } else {
        bounded.to_string()
    }
}

fn format_local(timestamp_ms: i64, format: &str) -> Result<String, String> {
    Local
        .timestamp_millis_opt(timestamp_ms)
        .single()
        .map(|time| time.format(format).to_string())
        .ok_or_else(|| format!("Could not format the meeting date {timestamp_ms}."))
}

fn write_new_file(
    exports_dir: &Path,
    slug: &str,
    stamp: &str,
    bytes: &[u8],
) -> Result<PathBuf, String> {
    let base = format!("{stamp}__{slug}");
    for attempt in 1..=NAME_ATTEMPTS {
        let name = if attempt == 1 {
            format!("{base}.txt")
        } else {
            format!("{base}-{attempt}.txt")
        };
        let path = exports_dir.join(&name);
        if path.exists() {
            continue;
        }
        let temporary = exports_dir.join(format!("{name}.tmp"));
        if let Err(error) = fs::write(&temporary, bytes) {
            let _ = fs::remove_file(&temporary);
            return Err(format!("Could not write {}: {error}", path.display()));
        }
        match fs::rename(&temporary, &path) {
            Ok(()) => return Ok(path),
            Err(error) => {
                let _ = fs::remove_file(&temporary);
                return Err(format!("Could not write {}: {error}", path.display()));
            }
        }
    }
    Err(format!(
        "Could not pick a free export file name in {}.",
        exports_dir.display()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    struct TempExports(PathBuf);

    impl TempExports {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "meeting-master-exports-{}-{}",
                std::process::id(),
                COUNTER.fetch_add(1, Ordering::Relaxed)
            ));
            let _ = fs::remove_dir_all(&dir);
            Self(dir)
        }
    }

    impl Drop for TempExports {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn meeting(title: &str) -> Meeting {
        Meeting {
            id: "meeting-1700000000000-0001".to_string(),
            title: title.to_string(),
            agenda: String::new(),
            created_at: 1_700_000_000_000,
            started_at: Some(1_700_000_000_000),
            ended_at: Some(1_700_000_060_000),
            status: "completed".to_string(),
            recording_dir: None,
            capture_state: None,
            capture_error: None,
            summary: String::new(),
            tags: Vec::new(),
            participants: 0,
            identity_id: None,
            actions: Vec::new(),
        }
    }

    fn segment(
        sequence: u64,
        source: SourceKind,
        text: &str,
        start_frame: u64,
    ) -> TranscriptSegment {
        TranscriptSegment {
            id: format!("turn-{sequence}"),
            meeting_id: "meeting-1700000000000-0001".to_string(),
            session_id: "session-1".to_string(),
            turn_id: format!("turn-{sequence}"),
            source,
            text: text.to_string(),
            sequence,
            start_frame,
            end_frame: start_frame + 16_000,
            started_at_ms: 0,
            ended_at_ms: 0,
        }
    }

    #[test]
    fn slug_strips_path_characters_and_falls_back_to_meeting() {
        assert_eq!(slug("  Q3 / Review: *draft*?  "), "Q3 - Review- -draft");
        assert_eq!(slug("会议 / 排期"), "会议 - 排期");
        assert_eq!(slug("  ...  "), "meeting");
        assert_eq!(slug(&"a".repeat(90)).chars().count(), SLUG_MAX_CHARS);
    }

    #[test]
    fn export_writes_headed_crlf_file_and_never_overwrites() {
        let temp = TempExports::new();
        let meeting = meeting("Q3 / Review: *draft*?");
        let segments = vec![
            segment(2, SourceKind::Microphone, "Second point", 16_000),
            segment(1, SourceKind::SystemOutput, "First point", 0),
        ];

        let first = write(&meeting, &segments, &temp.0).expect("write first export");
        assert_eq!(first.segment_count, 2);
        let body = fs::read_to_string(&first.path).expect("read export");
        assert_eq!(body.len() as u64, first.bytes);
        let lines: Vec<&str> = body.split("\r\n").collect();
        assert_eq!(lines.len(), segments.len() + 6);
        assert_eq!(lines[0], "Title: Q3 / Review: *draft*?");
        assert_eq!(lines[1], "Meeting ID: meeting-1700000000000-0001");
        assert_eq!(lines[3], "Segments: 2");
        assert_eq!(lines[4], "");
        assert_eq!(lines[5], "[00:00:00] system-output: First point");
        assert_eq!(lines[6], "[00:00:01] microphone: Second point");
        assert_eq!(lines[7], "");
        assert!(first.file_name.ends_with(".txt"));

        let second = write(&meeting, &segments, &temp.0).expect("write second export");
        assert_ne!(second.file_name, first.file_name);
        assert!(second.file_name.ends_with("-2.txt"));
        assert_eq!(
            fs::read_to_string(&first.path).expect("read first export"),
            body
        );
    }

    #[test]
    fn export_refuses_a_meeting_without_final_segments() {
        let temp = TempExports::new();
        let error = write(&meeting("Empty"), &[], &temp.0).expect_err("refuse empty export");
        assert_eq!(error, "This meeting has no transcript to export.");
        assert!(!temp.0.exists());
    }

    #[test]
    fn reveal_refuses_paths_outside_the_exports_folder() {
        let temp = TempExports::new();
        let root = temp.0.join("data");
        let exports = dir(&root);
        fs::create_dir_all(&exports).expect("create exports folder");
        let inside = exports.join("notes.txt");
        fs::write(&inside, b"x").expect("write export");
        let outside = root.join("meetings.json");
        fs::write(&outside, b"{}").expect("write store");

        assert_eq!(
            reveal(&outside.to_string_lossy(), &root).expect_err("refuse outside path"),
            OUTSIDE_DATA
        );
        assert_eq!(
            reveal(&root.to_string_lossy(), &root).expect_err("refuse folder"),
            OUTSIDE_DATA
        );
        let missing = exports.join("missing.txt");
        assert_eq!(
            reveal(&missing.to_string_lossy(), &root).expect_err("refuse missing file"),
            format!("That file no longer exists: {}", missing.to_string_lossy())
        );
    }
}
