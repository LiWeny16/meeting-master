//! Local, editable meeting roles.
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf, sync::Mutex};
use tauri::State;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    id: String,
    name: String,
    role: String,
    context: String,
    goals: Vec<String>,
    tone: String,
    guardrails: String,
    initials: String,
}

pub struct IdentityState {
    path: PathBuf,
    lock: Mutex<()>,
}

impl IdentityState {
    pub fn new(root: PathBuf) -> Self {
        Self {
            path: root.join("identities.json"),
            lock: Mutex::new(()),
        }
    }
    fn read(&self) -> Result<Vec<Identity>, String> {
        match fs::read(&self.path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|e| format!("Could not read identity settings: {e}")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(defaults()),
            Err(e) => Err(format!("Could not read identity settings: {e}")),
        }
    }
    fn write(&self, items: &[Identity]) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(items).map_err(|e| e.to_string())?;
        let temp = self.path.with_extension("json.tmp");
        fs::write(&temp, bytes).map_err(|e| format!("Could not write identities: {e}"))?;
        fs::rename(&temp, &self.path).map_err(|e| format!("Could not save identities: {e}"))
    }
}

fn defaults() -> Vec<Identity> {
    [
        (
            "candidate",
            "面试者",
            "参加面试的候选人",
            "清楚表达经验、理解问题并提出合理的问题",
        ),
        (
            "lead",
            "模块负责人",
            "负责模块交付和技术决策",
            "明确目标、风险、依赖和下一步行动",
        ),
        (
            "interviewer",
            "面试官",
            "评估候选人并主持面试",
            "公平评估能力、追问证据并记录结论",
        ),
    ]
    .into_iter()
    .map(|(id, name, role, goal)| Identity {
        id: id.into(),
        name: name.into(),
        role: role.into(),
        context: String::new(),
        goals: vec![goal.into()],
        tone: String::new(),
        guardrails: String::new(),
        initials: name.chars().next().unwrap_or('?').to_string(),
    })
    .collect()
}

#[tauri::command]
pub fn identities_list(state: State<'_, IdentityState>) -> Result<Vec<Identity>, String> {
    let _guard = state
        .lock
        .lock()
        .map_err(|_| "Identity settings are unavailable")?;
    state.read()
}

#[tauri::command]
pub fn identities_save(
    state: State<'_, IdentityState>,
    mut profile: Identity,
) -> Result<(), String> {
    if profile.id.is_empty()
        || profile.id.len() > 128
        || profile.name.trim().is_empty()
        || profile.name.chars().count() > 120
        || profile.role.chars().count() > 500
        || profile.context.chars().count() > 4000
        || profile.guardrails.chars().count() > 4000
        || profile.tone.chars().count() > 500
        || profile.goals.len() > 30
        || profile.goals.iter().any(|g| g.chars().count() > 500)
    {
        return Err("Identity fields are invalid or too long".into());
    }
    profile.name = profile.name.trim().into();
    profile.initials = profile.name.chars().next().unwrap_or('?').to_string();
    let _guard = state
        .lock
        .lock()
        .map_err(|_| "Identity settings are unavailable")?;
    let mut items = state.read()?;
    if let Some(index) = items.iter().position(|item| item.id == profile.id) {
        items[index] = profile;
    } else {
        items.push(profile);
    }
    state.write(&items)
}

#[tauri::command]
pub fn identities_remove(state: State<'_, IdentityState>, id: String) -> Result<(), String> {
    let _guard = state
        .lock
        .lock()
        .map_err(|_| "Identity settings are unavailable")?;
    let mut items = state.read()?;
    if !items.iter().any(|item| item.id == id) {
        return Err("Identity not found".into());
    }
    items.retain(|item| item.id != id);
    state.write(&items)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presets_can_be_changed_and_empty_list_stays_empty() {
        let temp = tempfile::tempdir().unwrap();
        let store = IdentityState::new(temp.path().into());
        let mut profiles = store.read().unwrap();
        assert_eq!(profiles.len(), 3);
        profiles.remove(0);
        profiles[0].role = "Updated role".into();
        store.write(&profiles).unwrap();
        assert_eq!(store.read().unwrap()[0].role, "Updated role");
        store.write(&[]).unwrap();
        assert!(store.read().unwrap().is_empty());
    }
}
