//! MELO application shell (Tauri 2).
//!
//! Layering (see docs/ARCHITECTURE.md):
//!
//! ```text
//! React (src/)  ──invoke──►  commands.rs  ──UserCommand──►  playback_service
//!                                                │ PlaybackCore (owns truth)
//!                                                ▼
//! React (src/)  ◄──event──  events.rs    ◄──EngineEvent──  mpv (child process)
//! ```
//!
//! Rust owns ALL playback state. The webview renders backend state and sends
//! intent — nothing else.

mod commands;
mod events;
mod lrclib;
mod mpv;
mod playback_service;
mod resolver;
mod runtime;
mod settings_store;
mod ytdlp_proc;

use std::sync::Arc;
use std::time::Duration;

use tauri::Manager;

use lrclib::LrclibClient;
use melo_core::library::LibraryStore;
use melo_core::persistence::Settings;
use playback_service::PlaybackHandle;
use resolver::ResolverService;
use runtime::RuntimeHandle;
use settings_store::SettingsStore;

pub struct MeloState {
    pub playback: PlaybackHandle,
    pub runtime: RuntimeHandle,
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let config_dir = app
                .path()
                .app_config_dir()
                .map_err(|e| Box::<dyn std::error::Error>::from(e.to_string()))?;
            std::fs::create_dir_all(&config_dir)
                .map_err(|e| Box::<dyn std::error::Error>::from(e.to_string()))?;

            let settings = Arc::new(SettingsStore::load(&config_dir));
            let library = Arc::new(LibraryStore::open(&config_dir.join("library.json")));
            let current: Settings = settings.get();

            // Managed runtime (standalone app — no PATH dependency).
            // Deterministic lookup (env override → dev checkout → bundled →
            // config-managed) with a first-run download when missing.
            let runtime = RuntimeHandle::resolve(&config_dir);

            let resolver = Arc::new(ResolverService::new(settings.clone(), runtime.clone()));
            let lyrics_cache = config_dir.join("lyrics-cache");
            let lrclib = Arc::new(LrclibClient::new(Some(lyrics_cache)));

            let playback = playback_service::spawn(
                app.handle().clone(),
                config_dir,
                runtime.clone(),
                current.resume_last_session,
                resolver.clone(),
                library.clone(),
            );
            let playback_for_bootstrap = playback.clone();

            app.manage(MeloState {
                playback,
                runtime: runtime.clone(),
            });
            app.manage(settings);
            app.manage(library);
            app.manage(resolver);
            app.manage(lrclib);

            // First-run bootstrap: download missing runtime pieces in the
            // background, then bring the engine up. Playback commands sent
            // in the meantime fail with a clear repair message instead of
            // silently hunting the PATH.
            if !runtime.mpv_found() || !runtime.ytdlp_found() {
                let app_handle = app.handle().clone();
                runtime::bootstrap_and_report(app_handle, runtime.clone(), move || {
                    playback_for_bootstrap.start_engine();
                });
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                // Give the playback service a beat to flush the session and
                // kill mpv so the next launch restores cleanly (spec §31).
                if let Some(state) = window.try_state::<MeloState>() {
                    state.playback.flush();
                    std::thread::sleep(Duration::from_millis(150));
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_playback_state,
            commands::get_queue,
            commands::get_library,
            commands::player_toggle_play,
            commands::player_play,
            commands::player_pause,
            commands::player_stop,
            commands::player_next,
            commands::player_previous,
            commands::player_seek_to,
            commands::player_seek_by,
            commands::player_set_volume,
            commands::player_toggle_mute,
            commands::player_set_speed,
            commands::queue_play_now,
            commands::queue_add,
            commands::queue_play_next,
            commands::queue_remove,
            commands::queue_jump_to,
            commands::queue_move,
            commands::queue_reorder,
            commands::queue_clear_upcoming,
            commands::queue_clear_all,
            commands::queue_set_shuffle,
            commands::queue_set_repeat,
            commands::queue_start,
            commands::queue_save_as_playlist,
            commands::search,
            commands::search_history_clear,
            commands::search_history_remove,
            commands::favorites_toggle,
            commands::playlist_create,
            commands::playlist_rename,
            commands::playlist_set_description,
            commands::playlist_delete,
            commands::playlist_duplicate,
            commands::playlist_add_tracks,
            commands::playlist_remove_track,
            commands::playlist_reorder_track,
            commands::playlist_tracks,
            commands::history_clear,
            commands::history_remove,
            commands::get_lyrics,
            commands::get_settings,
            commands::set_settings,
            commands::get_diagnostics,
            commands::repair_runtime,
        ])
        .run(tauri::generate_context!())
        .expect("error while running MELO");
}
