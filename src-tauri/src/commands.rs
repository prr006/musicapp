//! Tauri commands — the complete IPC surface (see docs/IPC.md).
//!
//! Playback commands are one-line wrappers over `crate::libmpv::Player`
//! (libmpv is authoritative; MELO keeps no parallel playback state machine).
//! The queue lives in the frontend; this layer never touches it.
//! Anything touching a process or the network runs on a worker thread
//! (`spawn_blocking`) so IPC never blocks.

use std::sync::Arc;

use melo_core::domain::Track;
use melo_core::library::{LibraryData, LibraryStore};
use melo_core::lyrics::Lyrics;
use melo_core::persistence::Settings;
use melo_core::providers::ProviderError;
use tauri::{AppHandle, Emitter, State};

use crate::events;
use crate::libmpv::{self, Player};
use crate::lrclib::LrclibClient;
use crate::runtime::RuntimeHandle;
use crate::settings_store::SettingsStore;
use crate::MeloState;

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

// ----------------------------------------------------------------------
// Player (libmpv) — load/transport/audio. Errors are actionable strings.
// ----------------------------------------------------------------------

fn player(state: &State<MeloState>) -> Result<Arc<Player>, String> {
    state
        .player
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
        .ok_or_else(|| {
            "Playback engine is not running (libmpv not installed or failed to start). \
             Use Settings → Diagnostics → Repair runtime."
                .into()
        })
}

#[tauri::command]
pub fn player_get_state(state: State<'_, MeloState>) -> libmpv::EngineState {
    match player(&state) {
        Ok(p) => p.state(),
        Err(_) => libmpv::EngineState {
            status: "dead",
            ..libmpv::EngineState::default()
        },
    }
}

/// Load a media URL, replacing whatever plays. Returns the load epoch so the
/// app can drop stale end-of-file notifications after rapid switching.
#[tauri::command]
pub fn player_load(
    url: String,
    start_paused: Option<bool>,
    start_at: Option<f64>,
    state: State<'_, MeloState>,
) -> Result<u64, String> {
    if url.trim().is_empty() {
        return Err("media URL must not be empty".into());
    }
    player(&state)?.load(&url, start_paused.unwrap_or(false), start_at)
}

#[tauri::command]
pub fn player_play(state: State<'_, MeloState>) -> Result<(), String> {
    player(&state)?.play()
}

#[tauri::command]
pub fn player_pause(state: State<'_, MeloState>) -> Result<(), String> {
    player(&state)?.pause()
}

#[tauri::command]
pub fn player_toggle_play(state: State<'_, MeloState>) -> Result<(), String> {
    player(&state)?.toggle_pause()
}

/// Manual stop. mpv reports reason "stop" — the queue must NOT auto-advance.
#[tauri::command]
pub fn player_stop(state: State<'_, MeloState>) -> Result<(), String> {
    player(&state)?.stop()
}

#[tauri::command]
pub fn player_seek(position: f64, state: State<'_, MeloState>) -> Result<(), String> {
    if !position.is_finite() || position < 0.0 {
        return Err("position must be a non-negative number".into());
    }
    player(&state)?.seek_to(position)
}

#[tauri::command]
pub fn player_set_volume(volume: f64, state: State<'_, MeloState>) -> Result<(), String> {
    if !(0.0..=100.0).contains(&volume) {
        return Err("volume must be between 0 and 100".into());
    }
    player(&state)?.set_volume(volume)
}

#[tauri::command]
pub fn player_set_mute(muted: bool, state: State<'_, MeloState>) -> Result<(), String> {
    player(&state)?.set_mute(muted)
}

#[tauri::command]
pub fn player_set_speed(speed: f64, state: State<'_, MeloState>) -> Result<(), String> {
    if !(0.25..=4.0).contains(&speed) {
        return Err("speed must be between 0.25 and 4".into());
    }
    player(&state)?.set_speed(speed)
}

/// Volume normalization toggle (libmpv `af=loudnorm`).
#[tauri::command]
pub fn player_set_normalization(enabled: bool, state: State<'_, MeloState>) -> Result<(), String> {
    player(&state)?.set_normalization(enabled)
}

// ----------------------------------------------------------------------
// Resolve (yt-dlp) — independent of the player
// ----------------------------------------------------------------------

#[tauri::command]
pub async fn resolve_track(
    source_id: String,
    quality: Option<melo_core::persistence::AudioQuality>,
    runtime: State<'_, RuntimeHandle>,
) -> Result<melo_core::providers::ResolvedMedia, ProviderError> {
    let id = source_id.trim().to_string();
    if id.is_empty() {
        return Err(ProviderError::InvalidInput);
    }
    let binary = runtime.ytdlp_path().ok_or_else(|| {
        ProviderError::Detail(
            "yt-dlp runtime missing — Settings → Diagnostics → Repair runtime".into(),
        )
    })?;
    let quality = quality.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || crate::ytdlp::resolve(&binary, &id, quality))
        .await
        .map_err(|e| ProviderError::Detail(format!("resolve task failed: {e}")))?
}

// ----------------------------------------------------------------------
// Session persistence (queue/position live in the frontend)
// ----------------------------------------------------------------------

#[tauri::command]
pub fn get_session(state: State<'_, MeloState>) -> Option<serde_json::Value> {
    let path = state.config_dir.join("session.json");
    melo_core::persistence::load_json(&path)
        .ok()
        .flatten()
}

#[tauri::command]
pub fn set_session(session: serde_json::Value, state: State<'_, MeloState>) -> Result<(), String> {
    let path = state.config_dir.join("session.json");
    melo_core::persistence::save_json_atomic(&path, &session)
        .map_err(|e| format!("save session: {e}"))
}

