//! MELO desktop app — Tauri 2 shell.
//!
//! The native layer is intentionally tiny (docs/ARCHITECTURE.md):
//! * `libmpv` — in-process media engine (runtime-loaded DLL, event-driven)
//! * `runtime` — pinned, digest-verified libmpv/yt-dlp management
//! * `ytdlp` — search/resolve subprocess (absolute path, never PATH)
//! * `lrclib` — lyrics provider
//! * `library`/`settings_store` — local-first JSON persistence
//! The queue and all app logic live in the frontend.

mod commands;
mod events;
mod libmpv;
mod lrclib;
mod runtime;
mod settings_store;
mod ytdlp;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use melo_core::library::LibraryStore;
use runtime::RuntimeHandle;
use settings_store::SettingsStore;
use tauri::Manager;

use crate::libmpv::Player;

pub struct MeloState {
    /// The libmpv engine. `None` while the runtime is being installed or
    /// after a failure — commands then return an actionable error.
    pub player: Mutex<Option<Arc<Player>>>,
    pub runtime: RuntimeHandle,
    pub config_dir: PathBuf,
}

/// Bring the engine up (idempotent). Called at startup when the DLL exists
/// and again after a successful runtime install/repair.
pub fn start_engine(app: &tauri::AppHandle, config_dir: &std::path::Path) {
    let state = match app.try_state::<MeloState>() {
        Some(s) => s,
        None => return,
    };
    if !state.runtime.libmpv_found() {
        return;
    }
    // Volume/mute/speed live in the frontend session; engine starts at
    // neutral defaults and the app applies its persisted values on boot.
    let dll = state.runtime.libmpv_path();
    match Player::start(&dll, app.clone(), 80.0, false, 1.0) {
        Ok(player) => {
            let mut guard = state.player.lock().unwrap_or_else(|p| p.into_inner());
            // Replace (and implicitly stop) any previous engine.
            if let Some(old) = guard.replace(Arc::new(player)) {
                old.shutdown();
            }
        }
        Err(e) => {
            eprintln!("[melo] engine start failed: {e}");
            let _ = tauri::Emitter::emit(
                app,
                events::RUNTIME_STATUS,
                events::RuntimeStatus {
                    phase: "error",
                    message: format!(
                        "Couldn't start the playback engine ({e}). \
                         Use Settings → Diagnostics → Repair runtime."
                    ),
                },
            );
        }
    }
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let config_dir: PathBuf = app
                .path()
                .app_config_dir()
                .map_err(|e| Box::<dyn std::error::Error>::from(e.to_string()))?;
            std::fs::create_dir_all(&config_dir)
                .map_err(|e| Box::<dyn std::error::Error>::from(e.to_string()))?;

            let settings = Arc::new(SettingsStore::load(&config_dir));
            let library = Arc::new(LibraryStore::open(&config_dir.join("library.json")));
            let runtime = RuntimeHandle::new(&config_dir);
            let lyrics_cache = config_dir.join("lyrics-cache");
            let lrclib = Arc::new(lrclib::LrclibClient::new(Some(lyrics_cache)));

            app.manage(MeloState {
                player: Mutex::new(None),
                runtime: runtime.clone(),
                config_dir: config_dir.clone(),
            });
            app.manage(settings.clone());
            app.manage(library);
            app.manage(runtime.clone());
            app.manage(lrclib);

            // Engine now, or after a one-time verified runtime install.
            if runtime.libmpv_found() {
                start_engine(app.handle(), &config_dir);
            } else {
                let app_handle = app.handle().clone();
                let cfg = config_dir.clone();
                runtime::ensure_and_report(app_handle, runtime.clone(), move || {
                    start_engine(&app_handle, &cfg);
                });
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                if let Some(state) = window.app_handle().try_state::<MeloState>() {
                    if let Some(player) = state
                        .player
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .take()
                    {
                        player.shutdown(); // clean stop, mpv is torn down
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::player_get_state,
            commands::player_load,
            commands::player_play,
            commands::player_pause,
            commands::player_toggle_play,
            commands::player_stop,
            commands::player_seek,
            commands::player_set_volume,
            commands::player_set_mute,
            commands::player_set_speed,
            commands::resolve_track,
            commands::get_session,
            commands::set_session,
            commands::search,
            commands::search_history_clear,
            commands::search_history_remove,
            commands::favorites_toggle,
            commands::record_play,
            commands::get_library,
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
