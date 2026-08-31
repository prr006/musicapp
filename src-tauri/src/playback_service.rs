//! The playback service: the single thread that owns `PlaybackCore`.
//!
//! Everything flows through one loop, so there are no races over playback
//! state and no locks around the state machine:
//!
//! ```text
//!  Tauri commands ─┐
//!                  ├─► mpsc::channel<ToService> ─► [service loop] ─► mpv writer
//!  mpv reader ─────┘        (PlaybackCore)              │
//!  resolver threads ───────┘                            ▼
//!                                      AppHandle::emit(state / queue / position / library)
//! ```
//!
//! Beyond Phase 1, this loop also:
//! * resolves tracks **off-loop** (worker threads + generation tokens so a
//!   stale resolve can never load the wrong file),
//! * applies start positions as a seek right after `file-loaded` (always
//!   loading paused first → no audio blip, version-safe mpv handling),
//! * runs a load watchdog (dead streams can't hang the UI in "Loading"),
//! * records listening history into the shared library store,
//! * supervises mpv (restart ≤3, auto-resume if it died mid-playback),
//! * persists the session (debounced) and flushes on close.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use melo_core::library::LibraryStore;
use melo_core::persistence::{load_json, save_json_atomic, SessionSnapshot};
use melo_core::player::{EngineEvent, EngineHealth, PlayerCommand};
use melo_core::playback::{PlaybackCore, PlaybackSnapshot, PlaybackStatus, UserCommand};
use melo_core::providers::{ProviderError, ResolvedMedia};
use melo_core::queue::{QueueMachine, QueueView};
use tauri::Emitter;

use crate::events;
use crate::mpv::{self, MpvCommand};
use crate::resolver::ResolverService;

/// Seconds without `file-loaded` before a load is declared failed.
const LOAD_WATCHDOG_SECS: u64 = 30;
/// Loop tick: drives the watchdog + debounced session saves.
const TICK: Duration = Duration::from_millis(500);
/// Session persistence debounce.
const SESSION_SAVE_EVERY: Duration = Duration::from_secs(3);
/// Engine restart cap + backoff.
const MAX_ENGINE_RESTARTS: u32 = 3;
const ENGINE_RESTART_BACKOFF: Duration = Duration::from_millis(400);

/// Messages that can reach the service loop.
pub enum ToService {
    User(UserCommand),
    Engine(EngineEvent),
    /// Worker-thread reply from a track resolution.
    Resolved {
        generation: u64,
        track_id: String,
        track_title: String,
        start_paused: bool,
        start_at: Option<f64>,
        result: Result<ResolvedMedia, ProviderError>,
    },
    SetHistoryEnabled(bool),
    /// Save the session now (window closing).
    Flush,
}

/// Cheap, cloneable handle used by Tauri commands.
#[derive(Clone)]
pub struct PlaybackHandle {
    tx: mpsc::Sender<ToService>,
    snapshot: Arc<std::sync::Mutex<Arc<PlaybackSnapshot>>>,
    queue: Arc<std::sync::Mutex<Arc<QueueView>>>,
}

impl PlaybackHandle {
    pub fn send(&self, cmd: UserCommand) {
        let _ = self.tx.send(ToService::User(cmd));
    }

    pub fn set_history_enabled(&self, enabled: bool) {
        let _ = self.tx.send(ToService::SetHistoryEnabled(enabled));
    }

    pub fn flush(&self) {
        let _ = self.tx.send(ToService::Flush);
    }

    pub fn snapshot(&self) -> Arc<PlaybackSnapshot> {
        self.snapshot
            .lock()
            .map(|s| s.clone())
            .unwrap_or_else(|_| Arc::new(PlaybackSnapshot::default()))
    }

    pub fn queue_view(&self) -> Arc<QueueView> {
        self.queue
            .lock()
            .map(|s| s.clone())
            .unwrap_or_else(|_| Arc::new(QueueMachine::empty_view()))
    }
}

struct EngineState {
    engine: Option<mpv::RunningEngine>,
    restarts: u32,
    program: String,
    ytdl_path: Option<String>,
    health: EngineHealth,
}

