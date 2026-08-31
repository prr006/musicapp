//! MELO application shell (Tauri 2).
//!
//! Layering (see docs/ARCHITECTURE.md):
//!
//! ```text
//! React (src/)  ──invoke──►  commands.rs  ──UserCommand──►  playback_service
//!                                                              │ PlaybackCore
//!                                                              ▼
//! React (src/)  ◄──event──  events.rs    ◄──EngineEvent──   mpv (child process)
//! ```
//!
//! Rust owns ALL playback state. The webview renders backend state and sends
//! intent — nothing else.

mod commands;
mod events;
mod mpv;
mod playback_service;
mod resolver;
mod settings_store;

use std::time::Duration;

use tauri::Manager;

use melo_core::persistence::Settings;
use playback_service::PlaybackHandle;
use settings_store::SettingsStore;

pub struct MeloState {
    pub playback: PlaybackHandle,
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

            let settings = SettingsStore::load(&config_dir);
            let current: Settings = settings.get();

            // mpv location: env override > "mpv" on PATH. Windows users can
            // also drop mpv.exe next to MELO.exe (documented in README).
            let mpv_program = std::env::var("MELO_MPV_PATH").unwrap_or_else(|_| {
                #[cfg(windows)]
                {
                    let beside_exe = std::env::current_exe()
                        .ok()
                        .and_then(|p| p.parent().map(|d| d.join("mpv.exe")))
                        .filter(|p| p.exists());
                    match beside_exe {
                        Some(p) => p.to_string_lossy().into_owned(),
                        None => "mpv".to_string(),
                    }
                }
                #[cfg(not(windows))]
                {
                    "mpv".to_string()
                }
            });

            let playback = playback_service::spawn(
                app.handle().clone(),
                config_dir,
                mpv_program,
                current.resume_last_session,
            );

            app.manage(MeloState { playback });
            app.manage(settings);
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                // Give the playback service a beat to flush the session so
                // the next launch restores the queue (spec §31).
                if let Some(state) = window.try_state::<MeloState>() {
                    state.playback.flush();
                    std::thread::sleep(Duration::from_millis(120));
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_playback_state,
            commands::get_queue,
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
            commands::get_settings,
            commands::set_settings,
            commands::search,
            commands::get_lyrics,
        ])
        .run(tauri::generate_context!())
        .expect("error while running MELO");
}
