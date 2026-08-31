//! The playback service: the single thread that owns `PlaybackCore`.
//!
//! Everything flows through one loop, so there are no races over playback
//! state and no locks around the state machine:
//!
//! ```text
//!  Tauri commands ─┐
//!                  ├─► mpsc::channel<ToService> ─► [service loop] ─► mpv writer
//!  mpv reader ─────┘        (PlaybackCore)              │
//!                                      │                ▼
//!                                      └──► AppHandle::emit(state / queue / position)
//! ```
//!
//! The loop also persists the session (debounced) so restarts restore the
//! queue, and supervises the mpv process (restart with backoff, max 3).

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use melo_core::persistence::{load_json, save_json_atomic, SessionSnapshot};
use melo_core::player::{EndReason, EngineEvent, EngineHealth, PlayerCommand};
use melo_core::playback::{PlaybackCore, PlaybackSnapshot, UserCommand};
use melo_core::providers::Resolver;
use melo_core::queue::{QueueMachine, QueueView};
use tauri::Emitter;

use crate::events;
use crate::mpv::{self, MpvCommand};

/// Messages that can reach the service loop.
pub enum ToService {
    User(UserCommand),
    Engine(EngineEvent),
    /// Save the session now (window closing).
    Flush,
}

/// Cheap, cloneable handle used by Tauri commands.
#[derive(Clone)]
pub struct PlaybackHandle {
    tx: mpsc::Sender<ToService>,
    snapshot: Arc<Mutex<Arc<PlaybackSnapshot>>>,
    queue: Arc<Mutex<Arc<QueueView>>>,
}

impl PlaybackHandle {
    pub fn send(&self, cmd: UserCommand) {
        let _ = self.tx.send(ToService::User(cmd));
    }

    pub fn flush(&self) {
        let _ = self.tx.send(ToService::Flush);
    }

