use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use super::{TranscriptPage, TranscriptSegment};

pub const DEFAULT_TRANSCRIPT_PAGE_SIZE: usize = 50;
pub const MAX_TRANSCRIPT_PAGE_SIZE: usize = 100;

struct TranscriptFile {
    file: File,
    ids: HashSet<String>,
}

/// Durable append-only transcript store for one meeting recording.
pub struct TranscriptStore {
    path: PathBuf,
    file: Mutex<TranscriptFile>,
}

impl TranscriptStore {
    pub fn open(path: PathBuf) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                format!(
                    "Could not create transcript directory {}: {error}",
                    parent.display()
                )
            })?;
        }

        let ids = recover_transcript_file(&path)?
            .into_iter()
            .map(|segment| segment.id)
            .collect();
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|error| {
                format!(
                    "Could not open transcript store {}: {error}",
                    path.display()
                )
            })?;

        Ok(Self {
            path,
            file: Mutex::new(TranscriptFile { file, ids }),
        })
    }

    pub fn append(&self, segment: &TranscriptSegment) -> Result<bool, String> {
        let mut state = self.lock()?;
        if state.ids.contains(&segment.id) {
            return Ok(false);
        }
        let mut line = serde_json::to_vec(segment)
            .map_err(|error| format!("Could not serialize transcript segment: {error}"))?;
        line.push(b'\n');
        state.file.write_all(&line).map_err(|error| {
            format!(
                "Could not append transcript to {}: {error}",
                self.path.display()
            )
        })?;
        state.file.flush().map_err(|error| {
            format!(
                "Could not flush transcript store {}: {error}",
                self.path.display()
            )
        })?;
        state.file.sync_data().map_err(|error| {
            format!(
                "Could not durably save transcript to {}: {error}",
                self.path.display()
            )
        })?;
        state.ids.insert(segment.id.clone());
        Ok(true)
    }

    pub fn list(path: &Path) -> Result<Vec<TranscriptSegment>, String> {
        read_transcript_file(path)
    }

    /// Final segments only, for export: a half-written tail or a corrupt line is
    /// skipped instead of failing the whole file.
    pub fn final_segments(path: &Path) -> Result<Vec<TranscriptSegment>, String> {
        let bytes = match fs::read(path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => {
                return Err(format!(
                    "Could not read transcript store {}: {error}",
                    path.display()
                ));
            }
        };
        let mut segments = Vec::new();
        let mut skipped = 0usize;
        for line in bytes[..complete_bytes(&bytes)].split(|byte| *byte == b'\n') {
            if line.is_empty() {
                continue;
            }
            match serde_json::from_slice(line) {
                Ok(segment) => segments.push(segment),
                Err(_) => skipped += 1,
            }
        }
        if skipped > 0 {
            log::warn!(
                "Transcript store {} has {skipped} unreadable line(s); they were left out of the export.",
                path.display()
            );
        }
        Ok(segments)
    }

    pub fn page(mut items: Vec<TranscriptSegment>, offset: usize, limit: usize) -> TranscriptPage {
        items.sort_by(|left, right| {
            left.started_at_ms
                .cmp(&right.started_at_ms)
                .then_with(|| source_order(left.source).cmp(&source_order(right.source)))
                .then_with(|| left.id.cmp(&right.id))
        });
        let total_count = items.len();
        let offset = offset.min(total_count);
        let limit = limit.clamp(1, MAX_TRANSCRIPT_PAGE_SIZE);
        let page_items: Vec<_> = items.into_iter().skip(offset).take(limit).collect();
        let next = offset.saturating_add(page_items.len());
        let has_more = next < total_count;
        TranscriptPage {
            items: page_items,
            total_count,
            offset,
            has_more,
            next_offset: has_more.then_some(next),
        }
    }

    fn lock(&self) -> Result<MutexGuard<'_, TranscriptFile>, String> {
        self.file
            .lock()
            .map_err(|_| "The transcript store is unavailable.".to_string())
    }
}

fn source_order(source: crate::audio::types::SourceKind) -> u8 {
    match source {
        crate::audio::types::SourceKind::SystemOutput => 0,
        crate::audio::types::SourceKind::Microphone => 1,
    }
}

