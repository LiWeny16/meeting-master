use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use super::export;
use super::transcript::{DEFAULT_TRANSCRIPT_PAGE_SIZE, MAX_TRANSCRIPT_PAGE_SIZE, TranscriptStore};
use super::{
    CAPTURE_FAILED, CAPTURE_STARTING, INTERRUPTED_CAPTURE_ERROR, MEETING_MISSING, Meeting,
    MeetingAction, MeetingCreateInput, STATUS_COMPLETED, STATUS_IN_PROGRESS, STATUS_UPCOMING,
    TranscriptExport, TranscriptPage, TranscriptSegment,
};

static ID_COUNTER: AtomicU32 = AtomicU32::new(0);

pub struct MeetingsState {
    inner: Mutex<StoreData>,
}

struct StoreData {
    path: PathBuf,
    meetings: Vec<Meeting>,
}

impl MeetingsState {
    pub fn new(app: &tauri::AppHandle) -> Result<Self, String> {
        // `<install|repo>/data/meetings.json` — same tree as the recordings.
        let data_dir = crate::paths::data_root(app)?;
        Self::from_path(data_dir.join("meetings.json"))
    }

    pub fn from_path(path: PathBuf) -> Result<Self, String> {
        ensure_parent(&path)?;
        let mut meetings = read_meetings(&path)?;
        let mut dirty = reconcile_interrupted(&mut meetings);
        // `recordingDir` used to be persisted as an absolute path, which rots as
        // soon as the data root moves. Repair it to the canonical location.
        if let Some(root) = path.parent() {
            let recordings = root.join("recordings").join("meetings");
            for meeting in meetings.iter_mut() {
                let derived = recordings.join(&meeting.id);
                if derived.is_dir() {
                    let next = derived.to_string_lossy().to_string();
                    if meeting.recording_dir.as_deref() != Some(next.as_str()) {
                        meeting.recording_dir = Some(next);
                        dirty = true;
                    }
                }
            }
        }
        if dirty {
            write_meetings(&path, &meetings)?;
        }
        Ok(Self {
            inner: Mutex::new(StoreData { path, meetings }),
        })
    }

    pub fn list(&self) -> Result<Vec<Meeting>, String> {
        let data = self.lock()?;
        let mut meetings = data.meetings.clone();
        meetings.sort_by(|left, right| right.created_at.cmp(&left.created_at));
        Ok(meetings)
    }

    pub fn get(&self, id: &str) -> Result<Option<Meeting>, String> {
        let data = self.lock()?;
        Ok(data
            .meetings
            .iter()
            .find(|meeting| meeting.id == id)
            .cloned())
    }

    /// Removes the meeting record. Recording files are the caller's job: deleting
    /// a row and deleting a directory must be two explicit steps.
    pub fn remove(&self, id: &str) -> Result<Option<Meeting>, String> {
        let mut data = self.lock()?;
        let Some(index) = data.meetings.iter().position(|meeting| meeting.id == id) else {
            return Ok(None);
        };
        let removed = data.meetings.remove(index);
        write_meetings(&data.path, &data.meetings)?;
        Ok(Some(removed))
    }

    pub fn create(&self, input: MeetingCreateInput) -> Result<Meeting, String> {
        let MeetingCreateInput { title, agenda, .. } = input;
        let created_at = now_ms();
        let meeting = Meeting {
            id: new_id(created_at),
            title: normalize_title(title),
            agenda,
            created_at,
            started_at: None,
            ended_at: None,
            status: STATUS_UPCOMING.to_string(),
            recording_dir: None,
            capture_state: None,
            capture_error: None,
            summary: String::new(),
            tags: Vec::new(),
            participants: 0,
            actions: Vec::new(),
        };
        let created = meeting.clone();
        self.mutate(move |meetings| {
            meetings.push(meeting);
            Ok(())
        })?;
        Ok(created)
    }

    pub fn begin_start(&self, id: &str) -> Result<Meeting, String> {
        self.mutate(|meetings| {
            let meeting = find_mut(meetings, id)?;
            match meeting.status.as_str() {
                STATUS_IN_PROGRESS => {
                    return Err("This meeting is already recording.".to_string());
                }
                STATUS_COMPLETED => {
                    return Err("This meeting has already ended.".to_string());
                }
                _ => {}
            }
            meeting.status = STATUS_IN_PROGRESS.to_string();
            meeting.started_at = Some(now_ms());
            meeting.ended_at = None;
            meeting.capture_state = Some(CAPTURE_STARTING.to_string());
            meeting.capture_error = None;
            Ok(meeting.clone())
        })
    }

