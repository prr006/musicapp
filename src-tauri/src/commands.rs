//! Tauri commands (the full IPC surface — see docs/IPC.md).
//!
//! Rules:
//! * Commands are thin: validate, translate to `UserCommand`, send to the
//!   playback service, return. No state is computed here.
//! * The UI receives updates via events; `get_*` commands exist for boot.
//! * Unimplemented phases return honest errors instead of pretending.

use melo_core::domain::Track;
use melo_core::lyrics::Lyrics;
use melo_core::persistence::Settings;
use melo_core::playback::{PlaybackSnapshot, UserCommand};
use melo_core::providers::{ProviderError, SearchResults};
use melo_core::queue::{QueueView, RepeatMode};
use tauri::State;

use crate::{settings_store::SettingsStore, MeloState};

fn ok(state: &State<MeloState>, cmd: UserCommand) -> Result<(), String> {
    state.playback.send(cmd);
    Ok(())
}

// ----------------------------------------------------------------------
// State reads (boot / re-sync)
// ----------------------------------------------------------------------

#[tauri::command]
pub fn get_playback_state(state: State<'_, MeloState>) -> PlaybackSnapshot {
    (*state.playback.snapshot()).clone()
}

#[tauri::command]
pub fn get_queue(state: State<'_, MeloState>) -> QueueView {
    (*state.playback.queue_view()).clone()
}

// ----------------------------------------------------------------------
// Transport
// ----------------------------------------------------------------------

#[tauri::command]
pub fn player_toggle_play(state: State<'_, MeloState>) -> Result<(), String> {
    ok(&state, UserCommand::TogglePlay)
}

#[tauri::command]
pub fn player_play(state: State<'_, MeloState>) -> Result<(), String> {
    ok(&state, UserCommand::Play)
}

#[tauri::command]
pub fn player_pause(state: State<'_, MeloState>) -> Result<(), String> {
    ok(&state, UserCommand::Pause)
}

#[tauri::command]
pub fn player_stop(state: State<'_, MeloState>) -> Result<(), String> {
    ok(&state, UserCommand::Stop)
}

#[tauri::command]
pub fn player_next(state: State<'_, MeloState>) -> Result<(), String> {
    ok(&state, UserCommand::Next)
}

#[tauri::command]
pub fn player_previous(state: State<'_, MeloState>) -> Result<(), String> {
    ok(&state, UserCommand::Previous)
}

#[tauri::command]
pub fn player_seek_to(position: f64, state: State<'_, MeloState>) -> Result<(), String> {
    if !position.is_finite() || position < 0.0 {
        return Err("position must be a positive number".into());
    }
    ok(&state, UserCommand::SeekTo { position })
}

#[tauri::command]
pub fn player_seek_by(delta: f64, state: State<'_, MeloState>) -> Result<(), String> {
    if !delta.is_finite() {
        return Err("delta must be a finite number".into());
    }
    ok(&state, UserCommand::SeekBy { delta })
}

#[tauri::command]
pub fn player_set_volume(volume: f64, state: State<'_, MeloState>) -> Result<(), String> {
    if !volume.is_finite() {
        return Err("volume must be a number".into());
    }
    ok(&state, UserCommand::SetVolume { volume })
}

#[tauri::command]
pub fn player_toggle_mute(state: State<'_, MeloState>) -> Result<(), String> {
    ok(&state, UserCommand::ToggleMute)
}

#[tauri::command]
pub fn player_set_speed(speed: f64, state: State<'_, MeloState>) -> Result<(), String> {
    if !speed.is_finite() || !(0.25..=4.0).contains(&speed) {
        return Err("speed must be between 0.25 and 4.0".into());
    }
    ok(&state, UserCommand::SetSpeed { speed })
}

// ----------------------------------------------------------------------
// Queue
// ----------------------------------------------------------------------