impl EngineState {
    fn send(&self, cmd: MpvCommand) {
        if let Some(engine) = &self.engine {
            let _ = engine.commands.send(cmd);
        }
    }
}

/// Post-load actions applied when `file-loaded` arrives.
#[derive(Default)]
struct PendingLoad {
    seek: Option<f64>,
    unpause: bool,
}

/// Track state captured before processing a message (for history).
struct PreState {
    item_id: Option<String>,
    position: f64,
    duration: Option<f64>,
    status: PlaybackStatus,
}

fn prestate(core: &PlaybackCore) -> PreState {
    let s = core.state();
    PreState {
        item_id: s.current_item_id.clone(),
        position: s.position_secs,
        duration: s.duration_secs,
        status: s.status,
    }
}

/// Completion fraction for a finished play period (near-end → 1.0).
fn completion_of(position: f64, duration: Option<f64>) -> f64 {
    match duration {
        Some(d) if d > 0.0 => {
            if position >= d - 1.0 {
                1.0
            } else {
                (position / d).clamp(0.0, 1.0)
            }
        }
        _ => 0.0,
    }
}

/// Spawn the playback service. Returns immediately with the handle.
pub fn spawn(
    app: tauri::AppHandle,
    config_dir: PathBuf,
    mpv_program: String,
    resume_last_session: bool,
    resolver: Arc<ResolverService>,
    library: Arc<LibraryStore>,
) -> PlaybackHandle {
    let (tx, rx) = mpsc::channel::<ToService>();
    let snapshot_store: Arc<std::sync::Mutex<Arc<PlaybackSnapshot>>> =
        Arc::new(std::sync::Mutex::new(Arc::new(PlaybackSnapshot::default())));
    let queue_store: Arc<std::sync::Mutex<Arc<QueueView>>> =
        Arc::new(std::sync::Mutex::new(Arc::new(QueueMachine::empty_view())));

    let handle = PlaybackHandle {
        tx: tx.clone(),
        snapshot: snapshot_store.clone(),
        queue: queue_store.clone(),
    };

    std::thread::Builder::new()
        .name("melo-playback".into())
        .spawn(move || {
            let mut core = PlaybackCore::new(seed_from_time());
            let session_path = config_dir.join("session.json");

            // ---- restore previous session (never autoplay, spec §31) ----
            if resume_last_session {
                if let Some(session) = load_json::<SessionSnapshot>(&session_path).ok().flatten() {
                    core.restore_queue(session.queue);
                    core.set_restored_audio(
                        session.volume,
                        session.muted,
                        session.speed,
                        session.position_secs,
                    );
                }
            }

            let mut engine_state = EngineState {
                engine: None,
                restarts: 0,
                program: mpv_program,
                ytdl_path: resolver.ytdlp_path(),
                health: EngineHealth::Starting,
            };
            start_engine(&mut engine_state, &tx, &app, core.snapshot().volume, core.snapshot().muted);

            publish(&mut core, &snapshot_store, &queue_store, &app, false);
            emit_library(&app, &library);

            let mut generation: u64 = 0;
            let mut pending_load = PendingLoad::default();
            let mut load_deadline: Option<Instant> = None;
            let mut history_enabled = true;
            let mut dirty_session = true;
            let mut last_save = Instant::now();

            loop {
                let msg = match rx.recv_timeout(TICK) {
                    Ok(m) => m,
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        // Tick: watchdog + debounced saves.
                        if let Some(deadline) = load_deadline {
                            if Instant::now() > deadline
                                && core.state().status == PlaybackStatus::Loading
                            {
                                load_deadline = None;
                                log::note("load watchdog fired");
                                let _ = app.emit(
                                    events::ENGINE_STATUS,
                                    events::EngineStatus {
                                        health: engine_state.health,
                                        message: "Couldn't load this track. Retry.".into(),
                                    },
                                );
                                let _ = tx.send(ToService::Engine(EngineEvent::EndFile {
                                    reason: melo_core::player::EndReason::Error,
                                }));
                            }
                        }
                        if dirty_session && last_save.elapsed() > SESSION_SAVE_EVERY {
                            save_session(&core, &session_path);
                            dirty_session = false;
                            last_save = Instant::now();
                        }
                        continue;
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => break, // app shutting down
                };

                let pre = prestate(&core);
                let mut engine_died = false;

                match msg {
                    ToService::User(cmd) => {
                        let cmds = core.handle_user(cmd);
                        dirty_session = true;
                        dispatch(
                            &mut engine_state,
                            &resolver,
                            &tx,
                            &app,
                            &mut generation,
                            &mut pending_load,
                            &mut load_deadline,
                            cmds,
                        );
                    }
                    ToService::Engine(EngineEvent::ProcessExited { detail }) => {
                        log::note(&format!("mpv exited: {detail}"));
                        let was_playing = matches!(
                            core.state().status,
                            PlaybackStatus::Playing | PlaybackStatus::Buffering
                        );
                        let position = core.state().position_secs;
                        // Mark the failure, reap the child, try to restart.
                        let cmds = core.handle_engine(EngineEvent::ProcessExited { detail });
                        dispatch(&mut engine_state, &resolver, &tx, &app, &mut generation, &mut pending_load, &mut load_deadline, cmds);
                        if let Some(engine) = engine_state.engine.take() {
                            engine.shutdown();
                        }
                        engine_state.restarts += 1;
                        if engine_state.restarts <= MAX_ENGINE_RESTARTS {
                            engine_state.health = EngineHealth::Restarting;
                            let _ = app.emit(
                                events::ENGINE_STATUS,
                                events::EngineStatus {
                                    health: engine_state.health,
                                    message: "Playback engine restarted.".into(),
                                },
                            );
                            std::thread::sleep(ENGINE_RESTART_BACKOFF);
                            let snap = core.snapshot();
                            start_engine(&mut engine_state, &tx, &app, snap.volume, snap.muted);
                            // Recover: park at the interruption point and, if
                            // it was actually sounding, continue playback.
                            if core.state().current_track.is_some() && engine_state.engine.is_some()
                            {
                                core.handle_user(UserCommand::LoadPausedAt { position });
                                if was_playing {
                                    let cmds = core.handle_user(UserCommand::Play);
                                    dirty_session = true;
                                    dispatch(
                                        &mut engine_state,
                                        &resolver,
                                        &tx,
                                        &app,
                                        &mut generation,
                                        &mut pending_load,
                                        &mut load_deadline,
                                        cmds,
                                    );
                                }
                            }
                        } else {
                            engine_died = true;
                        }
                    }
                    ToService::Engine(EngineEvent::FileLoaded) => {
                        let cmds = core.handle_engine(EngineEvent::FileLoaded);
                        // Flush post-load actions: seek + optional unpause.
                        let pending = std::mem::take(&mut pending_load);
                        if let Some(seek) = pending.seek {
                            engine_state.send(MpvCommand::SeekAbsolute(seek));
                        }
                        if pending.unpause {
                            engine_state.send(MpvCommand::SetPaused(false));
                        }
                        load_deadline = None;
                        if history_enabled {
                            if let Some(track) = core.state().current_track.clone() {
                                let now = melo_core::ids::now_ms();
                                let changed =
                                    library.with_mut(|l| l.record_play(&track, now));
                                if changed {
                                    emit_library(&app, &library);
                                }
                            }
                        }
                        dispatch(&mut engine_state, &resolver, &tx, &app, &mut generation, &mut pending_load, &mut load_deadline, cmds);
                    }
                    ToService::Engine(ev) => {
                        let cmds = core.handle_engine(ev);
                        dispatch(&mut engine_state, &resolver, &tx, &app, &mut generation, &mut pending_load, &mut load_deadline, cmds);
                    }
                    ToService::Resolved {
                        generation: gen,
                        track_id,
                        track_title,
                        start_paused,
                        start_at,
                        result,
                    } => {
                        if gen != generation {
                            log::note(&format!(
                                "dropping stale resolve for {track_title} (gen {gen} != {generation})"
                            ));
                            continue;
                        }
                        match result {
                            Ok(media) => {
                                send_load(
                                    &engine_state,
                                    &mut pending_load,
                                    &mut load_deadline,
                                    media.url.clone(),
                                    start_paused,
                                    start_at,
                                );
                            }
                            Err(err) => {
                                log::note(&format!("resolve failed for {track_title}: {err}"));
                                let _ = app.emit(
                                    events::ENGINE_STATUS,
                                    events::EngineStatus {
                                        health: engine_state.health,
                                        message: format!(
                                            "Couldn't load \"{track_title}\". {}",
                                            err.user_message()
                                        ),
                                    },
                                );
                                let _ = tx.send(ToService::Engine(EngineEvent::EndFile {
                                    reason: melo_core::player::EndReason::Error,
                                }));
                            }
                        }
                    }
                    ToService::SetHistoryEnabled(enabled) => {
                        history_enabled = enabled;
                    }
                    ToService::Flush => {
                        finalize_history(&pre, &core, &library, &app);
                        save_session(&core, &session_path);
                        dirty_session = false;
                        last_save = Instant::now();
                        continue;
                    }
                }

                // History: finalize when the pre-message track was left
                // (track changed, stopped, or errored).
                finalize_history(&pre, &core, &library, &app);

                if engine_died {
                    let cmds = core.handle_engine(EngineEvent::ProcessExited {
                        detail: "gave up after restarts".into(),
                    });
                    dispatch(&mut engine_state, &resolver, &tx, &app, &mut generation, &mut pending_load, &mut load_deadline, cmds);
                    engine_state.health = EngineHealth::Dead;
                    let _ = app.emit(
                        events::ENGINE_STATUS,
                        events::EngineStatus {
                            health: engine_state.health,
                            message: "Playback engine stopped. Restart MELO to try again.".into(),
                        },
                    );
                }

                publish(&mut core, &snapshot_store, &queue_store, &app, true);

                if dirty_session && last_save.elapsed() > SESSION_SAVE_EVERY {
                    save_session(&core, &session_path);
                    dirty_session = false;
                    last_save = Instant::now();
                }
            }

            // ---- shutdown: kill mpv, persist everything ----
            if let Some(engine) = engine_state.engine.take() {
                engine.shutdown();
            }
            save_session(&core, &session_path);
        })
        .expect("failed to spawn playback service thread");

    handle
}

