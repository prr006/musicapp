//! Settings persistence (JSON in the app config dir, atomic writes).
//! The IPC layer owns it; `resolve_track` reads the audio quality so changes
//! apply to the next resolved track without a restart.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use melo_core::persistence::{load_json, save_json_atomic, Settings};

pub struct SettingsStore {
    path: PathBuf,
    inner: Mutex<Settings>,
}

impl SettingsStore {
    pub fn load(config_dir: &Path) -> Self {
        let path = config_dir.join("settings.json");
        let settings = load_json(&path).ok().flatten().unwrap_or_default();
        Self { path, inner: Mutex::new(settings) }
    }

    pub fn get(&self) -> Settings {
        self.inner.lock().map(|s| s.clone()).unwrap_or_default()
    }

    pub fn set(&self, settings: Settings) -> Result<(), String> {
        save_json_atomic(&self.path, &settings)?;
        if let Ok(mut guard) = self.inner.lock() {
            *guard = settings;
        }
        Ok(())
    }
}