fn recover_transcript_file(path: &Path) -> Result<Vec<TranscriptSegment>, String> {
    let mut file = match OpenOptions::new().read(true).write(true).open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(format!(
                "Could not read transcript store {}: {error}",
                path.display()
            ));
        }
    };
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).map_err(|error| {
        format!(
            "Could not read transcript store {}: {error}",
            path.display()
        )
    })?;
    if !bytes.is_empty() && !bytes.ends_with(b"\n") {
        let last_complete = bytes
            .iter()
            .rposition(|byte| *byte == b'\n')
            .map(|index| index + 1)
            .unwrap_or(0);
        file.set_len(last_complete as u64).map_err(|error| {
            format!(
                "Could not recover transcript store {}: {error}",
                path.display()
            )
        })?;
        bytes.truncate(last_complete);
    }
    file.seek(SeekFrom::Start(0)).map_err(|error| {
        format!(
            "Could not seek transcript store {}: {error}",
            path.display()
        )
    })?;
    parse_lines(path, &bytes)
}

fn read_transcript_file(path: &Path) -> Result<Vec<TranscriptSegment>, String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(format!(
                "Could not read transcript store {}: {error}",
                path.display()
            ));
        }
    };
    parse_lines(path, &bytes[..complete_bytes(&bytes)])
}

fn complete_bytes(bytes: &[u8]) -> usize {
    if bytes.ends_with(b"\n") {
        bytes.len()
    } else {
        bytes
            .iter()
            .rposition(|byte| *byte == b'\n')
            .map(|index| index + 1)
            .unwrap_or(0)
    }
}

fn parse_lines(path: &Path, bytes: &[u8]) -> Result<Vec<TranscriptSegment>, String> {
    let mut segments = Vec::new();
    for (index, line) in bytes.split(|byte| *byte == b'\n').enumerate() {
        if line.is_empty() {
            continue;
        }
        let segment = serde_json::from_slice(line).map_err(|error| {
            format!(
                "Transcript store {} has invalid entry {}: {error}",
                path.display(),
                index + 1
            )
        })?;
        segments.push(segment);
    }
    Ok(segments)
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use crate::audio::types::SourceKind;

    use super::*;

    struct TempTranscript(PathBuf);

    impl TempTranscript {
        fn new() -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or_default();
            Self(std::env::temp_dir().join(format!(
                "meeting-master-transcript-{}-{nonce}.jsonl",
                std::process::id()
            )))
        }
    }

    impl Drop for TempTranscript {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.0);
        }
    }

    fn segment(id: &str, text: &str, started_at_ms: i64) -> TranscriptSegment {
        TranscriptSegment {
            id: id.to_string(),
            meeting_id: "meeting-1".to_string(),
            session_id: "session-1".to_string(),
            turn_id: id.to_string(),
            source: SourceKind::Microphone,
            text: text.to_string(),
            sequence: 2,
            start_frame: 0,
            end_frame: 16_000,
            started_at_ms,
            ended_at_ms: started_at_ms + 1_000,
        }
    }

    #[test]
    fn appends_durably_and_deduplicates_final_turns() {
        let temp = TempTranscript::new();
        let store = TranscriptStore::open(temp.0.clone()).expect("open store");
        let row = segment("turn-1", "hello", 10);
        assert!(store.append(&row).expect("append"));
        assert!(!store.append(&row).expect("deduplicate"));
        drop(store);

        let rows = TranscriptStore::list(&temp.0).expect("read rows");
        assert_eq!(rows, vec![row]);
    }

    #[test]
    fn pagination_reports_total_and_next_offset() {
        let rows = vec![segment("b", "second", 20), segment("a", "first", 10)];
        let page = TranscriptStore::page(rows, 0, 1);
        assert_eq!(page.items[0].id, "a");
        assert_eq!(page.total_count, 2);
        assert!(page.has_more);
        assert_eq!(page.next_offset, Some(1));
    }

    #[test]
    fn open_discards_an_incomplete_tail_after_interrupted_write() {
        let temp = TempTranscript::new();
        fs::write(&temp.0, b"{\"broken\"").expect("write partial tail");
        let store = TranscriptStore::open(temp.0.clone()).expect("recover partial line");
        let row = segment("turn-1", "hello", 10);
        store.append(&row).expect("append after recovery");
        assert_eq!(TranscriptStore::list(&temp.0).unwrap(), vec![row]);
    }
}