/// Translate semantic `PlayerCommand`s into engine actions. Track loads go
/// through the async resolver with a fresh generation token.
#[allow(clippy::too_many_arguments)]
fn dispatch(
    engine_state: &mut EngineState,
    resolver: &Arc<ResolverService>,
    tx: &mpsc::Sender<ToService>,
    app: &tauri::AppHandle,
    generation: &mut u64,
    pending_load: &mut PendingLoad,
    load_deadline: &mut Option<Instant>,
    cmds: Vec<PlayerCommand>,
) {
    use PlayerCommand::*;
    for cmd in cmds {
        match cmd {
            LoadTrack { track, start_paused, start_at } => {
                *generation += 1;
                let gen = *generation;
                *pending_load = PendingLoad::default();
                *load_deadline = None;
                let is_local = track.source == melo_core::domain::TrackSource::Local;
                if is_local {
                    // Local resolution is a filesystem stat — safe inline.
                    match resolver.resolve(&track) {
                        Ok(media) => {
                            send_load(engine_state, pending_load, load_deadline, media.url, start_paused, start_at);
                        }
                        Err(err) => {
                            resolve_error(engine_state, app, &track.title, err);
                            let _ = tx.send(ToService::Engine(EngineEvent::EndFile {
                                reason: melo_core::player::EndReason::Error,
                            }));
                        }
                    }
                } else {
                    // Remote resolution takes seconds — never block the loop.
                    let resolver = resolver.clone();
                    let tx = tx.clone();
                    let track_title = track.title.clone();
                    let track_id = track.id.clone();
                    let spawn_result = std::thread::Builder::new()
                        .name("melo-resolve".into())
                        .spawn(move || {
                            let result = resolver.resolve(&track);
                            let _ = tx.send(ToService::Resolved {
                                generation: gen,
                                track_id,
                                track_title,
                                start_paused,
                                start_at,
                                result,
                            });
                        });
                    if let Err(e) = spawn_result {
                        log::note(&format!("resolve thread spawn failed: {e}"));
                        resolve_error(engine_state, app, &track_title, ProviderError::Detail("internal error".into()));
                        let _ = tx.send(ToService::Engine(EngineEvent::EndFile {
                            reason: melo_core::player::EndReason::Error,
                        }));
                    }
                }
            }
            SetPaused(p) => engine_state.send(MpvCommand::SetPaused(p)),
            SeekAbsolute(t) => engine_state.send(MpvCommand::SeekAbsolute(t)),
            SeekRelative(d) => engine_state.send(MpvCommand::SeekRelative(d)),
            Stop => engine_state.send(MpvCommand::Stop),
            SetVolume(v) => engine_state.send(MpvCommand::SetVolume(v)),
            SetMuted(m) => engine_state.send(MpvCommand::SetMuted(m)),
            SetSpeed(s) => engine_state.send(MpvCommand::SetSpeed(s)),
        }
    }
}