    pub fn confirm_start(
        &self,
        id: &str,
        capture_state: String,
        recording_dir: Option<String>,
    ) -> Result<Meeting, String> {
        self.mutate(|meetings| {
            let meeting = find_mut(meetings, id)?;
            meeting.capture_state = Some(capture_state);
            if let Some(recording_dir) = recording_dir {
                meeting.recording_dir = Some(recording_dir);
            }
            meeting.capture_error = None;
            Ok(meeting.clone())
        })
    }

    pub fn fail_start(&self, id: &str, message: String) -> Result<Meeting, String> {
        self.mutate(|meetings| {
            let meeting = find_mut(meetings, id)?;
            meeting.status = STATUS_UPCOMING.to_string();
            meeting.started_at = None;
            meeting.ended_at = None;
            meeting.capture_state = Some(CAPTURE_FAILED.to_string());
            meeting.capture_error = Some(message);
            Ok(meeting.clone())
        })
    }

    pub fn complete(
        &self,
        id: &str,
        capture_state: Option<String>,
        recording_dir: Option<String>,
        capture_error: Option<String>,
    ) -> Result<Meeting, String> {
        self.mutate(|meetings| {
            let meeting = find_mut(meetings, id)?;
            if meeting.status.as_str() != STATUS_IN_PROGRESS {
                return Ok(meeting.clone());
            }
            meeting.status = STATUS_COMPLETED.to_string();
            meeting.ended_at = Some(now_ms());
            if let Some(capture_state) = capture_state {
                meeting.capture_state = Some(capture_state);
            }
            if let Some(recording_dir) = recording_dir {
                meeting.recording_dir = Some(recording_dir);
            }
            meeting.capture_error = capture_error;
            Ok(meeting.clone())
        })
    }

    /// Persist a transcript summary written by a meeting assistant action.
    pub fn update_summary(&self, id: &str, summary: String) -> Result<Meeting, String> {
        self.mutate(|meetings| {
            let meeting = find_mut(meetings, id)?;
            meeting.summary = summary;
            Ok(meeting.clone())
        })
    }

    /// Replaces the title only: the recording directory, its audio and the
    /// transcript keep their names, and the list order stays keyed on created_at.
    pub fn rename(&self, id: &str, title: String) -> Result<Meeting, String> {
        self.mutate(|meetings| {
            let meeting = meetings
                .iter_mut()
                .find(|meeting| meeting.id == id)
                .ok_or_else(|| MEETING_MISSING.to_string())?;
            meeting.title = title;
            Ok(meeting.clone())
        })
    }

    /// Clears the recap text and keeps the action items.
    pub fn clear_summary(&self, id: &str) -> Result<Meeting, String> {
        self.mutate(|meetings| {
            let meeting = meetings
                .iter_mut()
                .find(|meeting| meeting.id == id)
                .ok_or_else(|| MEETING_MISSING.to_string())?;
            meeting.summary.clear();
            Ok(meeting.clone())
        })
    }

    pub fn export_transcript(&self, id: &str) -> Result<TranscriptExport, String> {
        let meeting = self.get(id)?.ok_or_else(|| MEETING_MISSING.to_string())?;
        let segments = match meeting.recording_dir.as_deref() {
            Some(directory) => {
                TranscriptStore::final_segments(&Path::new(directory).join("transcript.jsonl"))?
            }
            None => Vec::new(),
        };
        export::write(&meeting, &segments, &export::dir(&self.data_dir()?))
    }

    /// Upsert action items by stable ID while retaining existing items omitted from this batch.
    pub fn set_actions(&self, id: &str, actions: Vec<MeetingAction>) -> Result<Meeting, String> {
        self.mutate(|meetings| {
            let meeting = find_mut(meetings, id)?;
            let transcript_ids: std::collections::HashSet<String> = match meeting
                .recording_dir
                .as_deref()
            {
                Some(directory) => TranscriptStore::list(
                    &Path::new(directory).join("transcript.jsonl"),
                )?
                .into_iter()
                .map(|segment| segment.id)
                .collect(),
                None => std::collections::HashSet::new(),
            };
            for mut action in actions {
                action.id = action.id.trim().to_string();
                action.text = action.text.trim().to_string();
                if action.id.is_empty() {
                    return Err("Each meeting action needs a stable ID.".to_string());
                }
                if action.text.is_empty() {
                    return Err(format!("Meeting action {} needs text.", action.id));
                }
                action.source_segment_ids.sort();
                action.source_segment_ids.dedup();
                if let Some(missing) = action
                    .source_segment_ids
                    .iter()
                    .find(|source_id| !transcript_ids.contains(*source_id))
                {
                    return Err(format!(
                        "Meeting action {} references transcript segment {missing}, which is not saved for this meeting.",
                        action.id
                    ));
                }
                action.owner = action
                    .owner
                    .map(|owner| owner.trim().to_string())
                    .filter(|owner| !owner.is_empty());
                action.due_date = action
                    .due_date
                    .map(|date| date.trim().to_string())
                    .filter(|date| !date.is_empty());
                if let Some(existing) = meeting.actions.iter_mut().find(|item| item.id == action.id) {
                    *existing = action;
                } else {
                    meeting.actions.push(action);
                }
            }
            Ok(meeting.clone())
        })
    }