fn require_tracks(tracks: &[Track]) -> Result<(), String> {
    if tracks.is_empty() {
        return Err("tracks must not be empty".into());
    }
    for t in tracks {
        if t.source_id.trim().is_empty() {
            return Err(format!("track '{}' has no source id", t.title));
        }
    }
    Ok(())
}

#[tauri::command]
pub fn queue_play_now(track: Track, state: State<'_, MeloState>) -> Result<(), String> {
    require_tracks(std::slice::from_ref(&track))?;
    ok(&state, UserCommand::PlayTrack { track })
}

#[tauri::command]
pub fn queue_add(tracks: Vec<Track>, state: State<'_, MeloState>) -> Result<(), String> {
    require_tracks(&tracks)?;
    ok(&state, UserCommand::AddToQueue { tracks })
}

#[tauri::command]
pub fn queue_play_next(tracks: Vec<Track>, state: State<'_, MeloState>) -> Result<(), String> {
    require_tracks(&tracks)?;
    ok(&state, UserCommand::PlayNext { tracks })
}

#[tauri::command]
pub fn queue_remove(item_id: String, state: State<'_, MeloState>) -> Result<(), String> {
    if item_id.is_empty() {
        return Err("item_id must not be empty".into());
    }
    ok(&state, UserCommand::RemoveQueueItem { item_id })
}

#[tauri::command]
pub fn queue_jump_to(item_id: String, state: State<'_, MeloState>) -> Result<(), String> {
    if item_id.is_empty() {
        return Err("item_id must not be empty".into());
    }
    ok(&state, UserCommand::JumpToQueueItem { item_id })
}

#[tauri::command]
pub fn queue_move(item_id: String, up: bool, state: State<'_, MeloState>) -> Result<(), String> {
    ok(&state, UserCommand::MoveQueueItem { item_id, up })
}

#[tauri::command]
pub fn queue_reorder(from: usize, to: usize, state: State<'_, MeloState>) -> Result<(), String> {
    ok(&state, UserCommand::ReorderQueue { from, to })
}

#[tauri::command]
pub fn queue_clear_upcoming(state: State<'_, MeloState>) -> Result<(), String> {
    ok(&state, UserCommand::ClearUpcoming)
}

#[tauri::command]
pub fn queue_clear_all(state: State<'_, MeloState>) -> Result<(), String> {
    ok(&state, UserCommand::ClearQueue)
}

#[tauri::command]
pub fn queue_set_shuffle(enabled: bool, state: State<'_, MeloState>) -> Result<(), String> {
    ok(&state, UserCommand::SetShuffle { enabled })
}

#[tauri::command]
pub fn queue_set_repeat(mode: RepeatMode, state: State<'_, MeloState>) -> Result<(), String> {
    ok(&state, UserCommand::SetRepeat { mode })
}

#[tauri::command]
pub fn queue_start(tracks: Vec<Track>, shuffle: bool, state: State<'_, MeloState>) -> Result<(), String> {
    require_tracks(&tracks)?;
    ok(&state, UserCommand::StartSequence { tracks, shuffle })
}

// ----------------------------------------------------------------------
// Settings
// ----------------------------------------------------------------------

#[tauri::command]
pub fn get_settings(settings: State<'_, SettingsStore>) -> Settings {
    settings.get()
}

#[tauri::command]
pub fn set_settings(settings: State<'_, SettingsStore>, new: Settings) -> Result<(), String> {
    settings.set(new)
}

// ----------------------------------------------------------------------
// Later phases (honest stubs)
// ----------------------------------------------------------------------

#[tauri::command]
pub async fn search(query: String, limit: Option<u32>) -> Result<SearchResults, ProviderError> {
    let _ = (query, limit);
    Err(ProviderError::Detail(
        "search ships in Phase 5 (yt-dlp integration)".into(),
    ))
}

#[tauri::command]
pub async fn get_lyrics(track_id: String) -> Result<Option<Lyrics>, String> {
    let _ = track_id;
    // Phase 7: LRCLIB client (model + parsing already exist in melo-core).
    Ok(None)
}