    pub fn snapshot(&self) -> Arc<PlaybackSnapshot> {
        self.snapshot.lock().map(|s| s.clone()).unwrap_or_else(|_| Arc::new(PlaybackSnapshot::default()))
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
    health: EngineHealth,
}

/// Spawn the playback service. Returns immediately with the handle.
pub fn spawn(
    app: tauri::AppHandle,
    config_dir: PathBuf,
    mpv_program: String,
    resume_last_session: bool,
) -> PlaybackHandle {
    let (tx, rx) = mpsc::channel::<ToService>();
    let snapshot_store: Arc<Mutex<Arc<PlaybackSnapshot>>> = Arc::new(Mutex::new(Arc::new(
        PlaybackSnapshot::default(),
    )));
    let queue_store: Arc<Mutex<Arc<QueueView>>> =
        Arc::new(Mutex::new(Arc::new(QueueMachine::empty_view())));

    let handle = PlaybackHandle {
        tx: tx.clone(),
        snapshot: snapshot_store.clone(),
        queue: queue_store.clone(),
    };

    std::thread::Builder::new()
        .name("melo-playback".into())
        .spawn(move || {
            let resolver = crate::resolver::DirectResolver::new();
            let mut core = PlaybackCore::new(seed_from_time());

            // ---- restore previous session (never autoplay, spec §31) ----
            let session_path = config_dir.join("session.json");
            if resume_last_session {
                if let Some(session) = load_json::<SessionSnapshot>(&session_path)
                    .ok()
                    .flatten()
                {
                    core.restore_queue(session.queue);
                    core.set_restored_audio(
                        session.volume,
                        session.muted,
                        session.speed,
                        session.position_secs,
                    );
                }
            }

            // ---- start the engine ----
            let initial = core.snapshot();
            let mut engine_state = EngineState {
                engine: None,
                restarts: 0,
                program: mpv_program,
                health: EngineHealth::Starting,
            };
            start_engine(
                &mut engine_state,
                &tx,
                initial.volume,
                initial.muted,
                &app,
            );

            let mut last_save = Instant::now();
            let mut dirty_session = true;

            publish(&mut core, &snapshot_store, &queue_store, &app, false);

            loop {
                let msg = match rx.recv() {
                    Ok(m) => m,
                    Err(_) => break, // app is shutting down
                };
                let engine_died = match msg {
                    ToService::User(cmd) => {
                        let cmds = core.handle_user(cmd);
                        dirty_session = true;
                        forward(&mut engine_state, &resolver, cmds, &app, &tx);
                        false
                    }
                    ToService::Engine(EngineEvent::ProcessExited { detail }) => {
                        log::note(&format!("mpv exited: {detail}"));
                        // Reap the dead child (also a no-op kill + wait).
                        if let Some(engine) = engine_state.engine.take() {
                            engine.shutdown();
                        }
                        if engine_state.restarts < 3 {
                            engine_state.restarts += 1;
                            engine_state.health = EngineHealth::Restarting;
                            let _ = app.emit(
                                events::ENGINE_STATUS,
                                events::EngineStatus {
                                    health: engine_state.health,
                                    message: "Playback engine restarted.".into(),
                                },
                            );
                            std::thread::sleep(Duration::from_millis(400));
                            let snap = core.snapshot();
                            start_engine(
                                &mut engine_state,
                                &tx,
                                snap.volume,
                                snap.muted,
                                &app,
                            );
                            // Park the recovered state so the user's next Play
                            // resumes the interrupted track where it died.
                            let interrupted = core.state().current_track.clone();
                            if interrupted.is_some() {
                                let pos = core.state().position_secs;
                                let _ = core.handle_user(UserCommand::LoadPausedAt { position: pos });
                            }
                            false
                        } else {
                            true
                        }
                    }
                    ToService::Engine(ev) => {
                        let cmds = core.handle_engine(ev);
                        forward(&mut engine_state, &resolver, cmds, &app, &tx);
                        false
                    }
                    ToService::Flush => {
                        save_session(&core, &session_path);
                        dirty_session = false;
                        continue;
                    }
                };

                if engine_died {
                    let cmds = core.handle_engine(EngineEvent::ProcessExited {
                        detail: "gave up after 3 restarts".into(),
                    });
                    forward(&mut engine_state, &resolver, cmds, &app, &tx);
                    engine_state.health = EngineHealth::Dead;
                    let _ = app.emit(
                        events::ENGINE_STATUS,
                        events::EngineStatus {
                            health: engine_state.health,
                            message: "Playback engine stopped. Restart MELO to retry.".into(),
                        },
                    );
                }

                publish(&mut core, &snapshot_store, &queue_store, &app, true);

                // Debounced session persistence (every 3s when dirty).
                if dirty_session && last_save.elapsed() > Duration::from_secs(3) {
                    save_session(&core, &session_path);
                    dirty_session = false;
                    last_save = Instant::now();
                }
            }

            save_session(&core, &session_path);
        })
        .expect("failed to spawn playback service thread");

    handle
}

/// Translate semantic `PlayerCommand`s into engine-level `MpvCommand`s,
/// resolving stream URLs on the way. Resolution failures are fed back into
/// the service loop as engine errors so the state machine (not this glue
/// code) owns the error state.
fn forward(
    engine_state: &mut EngineState,
    resolver: &dyn Resolver,
    cmds: Vec<PlayerCommand>,
    app: &tauri::AppHandle,
    tx: &mpsc::Sender<ToService>,
) {
    use PlayerCommand::*;
    for cmd in cmds {
        let mpv_cmd = match cmd {
            LoadTrack { track, start_paused, start_at } => match resolver.resolve(&track) {
                Ok(media) => MpvCommand::LoadUrl {
                    url: media.url,
                    start_paused,
                    start_at,
                },
                Err(err) => {
                    log::note(&format!("resolve failed for {}: {err}", track.title));
                    let _ = app.emit(
                        events::ENGINE_STATUS,
                        events::EngineStatus {
                            health: engine_state.health,
                            message: format!("Couldn't load \"{}\". {}", track.title, err.user_message()),
                        },
                    );
                    // Let the state machine own the failure (spec §29).
                    let _ = tx.send(ToService::Engine(EngineEvent::EndFile {
                        reason: EndReason::Error,
                    }));
                    continue;
                }
            },
            SetPaused(p) => MpvCommand::SetPaused(p),
            SeekAbsolute(t) => MpvCommand::SeekAbsolute(t),
            SeekRelative(d) => MpvCommand::SeekRelative(d),
            Stop => MpvCommand::Stop,
            SetVolume(v) => MpvCommand::SetVolume(v),
            SetMuted(m) => MpvCommand::SetMuted(m),
            SetSpeed(s) => MpvCommand::SetSpeed(s),
        };
        if let Some(engine) = &engine_state.engine {
            let _ = engine.commands.send(mpv_cmd);
        }
    }
}

/// Publish dirty state to the stores + all windows. Called after every
/// message; the core's dirty flags decide what actually gets emitted, so a
/// quiet playback tick costs one atomic check (spec §34).
fn publish(
    core: &mut PlaybackCore,
    snapshot_store: &Arc<Mutex<Arc<PlaybackSnapshot>>>,
    queue_store: &Arc<Mutex<Arc<QueueView>>>,
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
    volume: f64,
    muted: bool,
    app: &tauri::AppHandle,
) {
    let (engine_tx, engine_rx) = mpsc::channel::<EngineEvent>();
    // Bridge: engine events → service loop.
    let service_tx = tx.clone();
    std::thread::Builder::new()
        .name("melo-mpv-bridge".into())
        .spawn(move || {
            while let Ok(ev) = engine_rx.recv() {
                if service_tx.send(ToService::Engine(ev)).is_err() {
                    break;
                }
            }
        })
        .expect("spawn engine bridge");

    let endpoint = mpv::endpoint_for(&engine_state.program);
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

/// Tiny internal logger. Real structured logging lands with Phase 12
/// packaging; for now everything goes to stderr (visible in `tauri dev`).
mod log {
    pub fn note(msg: &str) {
        eprintln!("[melo] {msg}");
    }
}