    /// Return a bounded page of durable final transcript segments for one meeting.
    pub fn transcript_list(
        &self,
        id: &str,
        offset: usize,
        limit: usize,
    ) -> Result<TranscriptPage, String> {
        let meeting = self
            .get(id)?
            .ok_or_else(|| "Meeting not found.".to_string())?;
        let items = match meeting.recording_dir.as_deref() {
            Some(directory) => {
                TranscriptStore::list(&Path::new(directory).join("transcript.jsonl"))?
            }
            None => Vec::new(),
        };
        Ok(TranscriptStore::page(
            items,
            offset,
            normalized_limit(limit),
        ))
    }

    /// Fetch one saved final segment by its stable transcript ID.
    pub fn transcript_get_by_id(
        &self,
        meeting_id: &str,
        segment_id: &str,
    ) -> Result<Option<TranscriptSegment>, String> {
        let meeting = self
            .get(meeting_id)?
            .ok_or_else(|| "Meeting not found.".to_string())?;
        let Some(directory) = meeting.recording_dir.as_deref() else {
            return Ok(None);
        };
        TranscriptStore::list(&Path::new(directory).join("transcript.jsonl")).map(|segments| {
            segments
                .into_iter()
                .find(|segment| segment.id == segment_id)
        })
    }

    /// Search transcript text in one meeting or across all meetings.
    pub fn transcript_search(
        &self,
        query: &str,
        meeting_id: Option<&str>,
        offset: usize,
        limit: usize,
    ) -> Result<TranscriptPage, String> {
        let query = query.trim();
        if query.is_empty() {
            return Ok(TranscriptStore::page(
                Vec::new(),
                0,
                normalized_limit(limit),
            ));
        }
        let meetings = match meeting_id {
            Some(id) => vec![
                self.get(id)?
                    .ok_or_else(|| "Meeting not found.".to_string())?,
            ],
            None => self.list()?,
        };
        let needle = query.to_lowercase();
        let mut matches = Vec::new();
        for meeting in meetings {
            let Some(directory) = meeting.recording_dir.as_deref() else {
                continue;
            };
            for segment in TranscriptStore::list(&Path::new(directory).join("transcript.jsonl"))? {
                if segment.text.to_lowercase().contains(&needle) {
                    matches.push(segment);
                }
            }
        }
        Ok(TranscriptStore::page(
            matches,
            offset,
            normalized_limit(limit),
        ))
    }

    fn lock(&self) -> Result<MutexGuard<'_, StoreData>, String> {
        self.inner
            .lock()
            .map_err(|_| "The meeting store is unavailable.".to_string())
    }

    fn data_dir(&self) -> Result<PathBuf, String> {
        let data = self.lock()?;
        Ok(data
            .path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from(".")))
    }

    fn mutate<T>(
        &self,
        mutate: impl FnOnce(&mut Vec<Meeting>) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut data = self.lock()?;
        let mut meetings = data.meetings.clone();
        let value = mutate(&mut meetings)?;
        write_meetings(&data.path, &meetings)?;
        data.meetings = meetings;
        Ok(value)
    }
}

fn find_mut<'a>(meetings: &'a mut [Meeting], id: &str) -> Result<&'a mut Meeting, String> {
    meetings
        .iter_mut()
        .find(|meeting| meeting.id == id)
        .ok_or_else(|| "Meeting not found.".to_string())
}

fn normalize_title(title: String) -> String {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        "Untitled meeting".to_string()
    } else {
        trimmed.to_string()
    }
}

fn normalized_limit(limit: usize) -> usize {
    if limit == 0 {
        DEFAULT_TRANSCRIPT_PAGE_SIZE
    } else {
        limit.min(MAX_TRANSCRIPT_PAGE_SIZE)
    }
}

fn new_id(created_at: i64) -> String {
    let counter = ID_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("meeting-{created_at}-{:04x}", counter & 0xffff)
}

