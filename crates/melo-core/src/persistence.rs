//! Persistence (spec §31).
//!
//! Phase 1 persists two JSON documents in the app config dir:
//!
//! * `settings.json` — user preferences (theme, quality, behavior, ...)
//! * `session.json`  — queue + audio state for crash-safe restore
//!
//! The documents are small and written atomically (tmp + rename). Structured
//! collections that grow unboundedly (library, playlists, history, downloads)
//! get a SQLite repository in later phases — the `library` module defines the
//! trait boundary so the store can swap without touching callers.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::queue::QueueMachine;

/// Audio quality preference (spec §12). Honest labels — we never claim
/// lossless unless a source provides it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AudioQuality {
    Low,
    #[default]
    Standard,
    High,
    Highest,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Theme {
    #[default]
    Dark,
    Light,
    System,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CloseAction {
    #[default]
    Quit,
    MinimizeToTray,
}

/// Everything user-configurable. Unknown fields are preserved via serde
/// defaults so older builds can read newer files.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default)]
    pub theme: Theme,
    /// CSS accent identifier (`violet`, `ocean`, `sunset`, ...).
    #[serde(default = "default_accent")]
    pub accent: String,
    #[serde(default = "default_true")]
    pub animations: bool,
    #[serde(default)]
    pub compact: bool,
    #[serde(default)]
    pub show_lyrics_translation: bool,

    // --- playback ---
    #[serde(default)]
    pub audio_quality: AudioQuality,
    #[serde(default)]
    pub volume_normalization: bool,
    /// 0 = off (spec §25: disabled until reliably implemented).
    #[serde(default)]
    pub crossfade_secs: u32,
    #[serde(default = "default_true")]
    pub gapless: bool,
    #[serde(default = "default_true")]
    pub autoplay_similar: bool,
    /// Restore last session's queue/position on launch (never autoplay).
    #[serde(default)]
    pub resume_last_session: bool,

    // --- behavior ---
    #[serde(default)]
    pub close_action: CloseAction,
    #[serde(default)]
    pub notifications_track_change: bool,
    #[serde(default = "default_true")]
    pub history_enabled: bool,

    // --- storage ---
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub download_dir: Option<PathBuf>,
}

fn default_accent() -> String {
    "violet".into()
}

fn default_true() -> bool {
    true
}

impl Default for Settings {
    fn default() -> Self {
        serde_json::from_str("{}").unwrap()
    }
}

/// Everything needed to bring a session back after restart.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshot {
    pub queue: QueueMachine,
    pub volume: f64,
    pub muted: bool,
    pub speed: f64,
    /// Position of the current track when the session ended.
    pub position_secs: f64,
    pub saved_at_ms: u64,
}

impl SessionSnapshot {
    pub fn capture(queue: &QueueMachine, volume: f64, muted: bool, speed: f64, position_secs: f64) -> Self {
        Self {
            queue: queue.clone(),
            volume,
            muted,
            speed,
            position_secs,
            saved_at_ms: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
        }
    }
}

/// Load a JSON document; missing file → `None`, corrupt file → `Err`.
pub fn load_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<Option<T>, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => {
            serde_json::from_str(&text)
                .map(Some)
                .map_err(|e| format!("corrupt {}: {e}", path.display()))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("cannot read {}: {e}", path.display())),
    }
}

/// Atomically write a JSON document (tmp + rename).
pub fn save_json_atomic<T: serde::Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let dir = path
        .parent()
        .ok_or_else(|| "invalid path".to_string())?;
    std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let tmp: PathBuf = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, text).map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("cannot replace {}: {e}", path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{ArtistRef, Track};
    use crate::domain::TrackSource;

    fn track(n: u32) -> Track {
        Track {
            id: format!("t:{n}"),
            source: TrackSource::YouTube,
            source_id: format!("v{n}"),
            title: format!("Track {n}"),
            artists: vec![ArtistRef { id: "a:1".into(), name: "Artist".into() }],
            album: None,
            duration_secs: Some(180.0),
            artwork: None,
            is_local: false,
            metadata: Default::default(),
        }
    }

    #[test]
    fn settings_defaults_are_conservative() {
        let s = Settings::default();
        assert_eq!(s.audio_quality, AudioQuality::Standard);
        assert_eq!(s.crossfade_secs, 0);
        assert!(!s.resume_last_session);
        assert_eq!(s.close_action, CloseAction::Quit);
    }

    #[test]
    fn settings_survive_unknown_future_fields() {
        let json = r#"{"theme":"light","audioQuality":"highest","futureField":123}"#;
        let s: Settings = serde_json::from_str(json).unwrap();
        assert_eq!(s.audio_quality, AudioQuality::Highest);
    }

    #[test]
    fn settings_roundtrip() {
        let mut s = Settings::default();
        s.theme = Theme::Light;
        s.audio_quality = AudioQuality::High;
        s.resume_last_session = true;
        let json = serde_json::to_string(&s).unwrap();
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(s, back);
    }

    #[test]
    fn session_roundtrip_preserves_queue_state() {
        let mut q = QueueMachine::with_seed(7);
        q.add_tracks((1..=3).map(track).collect(), crate::queue::AddPosition::End);
        q.advance(true);
        q.advance(true);
        let snap = SessionSnapshot::capture(&q, 64.0, false, 1.25, 42.5);
        let json = serde_json::to_string(&snap).unwrap();
        let back: SessionSnapshot = serde_json::from_str(&json).unwrap();
        assert_eq!(back.queue.order_ids(), q.order_ids());
        assert_eq!(back.queue.cursor_index(), q.cursor_index());
        assert_eq!(back.volume, 64.0);
        assert_eq!(back.position_secs, 42.5);
        assert_eq!(back.speed, 1.25);
        back.queue.assert_invariants().unwrap();
    }

    #[test]
    fn json_io_is_atomic_and_tolerates_missing_files() {
        let dir = std::env::temp_dir().join(format!("melo-test-{}", std::process::id()));
        let path = dir.join("settings.json");
        let _ = std::fs::remove_file(&path);
        // Missing → None.
        assert!(load_json::<Settings>(&path).unwrap().is_none());
        // Save + load.
        save_json_atomic(&path, &Settings::default()).unwrap();
        assert!(load_json::<Settings>(&path).unwrap().is_some());
        // No leftover tmp file.
        assert!(!dir.join("settings.json.tmp").exists());
        let _ = std::fs::remove_file(&path);
    }
}