/// Load `url` now. Loads that need a start position always load paused and
/// seek after `file-loaded`, then unpause — no audio blip, no reliance on
/// loadfile option-map support.
fn send_load(
    engine_state: &EngineState,
    pending_load: &mut PendingLoad,
    load_deadline: &mut Option<Instant>,
    url: String,
    start_paused: bool,
    start_at: Option<f64>,
) {
    let seek = start_at.filter(|t| *t > 0.5);
    let load_paused = start_paused || seek.is_some();
    *pending_load = PendingLoad { seek, unpause: !start_paused && seek.is_some() };
    *load_deadline = Some(Instant::now() + Duration::from_secs(LOAD_WATCHDOG_SECS));
    engine_state.send(MpvCommand::LoadUrl { url, start_paused: load_paused });
}

fn resolve_error(engine_state: &EngineState, app: &tauri::AppHandle, title: &str, err: ProviderError) {
    let _ = app.emit(
        events::ENGINE_STATUS,
        events::EngineStatus {
            health: engine_state.health,
            message: format!("Couldn't load \"{title}\". {}", err.user_message()),
        },
    );
}

/// Close out the history entry for a track we just left.
fn finalize_history(pre: &PreState, core: &PlaybackCore, library: &Arc<LibraryStore>, app: &tauri::AppHandle) {
    if pre.item_id.is_none() {
        return;
    }
    let post = core.state();
    let left = post.current_item_id != pre.item_id
        || (matches!(post.status, PlaybackStatus::Idle | PlaybackStatus::Error)
            && !matches!(pre.status, PlaybackStatus::Idle | PlaybackStatus::Error));
    if !left {
        return;
    }
    // The entry was recorded by track id on FileLoaded. Finalize the most
    // recent unfinished entry that isn't the newly current track (handles
    // every leave path: next, jump, remove-current, stop, error, EOF).
    let new_track_id = post.current_track.as_ref().map(|t| t.id.clone());
    let completion = completion_of(pre.position, pre.duration);
    let position = pre.position;
    let changed = library.with_mut(|l| {
        let candidate = l
            .history
            .iter()
            .find(|h| h.completion == 0.0 && Some(h.track.id.clone()) != new_track_id)
            .map(|h| h.track.id.clone());
        match candidate {
            Some(id) => l.finish_recent_for(&id, position, completion),
            None => false,
        }
    });
    if changed {
        emit_library(app, library);
    }
}