fn reconcile_interrupted(meetings: &mut [Meeting]) -> bool {
    let mut changed = false;
    for meeting in meetings
        .iter_mut()
        .filter(|meeting| meeting.status.as_str() == STATUS_IN_PROGRESS)
    {
        meeting.status = STATUS_COMPLETED.to_string();
        meeting.ended_at = meeting.started_at;
        meeting.capture_state = Some(CAPTURE_FAILED.to_string());
        meeting.capture_error = Some(INTERRUPTED_CAPTURE_ERROR.to_string());
        changed = true;
    }
    changed
}

fn ensure_parent(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|error| {
                format!(
                    "Could not create the meetings directory {}: {error}",
                    parent.display()
                )
            })?;
        }
    }
    Ok(())
}

fn read_meetings(path: &Path) -> Result<Vec<Meeting>, String> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(format!(
                "Could not read the meetings store {}: {error}",
                path.display()
            ));
        }
    };
    match serde_json::from_str(&raw) {
        Ok(meetings) => Ok(meetings),
        Err(error) => {
            let backup = backup_corrupt(path)?;
            log::warn!(
                "meetings store {} is unreadable ({error}); moved it to {}",
                path.display(),
                backup.display()
            );
            Ok(Vec::new())
        }
    }
}

fn backup_corrupt(path: &Path) -> Result<PathBuf, String> {
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "meetings.json".to_string());
    let backup = path.with_file_name(format!("{file_name}.corrupt-{}", now_ms()));
    fs::rename(path, &backup).map_err(|error| {
        format!(
            "Could not back up the unreadable meetings store {}: {error}",
            path.display()
        )
    })?;
    Ok(backup)
}

