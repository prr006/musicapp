//! Tauri commands (the full IPC surface — see docs/IPC.md).
//!
//! Rules:
//! * Commands are thin: validate, translate to typed domain calls, return.
//!   Playback intent becomes `UserCommand` for the service loop.
//! * The UI receives updates via events; `get_*` commands exist for boot.
//! * Anything touching a process or the network runs on a worker thread
//!   (`spawn_blocking`) so IPC never blocks.

use std::sync::Arc;

use melo_core::domain::Track;
use melo_core::library::{LibraryData, LibraryStore};
use melo_core::lyrics::Lyrics;
use melo_core::persistence::Settings;
use melo_core::playback::{PlaybackSnapshot, UserCommand};
use melo_core::providers::ProviderError;
use melo_core::queue::{QueueView, RepeatMode};
use tauri::{AppHandle, Emitter, State};

use crate::events;
use crate::lrclib::LrclibClient;
use crate::resolver::ResolverService;
use crate::settings_store::SettingsStore;
use crate::MeloState;

fn ok(state: &State<MeloState>, cmd: UserCommand) -> Result<(), String> {
    state.playback.send(cmd);
    Ok(())
}

fn require_title(title: &str) -> Result<String, String> {
    let t = title.trim();
    if t.is_empty() {
        return Err("title must not be empty".into());
    }
    if t.chars().count() > 200 {
        return Err("title is too long".into());
    }
    Ok(t.to_string())
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

#[tauri::command]
pub fn get_library(library: State<'_, Arc<LibraryStore>>) -> LibraryData {
    library.snapshot()
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
    if !volume.is_finite() || !(0.0..=100.0).contains(&volume) {
        return Err("volume must be between 0 and 100".into());
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
    if tracks.len() > 500 {
        return Err("too many tracks in one request".into());
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
    if item_id.is_empty() {
        return Err("item_id must not be empty".into());
    }
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
pub fn queue_start(
    tracks: Vec<Track>,
    shuffle: bool,
    state: State<'_, MeloState>,
) -> Result<(), String> {
    require_tracks(&tracks)?;
    ok(&state, UserCommand::StartSequence { tracks, shuffle })
}

/// Save the current queue (current + upcoming) as a new playlist.
#[tauri::command]
pub fn queue_save_as_playlist(
    title: String,
    state: State<'_, MeloState>,
    library: State<'_, Arc<LibraryStore>>,
    app: AppHandle,
) -> Result<melo_core::domain::Playlist, String> {
    let title = require_title(&title)?;
    let view = state.playback.queue_view();
    let mut tracks: Vec<Track> = Vec::with_capacity(view.upcoming.len() + 1);
    if let Some(current) = &view.current {
        tracks.push(current.track.clone());
    }
    for item in &view.upcoming {
        tracks.push(item.track.clone());
    }
    let playlist = library.with_mut(|l| {
        let pl = l.create_playlist(&title, None);
        if !tracks.is_empty() {
            l.playlist_add_tracks(&pl.id, &tracks);
        }
        pl
    });
    let _ = app.emit(events::LIBRARY_UPDATED, library.snapshot());
    Ok(playlist)
}

// ----------------------------------------------------------------------
// Search (yt-dlp) + search history
// ----------------------------------------------------------------------

#[tauri::command]
pub async fn search(
    query: String,
    limit: Option<u32>,
    resolver: State<'_, Arc<ResolverService>>,
    library: State<'_, Arc<LibraryStore>>,
    app: AppHandle,
) -> Result<melo_core::providers::SearchResults, ProviderError> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Err(ProviderError::InvalidInput);
    }
    if query.chars().count() > 200 {
        return Err(ProviderError::InvalidInput);
    }
    let limit = limit.unwrap_or(25).clamp(1, 40);
    let resolver = resolver.inner().clone();
    // The worker thread gets its own copy; `query` stays owned here for the
    // search-history push and the echoed result below.
    let search_query = query.clone();
    let found = tauri::async_runtime::spawn_blocking(move || resolver.search(&search_query, limit))
        .await
        .map_err(|e| ProviderError::Detail(format!("search task failed: {e}")))??;

    library.with_mut(|l| l.push_search(&query));
    let _ = app.emit(events::LIBRARY_UPDATED, library.snapshot());

    // Group: flat search has no album data, so results are songs only —
    // the UI degrades honestly rather than showing fake albums.
    Ok(melo_core::providers::SearchResults {
        tracks: found,
        artists: Vec::new(),
        albums: Vec::new(),
        playlists: Vec::new(),
        query,
    })
}

#[tauri::command]
pub fn search_history_clear(library: State<'_, Arc<LibraryStore>>, app: AppHandle) -> Result<(), String> {
    library.with_mut(|l| l.clear_search_history());
    let _ = app.emit(events::LIBRARY_UPDATED, library.snapshot());
    Ok(())
}

#[tauri::command]
pub fn search_history_remove(
    query: String,
    library: State<'_, Arc<LibraryStore>>,
    app: AppHandle,
) -> Result<(), String> {
    library.with_mut(|l| l.remove_search(&query));
    let _ = app.emit(events::LIBRARY_UPDATED, library.snapshot());
    Ok(())
}

// ----------------------------------------------------------------------
// Favorites
// ----------------------------------------------------------------------

#[tauri::command]
pub fn favorites_toggle(
    track: Track,
    library: State<'_, Arc<LibraryStore>>,
    app: AppHandle,
) -> Result<bool, String> {
    require_tracks(std::slice::from_ref(&track))?;
    let liked = library.with_mut(|l| l.toggle_like(&track));
    let _ = app.emit(events::LIBRARY_UPDATED, library.snapshot());
    Ok(liked)
}

// ----------------------------------------------------------------------
// Playlists
// ----------------------------------------------------------------------

#[tauri::command]
pub fn playlist_create(
    title: String,
    description: Option<String>,
    library: State<'_, Arc<LibraryStore>>,
    app: AppHandle,
) -> Result<melo_core::domain::Playlist, String> {
    let title = require_title(&title)?;
    let playlist = library.with_mut(|l| l.create_playlist(&title, description));
    let _ = app.emit(events::LIBRARY_UPDATED, library.snapshot());
    Ok(playlist)
}

#[tauri::command]
pub fn playlist_rename(
    playlist_id: String,
    title: String,
    library: State<'_, Arc<LibraryStore>>,
    app: AppHandle,
) -> Result<(), String> {
    let title = require_title(&title)?;
    let found = library.with_mut(|l| l.rename_playlist(&playlist_id, &title));
    if !found {
        return Err("playlist not found".into());
    }
    let _ = app.emit(events::LIBRARY_UPDATED, library.snapshot());
    Ok(())
}

#[tauri::command]
pub fn playlist_set_description(
    playlist_id: String,
    description: Option<String>,
    library: State<'_, Arc<LibraryStore>>,
    app: AppHandle,
) -> Result<(), String> {
    let found = library.with_mut(|l| l.set_playlist_description(&playlist_id, description));
    if !found {
        return Err("playlist not found".into());
    }
    let _ = app.emit(events::LIBRARY_UPDATED, library.snapshot());
    Ok(())
}

#[tauri::command]
pub fn playlist_delete(
    playlist_id: String,
    library: State<'_, Arc<LibraryStore>>,
    app: AppHandle,
) -> Result<(), String> {
    let found = library.with_mut(|l| l.delete_playlist(&playlist_id));
    if !found {
        return Err("playlist not found".into());
    }
    let _ = app.emit(events::LIBRARY_UPDATED, library.snapshot());
    Ok(())
}

#[tauri::command]
pub fn playlist_duplicate(
    playlist_id: String,
    title: String,
    library: State<'_, Arc<LibraryStore>>,
    app: AppHandle,
) -> Result<melo_core::domain::Playlist, String> {
    let title = require_title(&title)?;
    let copy = library.with_mut(|l| l.duplicate_playlist(&playlist_id, &title));
    match copy {
        Some(pl) => {
            let _ = app.emit(events::LIBRARY_UPDATED, library.snapshot());
            Ok(pl)
        }
        None => Err("playlist not found".into()),
    }
}

#[tauri::command]
pub fn playlist_add_tracks(
    playlist_id: String,
    tracks: Vec<Track>,
    library: State<'_, Arc<LibraryStore>>,
    app: AppHandle,
) -> Result<(), String> {
    require_tracks(&tracks)?;
    let found = library.with_mut(|l| l.playlist_add_tracks(&playlist_id, &tracks));
    if !found {
        return Err("playlist not found".into());
    }
    let _ = app.emit(events::LIBRARY_UPDATED, library.snapshot());
    Ok(())
}

#[tauri::command]
pub fn playlist_remove_track(
    playlist_id: String,
    track_id: String,
    library: State<'_, Arc<LibraryStore>>,
    app: AppHandle,
) -> Result<(), String> {
    if track_id.is_empty() {
        return Err("track_id must not be empty".into());
    }
    let removed = library.with_mut(|l| l.playlist_remove_track(&playlist_id, &track_id));
    if !removed {
        return Err("track not in playlist".into());
    }
    let _ = app.emit(events::LIBRARY_UPDATED, library.snapshot());
    Ok(())
}

#[tauri::command]
pub fn playlist_reorder_track(
    playlist_id: String,
    from: usize,
    to: usize,
    library: State<'_, Arc<LibraryStore>>,
    app: AppHandle,
) -> Result<(), String> {
    let moved = library.with_mut(|l| l.playlist_reorder(&playlist_id, from, to));
    if !moved {
        return Err("invalid reorder".into());
    }
    let _ = app.emit(events::LIBRARY_UPDATED, library.snapshot());
    Ok(())
}

/// Rehydrate playlist rows into full tracks for playback/UI.
#[tauri::command]
pub fn playlist_tracks(
    playlist_id: String,
    library: State<'_, Arc<LibraryStore>>,
) -> Result<Vec<Track>, String> {
    let snap = library.snapshot();
    if snap.playlist(&playlist_id).is_none() {
        return Err("playlist not found".into());
    }
    Ok(snap
        .playlist_track_ids(&playlist_id)
        .into_iter()
        .filter_map(|id| snap.track_by_id(&id))
        .collect())
}

// ----------------------------------------------------------------------
// History
// ----------------------------------------------------------------------

#[tauri::command]
pub fn history_clear(library: State<'_, Arc<LibraryStore>>, app: AppHandle) -> Result<(), String> {
    library.with_mut(|l| l.clear_history());
    let _ = app.emit(events::LIBRARY_UPDATED, library.snapshot());
    Ok(())
}

#[tauri::command]
pub fn history_remove(
    entry_id: String,
    library: State<'_, Arc<LibraryStore>>,
    app: AppHandle,
) -> Result<(), String> {
    if entry_id.is_empty() {
        return Err("entry_id must not be empty".into());
    }
    library.with_mut(|l| l.remove_history_entry(&entry_id));
    let _ = app.emit(events::LIBRARY_UPDATED, library.snapshot());
    Ok(())
}

// ----------------------------------------------------------------------
// Lyrics (LRCLIB)
// ----------------------------------------------------------------------

#[tauri::command]
pub async fn get_lyrics(
    track: Track,
    client: State<'_, Arc<LrclibClient>>,
) -> Result<Option<Lyrics>, ProviderError> {
    let client = client.inner().clone();
    tauri::async_runtime::spawn_blocking(move || client.lyrics_for(&track))
        .await
        .map_err(|e| ProviderError::Detail(format!("lyrics task failed: {e}")))?
}

// ----------------------------------------------------------------------
// Settings
// ----------------------------------------------------------------------

#[tauri::command]
pub fn get_settings(settings: State<'_, Arc<SettingsStore>>) -> Settings {
    settings.get()
}

#[tauri::command]
pub fn set_settings(
    settings: Settings,
    settings_store: State<'_, Arc<SettingsStore>>,
    state: State<'_, MeloState>,
) -> Result<(), String> {
    let previous = settings_store.get();
    settings_store.set(settings)?;
    if previous.history_enabled != settings_store.get().history_enabled {
        state.playback.set_history_enabled(settings_store.get().history_enabled);
    }
    Ok(())
}

/// Engine/provider diagnostics for the settings page.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostics {
    pub runtime_dir: Option<String>,
    pub mpv_path: Option<String>,
    pub mpv_found: bool,
    pub ytdlp_found: bool,
    pub ytdlp_path: Option<String>,
    pub quality_label: &'static str,
}

#[tauri::command]
pub fn get_diagnostics(
    state: State<'_, MeloState>,
    resolver: State<'_, Arc<ResolverService>>,
) -> Diagnostics {
    let rt = state.runtime.with_clone();
    Diagnostics {
        runtime_dir: rt.install_bin.to_str().map(|s| s.to_owned()),
        mpv_path: rt.mpv.to_str().map(|s| s.to_owned()),
        mpv_found: rt.mpv_found,
        ytdlp_found: resolver.ytdlp_found(),
        ytdlp_path: resolver.ytdlp_path(),
        quality_label: resolver.quality_label(),
    }
}

/// Re-download mpv + yt-dlp into the managed runtime dir. Runs in the
/// background (same code path as first-run bootstrap); progress arrives via
/// `ENGINE_STATUS` events and completion re-attempts the engine start.
#[tauri::command]
pub fn repair_runtime(app: tauri::AppHandle, state: State<'_, MeloState>) {
    let runtime = state.runtime.clone();
    let playback = state.playback.clone();
    // Remove managed binaries (cheap) then re-download in the background;
    // progress arrives via engine-status events and the engine restarts on
    // completion through the on_ready callback below.
    crate::runtime::reset_for_repair(&runtime);
    crate::runtime::bootstrap_and_report(app, runtime, move || {
        playback.start_engine();
    });
}
