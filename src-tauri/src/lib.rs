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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use melo_core::library::LibraryStore;
use runtime::RuntimeHandle;
use settings_store::SettingsStore;
use tauri::Manager;

use crate::libmpv::Player;

pub struct MeloState {
    /// The libmpv engine. `None` while the engine is still starting on its
    /// dedicated background thread, while the runtime is being installed, or
    /// after a failure — commands then return an actionable error.
    pub player: Mutex<Option<Arc<Player>>>,
    pub runtime: RuntimeHandle,
    pub config_dir: PathBuf,
    /// Claimed for the whole duration of an engine start, so concurrent
    /// callers (boot, runtime-install callback, repair) can never construct
    /// two libmpv instances.
    pub engine_starting: AtomicBool,
    /// Set the moment a window close is requested. The engine-start thread
    /// checks it before AND after construction, so app shutdown can never
    /// race (or dead-lock against) a libmpv initialization in flight.
    pub exiting: AtomicBool,
}

/// Bring the engine up. Idempotent and **asynchronous**: it only spawns the
/// dedicated engine thread and returns immediately.
///
/// libmpv construction must NEVER run on the Tauri main/UI thread. `mpv_create`
/// starts mpv's internal core thread, which executes the pre-init dispatch
/// handshake inside its own playloop; a synchronous `mpv_set_option_string` /
/// `mpv_initialize` from the idle Windows UI thread can park BOTH threads
/// forever inside `mp_dispatch_lock` / `mp_dispatch_queue_process` (the
/// startup freeze: window "Not responding", 0 CPU, before the event thread
/// even existed). The complete construction sequence therefore runs on a
/// dedicated `melo-engine-start` thread — the same shape as the proven
/// first-run path, where the runtime installer thread started the engine and
/// audio played fine.
///
/// When initialization succeeds, the finished `Player` is installed into
/// `MeloState` and the UI learns about it via the `runtime://status` "ready"
/// event. Failures surface as a `runtime://status` "error" event with the
/// real mpv message — startup never blocks on any of this.
pub fn start_engine(app: &tauri::AppHandle, _config_dir: &std::path::Path) {
    // `_config_dir`: the RuntimeHandle already resolved config-relative paths
    // (its own config_dir); the engine itself only needs the DLL path below.
    // The parameter stays so call sites keep passing the app config root.
    let state = match app.try_state::<MeloState>() {
        Some(s) => s,
        None => return,
    };
    if state.exiting.load(Ordering::SeqCst) {
        return; // app is on its way down; do not resurrect the engine
    }
    if !state.runtime.libmpv_found() {
        return;
    }
    // Already up? One engine, ever.
    {
        let guard = state.player.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(p) = guard.as_ref() {
            if p.is_alive() {
                return;
            }
        }
    }
    // Claim the single start slot; a concurrent caller (repair racing boot)
    // must not construct a second libmpv instance.
    if state.engine_starting.swap(true, Ordering::SeqCst) {
        return;
    }
    // Volume/mute/speed live in the frontend session; engine starts at
    // neutral defaults and the app applies its persisted values on boot.
    let dll = state.runtime.libmpv_path();
    let handle = app.clone();
    let after = handle.clone();
    let spawned = std::thread::Builder::new()
        .name("melo-engine-start".into())
        .spawn(move || {
            start_engine_thread(handle, dll);
            // Release the start slot on EVERY exit path (success, failure,
            // aborted-by-shutdown), so a later repair can retry.
            if let Some(state) = after.try_state::<MeloState>() {
                state.engine_starting.store(false, Ordering::SeqCst);
            }
        });
    if let Err(e) = spawned {
        state.engine_starting.store(false, Ordering::SeqCst);
        eprintln!("[melo] engine-start thread spawn failed: {e}");
        let _ = tauri::Emitter::emit(
            app,
            events::RUNTIME_STATUS,
            events::RuntimeStatus {
                phase: "error",
                message: format!(
                    "Couldn't start a thread for the playback engine ({e}). \
                     Use Settings → Diagnostics → Repair runtime."
                ),
            },
        );
    }
}

/// Body of the one-shot `melo-engine-start` thread (see `start_engine`).
/// This is the ONLY place `Player::start` is called from: LoadLibrary →
/// symbol resolve → mpv_create → options → observe → mpv_initialize all
/// happen here, off the UI thread.
fn start_engine_thread(handle: tauri::AppHandle, dll: PathBuf) {
    if let Some(state) = handle.try_state::<MeloState>() {
        if state.exiting.load(Ordering::SeqCst) {
            return; // close was requested while we were spawning
        }
    }
    let started = Player::start(&dll, handle.clone(), 80.0, false, 1.0);
    // `State` borrows the app handle; re-resolve it on this thread.
    let Some(state) = handle.try_state::<MeloState>() else {
        return;
    };
    match started {
        Ok(player) => {
            if state.exiting.load(Ordering::SeqCst) {
                // Window close won the race: tear the fresh engine down
                // instead of installing it into a dying app.
                player.shutdown();
                return;
            }
            let old = {
                let mut guard = state.player.lock().unwrap_or_else(|p| p.into_inner());
                guard.replace(Arc::new(player))
                // Lock dropped BEFORE shutting the old engine down: joining
                // its event thread must never block IPC commands.
            };
            if let Some(old) = old {
                old.shutdown();
            }
        }
        Err(e) => {
            eprintln!("[melo] engine start failed: {e}");
            let _ = tauri::Emitter::emit(
                &handle,
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
                engine_starting: AtomicBool::new(false),
                exiting: AtomicBool::new(false),
            });
            app.manage(settings.clone());
            app.manage(library);
            app.manage(runtime.clone());
            app.manage(lrclib);

            // Engine now, or after a one-time verified runtime install.
            // Both paths are asynchronous: `start_engine` only spawns the
            // dedicated engine thread — `.setup()` must NEVER wait on
            // libmpv (a synchronous engine start froze the Windows UI).
            if runtime.libmpv_found() {
                start_engine(app.handle(), &config_dir);
            } else {
                // `ensure_and_report` takes ownership of one AppHandle; the
                // ready-callback needs its own clone (E0382 otherwise).
                let app_handle = app.handle().clone();
                let ready_handle = app_handle.clone();
                let cfg = config_dir.clone();
                runtime::ensure_and_report(app_handle, runtime.clone(), move || {
                    start_engine(&ready_handle, &cfg);
                });
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                if let Some(state) = window.app_handle().try_state::<MeloState>() {
                    // Flag the shutdown BEFORE touching the engine: a start
                    // still in flight on the engine thread will then tear its
                    // own fresh instance down instead of racing this one.
                    state.exiting.store(true, Ordering::SeqCst);
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
            commands::player_set_normalization,
            commands::resolve_track,
            commands::record_play_progress,
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