/// Record that a track actually started playing (listening history). Called
/// by the frontend controller right after a successful load.
#[tauri::command]
pub fn record_play(
    track: Track,
    library: State<'_, Arc<LibraryStore>>,
    app: AppHandle,
) -> Result<(), String> {
    require_tracks(std::slice::from_ref(&track))?;
    library.with_mut(|l| l.record_play(&track, melo_core::ids::now_ms()));
    let _ = app.emit(events::LIBRARY_UPDATED, library.snapshot());
    Ok(())
}

/// Update the reached position/completion of the most recent history entry
/// for a track (drives "Recently played" progress). Called on track switch,
/// stop and session flush by the frontend controller.
#[tauri::command]
pub fn record_play_progress(
    track_id: String,
    played_secs: f64,
    completion: f64,
    library: State<'_, Arc<LibraryStore>>,
    app: AppHandle,
) -> Result<(), String> {
    let track_id = track_id.trim().to_string();
    if track_id.is_empty() {
        return Err("track_id must not be empty".into());
    }
    if !played_secs.is_finite() || played_secs < 0.0 {
        return Err("played_secs must be a non-negative number".into());
    }
    if !completion.is_finite() || !(0.0..=1.0).contains(&completion) {
        return Err("completion must be between 0 and 1".into());
    }
    library.with_mut(|l| l.finish_recent_for(&track_id, played_secs, completion));
    let _ = app.emit(events::LIBRARY_UPDATED, library.snapshot());
    Ok(())
}

/// Full library snapshot for the initial UI load (updates afterwards arrive
/// as `library://updated` events).
#[tauri::command]
pub fn get_library(library: State<'_, Arc<LibraryStore>>) -> LibraryData {
    library.snapshot()
}

// ----------------------------------------------------------------------
// Search (yt-dlp) + search history
// ----------------------------------------------------------------------

#[tauri::command]
pub async fn search(
    query: String,
    limit: Option<u32>,
    runtime: State<'_, RuntimeHandle>,
    library: State<'_, Arc<LibraryStore>>,
    app: AppHandle,
) -> Result<melo_core::providers::SearchResults, ProviderError> {
    let query = query.trim().to_string();
    if query.is_empty() || query.chars().count() > 200 {
        return Err(ProviderError::InvalidInput);
    }
    let limit = limit.unwrap_or(25).clamp(1, 40);
    let binary = runtime.ytdlp_path().ok_or_else(|| {
        ProviderError::Detail(
            "yt-dlp runtime missing — Settings → Diagnostics → Repair runtime".into(),
        )
    })?;
    let search_query = query.clone();
    let found = tauri::async_runtime::spawn_blocking(move || {
        crate::ytdlp::search(&binary, &search_query, limit)
    })
    .await
    .map_err(|e| ProviderError::Detail(format!("search task failed: {e}")))??;

    library.with_mut(|l| l.push_search(&query));
    let _ = app.emit(events::LIBRARY_UPDATED, library.snapshot());

    // Flat search returns songs only — the UI degrades honestly rather than
    // inventing albums/artists the data does not contain.
    Ok(melo_core::providers::SearchResults {
        tracks: found,
        artists: Vec::new(),
        albums: Vec::new(),
        playlists: Vec::new(),
        query,
    })
}

#[tauri::command]
pub fn search_history_clear(
    library: State<'_, Arc<LibraryStore>>,
    app: AppHandle,
) -> Result<(), String> {
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
// Lyrics (LRCLIB) — matched in the UI against the real player position
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
    store: State<'_, Arc<SettingsStore>>,
) -> Result<(), String> {
    store.set(settings).map_err(|e| format!("save settings: {e}"))
}

// ----------------------------------------------------------------------
// Diagnostics + runtime repair
// ----------------------------------------------------------------------

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostics {
    pub runtime_dir: Option<String>,
    pub libmpv_path: Option<String>,
    pub libmpv_found: bool,
    pub engine_running: bool,
    pub mpv_version: Option<String>,
    pub ytdlp_found: bool,
    pub ytdlp_path: Option<String>,
    pub quality_label: String,
}

#[tauri::command]
pub fn get_diagnostics(
    state: State<'_, MeloState>,
    settings: State<'_, Arc<SettingsStore>>,
) -> Diagnostics {
    let engine = state
        .player
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone();
    let (engine_running, mpv_version) = match &engine {
        Some(p) => (p.is_alive(), p.state().mpv_version),
        None => (false, None),
    };
    Diagnostics {
        runtime_dir: state.runtime.install_bin().to_str().map(|s| s.to_owned()),
        libmpv_path: state.runtime.libmpv_path().to_str().map(|s| s.to_owned()),
        libmpv_found: state.runtime.libmpv_found(),
        engine_running,
        mpv_version,
        ytdlp_found: state.runtime.ytdlp_found(),
        ytdlp_path: state
            .runtime
            .ytdlp_path()
            .and_then(|p| p.to_str().map(|s| s.to_owned())),
        quality_label: melo_core::ytdlp::quality_label(settings.get().audio_quality).into(),
    }
}

/// Remove the managed binaries and re-download them (pinned + verified).
/// Progress arrives via `runtime://status`; MELO restarts the engine when
/// the install finishes.
#[tauri::command]
pub fn repair_runtime(app: AppHandle, state: State<'_, MeloState>) -> Result<(), String> {
    let runtime = state.runtime.clone();
    crate::runtime::reset_for_repair(&runtime);
    let config_dir = state.config_dir.clone();
    let mut guard = state
        .player
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    *guard = None; // stop the old engine before replacing its DLL
    drop(guard);
    let app_for_ready = app.clone();
    crate::runtime::ensure_and_report(app, runtime, move || {
        crate::start_engine(&app_for_ready, &config_dir);
    });
    Ok(())
}