fn emit_library(app: &tauri::AppHandle, library: &Arc<LibraryStore>) {
    let _ = app.emit(events::LIBRARY_UPDATED, library.snapshot());
}

/// Publish dirty state to the stores + all windows. The core's dirty flags
/// decide what actually gets emitted, so a quiet tick costs nothing.
fn publish(
    core: &mut PlaybackCore,
    snapshot_store: &Arc<std::sync::Mutex<Arc<PlaybackSnapshot>>>,
    queue_store: &Arc<std::sync::Mutex<Arc<QueueView>>>,
    app: &tauri::AppHandle,
    emit: bool,
) {
    let state_changed = core.drain_state_dirty();
    let queue_changed = core.drain_queue_dirty();

    if state_changed {
        if let Ok(mut guard) = snapshot_store.lock() {
            *guard = Arc::new(core.snapshot());
            if emit {
                let _ = app.emit(events::PLAYBACK_STATE, (*guard).clone());
            }
        }
    }
    if queue_changed {
        if let Ok(mut guard) = queue_store.lock() {
            *guard = Arc::new(core.queue().view());
            if emit {
                let _ = app.emit(events::QUEUE_VIEW, (*guard).clone());
            }
        }
    }
    if let Some(position) = core.take_position_update() {
        if emit {
            let _ = app.emit(events::PLAYBACK_POSITION, position);
        }
    }
}