fn write_meetings(path: &Path, meetings: &[Meeting]) -> Result<(), String> {
    let mut json = serde_json::to_string_pretty(meetings)
        .map_err(|error| format!("Could not serialize meetings: {error}"))?;
    json.push('\n');
    fs::write(path, json)
        .map_err(|error| format!("Could not save meetings to {}: {error}", path.display()))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    static TEMP_COUNTER: AtomicU32 = AtomicU32::new(0);

    struct TempStore {
        dir: PathBuf,
    }

    impl TempStore {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "meeting-master-meetings-{name}-{}-{}",
                std::process::id(),
                TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
            ));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).expect("create temporary test directory");
            Self { dir }
        }

        fn path(&self) -> PathBuf {
            self.dir.join("meetings.json")
        }
    }

    impl Drop for TempStore {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    fn input(title: &str, agenda: &str) -> MeetingCreateInput {
        MeetingCreateInput {
            title: title.to_string(),
            agenda: agenda.to_string(),
            identity_id: None,
            knowledge_ids: None,
        }
    }

    #[test]
    fn create_meeting_round_trips_through_disk() {
        let temp = TempStore::new("round-trip");
        let state = MeetingsState::from_path(temp.path()).expect("open store");

        let created = state
            .create(input("Weekly sync", "Roadmap and blockers"))
            .expect("create meeting");
        assert_eq!(created.status, STATUS_UPCOMING);
        assert!(created.created_at > 0);
        assert!(created.started_at.is_none());
        assert!(created.recording_dir.is_none());
        assert_eq!(created.participants, 0);
        drop(state);

        let json = fs::read_to_string(temp.path()).expect("read store file");
        assert!(json.contains("\"createdAt\""));

        let reloaded = MeetingsState::from_path(temp.path()).expect("reload store");
        let meetings = reloaded.list().expect("list meetings");
        assert_eq!(meetings.len(), 1);
        assert_eq!(meetings[0], created);
        assert_eq!(
            reloaded
                .get(&created.id)
                .expect("lookup meeting")
                .expect("meeting present")
                .agenda,
            "Roadmap and blockers"
        );
    }

    #[test]
    fn stale_in_progress_meeting_is_reconciled_on_load() {
        let temp = TempStore::new("stale");
        let state = MeetingsState::from_path(temp.path()).expect("open store");
        let created = state
            .create(input("Interrupted", ""))
            .expect("create meeting");
        let started = state.begin_start(&created.id).expect("start meeting");
        assert_eq!(started.status, STATUS_IN_PROGRESS);
        assert!(started.started_at.is_some());
        drop(state);

        let reloaded = MeetingsState::from_path(temp.path()).expect("reload store");
        let reconciled = reloaded
            .get(&created.id)
            .expect("lookup meeting")
            .expect("meeting present");
        assert_eq!(reconciled.status, STATUS_COMPLETED);
        assert_eq!(reconciled.ended_at, reconciled.started_at);
        assert_eq!(reconciled.capture_state.as_deref(), Some(CAPTURE_FAILED));
        assert_eq!(
            reconciled.capture_error.as_deref(),
            Some(INTERRUPTED_CAPTURE_ERROR)
        );

        let json = fs::read_to_string(temp.path()).expect("read store file");
        let persisted: Vec<Meeting> = serde_json::from_str(&json).expect("parse store file");
        assert_eq!(persisted[0].status, STATUS_COMPLETED);
    }

    #[test]
    fn blank_title_falls_back_to_untitled() {
        let temp = TempStore::new("untitled");
        let state = MeetingsState::from_path(temp.path()).expect("open store");

        let meeting = state.create(input(" \n\t ", "")).expect("create meeting");
        assert_eq!(meeting.title, "Untitled meeting");
        assert_eq!(meeting.agenda, "");
    }

    #[test]
    fn corrupt_store_is_backed_up_instead_of_deleted() {
        let temp = TempStore::new("corrupt");
        fs::write(temp.path(), "{ not valid json").expect("write corrupt store");

        let state = MeetingsState::from_path(temp.path()).expect("open store");
        assert!(state.list().expect("list meetings").is_empty());

        let backups: Vec<PathBuf> = fs::read_dir(&temp.dir)
            .expect("read temp dir")
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.contains(".corrupt-"))
            })
            .collect();
        assert_eq!(backups.len(), 1);
        assert_eq!(
            fs::read_to_string(&backups[0]).expect("read backup"),
            "{ not valid json"
        );
    }

    #[test]
    fn transcript_reads_and_cited_actions_survive_store_reload() {
        let temp = TempStore::new("transcript-actions");
        let state = MeetingsState::from_path(temp.path()).expect("open store");
        let meeting = state.create(input("Planning", "")).expect("create meeting");
        let recording_dir = temp.dir.join("recording");
        fs::create_dir_all(&recording_dir).expect("create recording directory");
        let transcript_path = recording_dir.join("transcript.jsonl");
        let transcript = TranscriptStore::open(transcript_path).expect("open transcript");
        transcript
            .append(&TranscriptSegment {
                id: "turn-1".to_string(),
                meeting_id: meeting.id.clone(),
                session_id: "session-1".to_string(),
                turn_id: "turn-1".to_string(),
                source: crate::audio::types::SourceKind::Microphone,
                text: "We will ship the report on Friday.".to_string(),
                sequence: 4,
                start_frame: 0,
                end_frame: 16_000,
                started_at_ms: 100,
                ended_at_ms: 1_100,
            })
            .expect("append transcript");
        drop(transcript);
        state
            .mutate(|meetings| {
                find_mut(meetings, &meeting.id)?.recording_dir =
                    Some(recording_dir.to_string_lossy().into_owned());
                Ok(())
            })
            .expect("attach recording");

        let listed = state
            .transcript_list(&meeting.id, 0, 10)
            .expect("list transcript");
        assert_eq!(listed.total_count, 1);
        assert_eq!(listed.items[0].id, "turn-1");
        let searched = state
            .transcript_search("ship the report", Some(meeting.id.as_str()), 0, 10)
            .expect("search transcript");
        assert_eq!(searched.items.len(), 1);
        assert_eq!(
            state
                .transcript_get_by_id(&meeting.id, "turn-1")
                .expect("fetch transcript segment")
                .expect("segment exists")
                .text,
            "We will ship the report on Friday."
        );
        assert!(
            state
                .transcript_get_by_id(&meeting.id, "missing")
                .expect("look up missing transcript segment")
                .is_none()
        );

        state
            .update_summary(&meeting.id, "Ship the report Friday.".to_string())
            .expect("save summary");
        let action = MeetingAction {
            id: "action-1".to_string(),
            text: "Ship the report".to_string(),
            owner: Some("Ari".to_string()),
            due_date: Some("Friday".to_string()),
            completed: false,
            source_segment_ids: vec!["turn-1".to_string()],
        };
        state
            .set_actions(&meeting.id, vec![action.clone()])
            .expect("save action");
        state
            .set_actions(&meeting.id, vec![action])
            .expect("idempotently save action");
        drop(state);

        let reloaded = MeetingsState::from_path(temp.path()).expect("reload store");
        let saved = reloaded
            .get(&meeting.id)
            .expect("lookup meeting")
            .expect("meeting exists");
        assert_eq!(saved.summary, "Ship the report Friday.");
        assert_eq!(saved.actions.len(), 1);
        assert_eq!(
            saved.actions[0].source_segment_ids,
            vec!["turn-1".to_string()]
        );
    }
}