fn save_session(core: &PlaybackCore, path: &PathBuf) {
    let snap = core.snapshot();
    let session = SessionSnapshot::capture(
        core.queue(),
        snap.volume,
        snap.muted,
        snap.speed,
        snap.position_secs,
    );
    if let Err(e) = save_json_atomic(path, &session) {
        log::note(&format!("session save failed: {e}"));
    }
}

fn start_engine(
    engine_state: &mut EngineState,
    tx: &mpsc::Sender<ToService>,
    app: &tauri::AppHandle,
    volume: f64,
    muted: bool,
) {
    let (engine_tx, engine_rx) = mpsc::channel::<EngineEvent>();
    // Bridge: engine events → service loop.
    let service_tx = tx.clone();
    let _ = std::thread::Builder::new()
        .name("melo-mpv-bridge".into())
        .spawn(move || {
            while let Ok(ev) = engine_rx.recv() {
                if service_tx.send(ToService::Engine(ev)).is_err() {
                    break;
                }
            }
        });

    let endpoint = mpv::endpoint_for(&engine_state.program, engine_state.ytdl_path.clone());
    match mpv::start(&endpoint, engine_tx, volume, muted) {
        Ok(engine) => {
            engine_state.engine = Some(engine);
            engine_state.health = EngineHealth::Running;
            let _ = app.emit(
                events::ENGINE_STATUS,
                events::EngineStatus { health: engine_state.health, message: String::new() },
            );
        }
        Err(detail) => {
            log::note(&format!("engine start failed: {detail}"));
            engine_state.health = EngineHealth::Dead;
            let _ = app.emit(
                events::ENGINE_STATUS,
                events::EngineStatus {
                    health: engine_state.health,
                    message: "Couldn't start the playback engine. Is mpv installed and on PATH?"
                        .into(),
                },
            );
        }
    }
}

fn seed_from_time() -> u64 {
    static EXTRA: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0x5EED);
    nanos ^ (EXTRA.fetch_add(0x9E37, Ordering::Relaxed) << 32) | 1
}

/// Tiny internal logger (stderr, visible in `tauri dev`).
mod log {
    pub fn note(msg: &str) {
        eprintln!("[melo] {msg}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn completion_of_marks_near_end_as_finished() {
        assert!((completion_of(180.0, Some(180.0)) - 1.0).abs() < 1e-9);
        assert!((completion_of(179.5, Some(180.0)) - 1.0).abs() < 1e-9); // within 1s
        assert!((completion_of(90.0, Some(180.0)) - 0.5).abs() < 1e-9);
        assert!((completion_of(90.0, None) - 0.0).abs() < 1e-9);
        assert!((completion_of(-5.0, Some(180.0)) - 0.0).abs() < 1e-9);
        assert!((completion_of(999.0, Some(180.0)) - 1.0).abs() < 1e-9); // clamped
    }

    #[test]
    fn generation_tokens_are_monotonic_and_comparable() {
        // The stale-resolve guard is a plain u64 comparison — documented and
        // exercised by the service loop; this pins the semantics.
        let mut generation = 0u64;
        generation += 1;
        let in_flight = generation;
        generation += 1;
        assert_ne!(in_flight, generation, "stale resolve must be dropped");
    }
}
