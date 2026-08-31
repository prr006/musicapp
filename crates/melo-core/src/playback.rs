//! The playback state machine.
//!
//! `PlaybackCore` is THE owner of playback truth (spec §2). It:
//!
//! * consumes [`EngineEvent`]s (engine ground truth) and [`UserCommand`]s
//!   (intent from the UI),
//! * decides what happens next using the [`crate::queue::QueueMachine`],
//! * emits [`PlayerCommand`]s for the host to forward to the engine,
//! * exposes dirty flags so the host publishes state/queue/position events
//!   only when something actually changed.
//!
//! There is exactly one playback clock: `EngineEvent::PropertyTimePos` feeds
//! `state.position_secs`; the UI renders it, it never computes it.
//!
//! EOF policy (spec §3): `EndFile { reason: Eof }` is the primary auto-next
//! signal. `eof_handled` latches per load so the fallback observers
//! (`eof-reached`, unexpected `idle-active`) can never double-advance.

use serde::{Deserialize, Serialize};

use crate::domain::Track;
use crate::player::{EndReason, EngineEvent, PlayerCommand};
use crate::queue::{QueueMachine, QueueStep, RepeatMode};

/// Playback status. `Buffering` is transient over `Playing`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PlaybackStatus {
    Idle,
    Loading,
    Playing,
    Paused,
    Buffering,
    Error,
}

/// Complete playback snapshot — what gets published to the UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackSnapshot {
    pub status: PlaybackStatus,
    pub current_item_id: Option<String>,
    pub current_track: Option<Track>,
    pub position_secs: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_secs: Option<f64>,
    /// 0–100.
    pub volume: f64,
    pub muted: bool,
    pub speed: f64,
    pub shuffle: bool,
    pub repeat: RepeatMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub buffering_pct: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Queue revision this snapshot was taken against.
    pub queue_rev: u64,
}

impl Default for PlaybackSnapshot {
    fn default() -> Self {
        Self {
            status: PlaybackStatus::Idle,
            current_item_id: None,
            current_track: None,
            position_secs: 0.0,
            duration_secs: None,
            volume: 80.0,
            muted: false,
            speed: 1.0,
            shuffle: false,
            repeat: RepeatMode::Off,
            buffering_pct: None,
            error: None,
            queue_rev: 0,
        }
    }
}

/// Position update published on a throttled channel (lyrics + progress UI).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PositionUpdate {
    pub position_secs: f64,
    pub duration_secs: Option<f64>,
    pub speed: f64,
}

/// Intent sent from the UI. Pure data over IPC; validated here.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UserCommand {
    TogglePlay,
    Play,
    Pause,
    Stop,
    Next,
    Previous,
    SeekTo { position: f64 },
    SeekBy { delta: f64 },
    SetVolume { volume: f64 },
    ToggleMute,
    SetSpeed { speed: f64 },
    SetShuffle { enabled: bool },
    SetRepeat { mode: RepeatMode },
    /// Play a track immediately (insert after current + jump).
    PlayTrack { track: Track },
    /// Append to the end of the queue.
    AddToQueue { tracks: Vec<Track> },
    /// Insert directly after the current item.
    PlayNext { tracks: Vec<Track> },
    RemoveQueueItem { item_id: String },
    JumpToQueueItem { item_id: String },
    MoveQueueItem { item_id: String, up: bool },
    ReorderQueue { from: usize, to: usize },
    ClearUpcoming,
    ClearQueue,
    /// Replace the queue with a sequence (playlist/album start).
    StartSequence { tracks: Vec<Track>, shuffle: bool },
    /// Restore hook: load current at `position` without playing.
    LoadPausedAt { position: f64 },
}

/// How many seconds into a track "previous" restarts it instead of jumping
/// back in history (Spotify-like behavior).
pub const PREVIOUS_RESTART_SECS: f64 = 3.0;
/// Minimum spacing between throttled position publishes.
pub const POSITION_PUBLISH_INTERVAL: f64 = 0.2;

/// The playback state machine.
pub struct PlaybackCore {
    queue: QueueMachine,
    state: PlaybackSnapshot,
    /// Latch: EOF consumed for the current load (dedups fallback signals).
    eof_handled: bool,
    /// True while an end-file(stop) from our own load/stop is expected.
    expecting_stop: bool,
    /// Last pause state echoed by the engine (authoritative).
    engine_paused: bool,
    /// Where Play should resume after a session restore.
    resume_at: Option<f64>,
    last_published_position: f64,
    state_dirty: bool,
    queue_dirty: bool,
    position_update: Option<PositionUpdate>,
}

impl PlaybackCore {
    pub fn new(seed: u64) -> Self {
        Self {
            queue: QueueMachine::with_seed(seed),
            state: PlaybackSnapshot::default(),
            eof_handled: false,
            expecting_stop: false,
            engine_paused: false,
            resume_at: None,
            last_published_position: 0.0,
            state_dirty: false,
            queue_dirty: false,
            position_update: None,
        }
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    pub fn snapshot(&self) -> PlaybackSnapshot {
        let mut s = self.state.clone();
        s.shuffle = self.queue.shuffle();
        s.repeat = self.queue.repeat();
        s.queue_rev = self.queue.rev();
        s
    }

    pub fn queue(&self) -> &QueueMachine {
        &self.queue
    }

    pub fn queue_mut(&mut self) -> &mut QueueMachine {
        &mut self.queue
    }

    pub fn state(&self) -> &PlaybackSnapshot {
        &self.state
    }

    pub fn drain_state_dirty(&mut self) -> bool {
        std::mem::replace(&mut self.state_dirty, false)
    }

    pub fn drain_queue_dirty(&mut self) -> bool {
        std::mem::replace(&mut self.queue_dirty, false)
    }

    pub fn take_position_update(&mut self) -> Option<PositionUpdate> {
        self.position_update.take()
    }

    fn touch_state(&mut self) {
        self.state_dirty = true;
    }

    fn touch_queue(&mut self) {
        self.queue_dirty = true;
        self.state_dirty = true; // queue_rev is part of the snapshot
    }

    fn publish_position(&mut self, force: bool) {
        let p = self.state.position_secs;
        if force || (p - self.last_published_position).abs() >= POSITION_PUBLISH_INTERVAL {
            self.last_published_position = p;
            self.position_update = Some(PositionUpdate {
                position_secs: p,
                duration_secs: self.state.duration_secs,
                speed: self.state.speed,
            });
        }
    }

    // ------------------------------------------------------------------
    // User commands
    // ------------------------------------------------------------------

    /// Apply UI intent; returns commands for the engine.
    pub fn handle_user(&mut self, cmd: UserCommand) -> Vec<PlayerCommand> {
        let mut out = Vec::new();
        match cmd {
            UserCommand::TogglePlay => {
                match self.state.status {
                    PlaybackStatus::Playing | PlaybackStatus::Buffering => {
                        out.extend(self.set_paused(true));
                    }
                    PlaybackStatus::Paused | PlaybackStatus::Idle | PlaybackStatus::Error => {
                        out.extend(self.set_paused(false));
                    }
                    PlaybackStatus::Loading => {}
                }
            }
            UserCommand::Play => out.extend(self.set_paused(false)),
            UserCommand::Pause => out.extend(self.set_paused(true)),
            UserCommand::Stop => {
                self.expecting_stop = true;
                self.state.status = PlaybackStatus::Idle;
                self.state.position_secs = 0.0;
                self.state.error = None;
                self.touch_state();
                self.publish_position(true);
                out.push(PlayerCommand::Stop);
            }
            UserCommand::Next => {
                let step = self.queue.advance(true);
                out.extend(self.apply_step(step));
            }
            UserCommand::Previous => {
                if self.state.position_secs > PREVIOUS_RESTART_SECS
                    && self.state.status != PlaybackStatus::Idle
                {
                    self.seek_absolute(0.0, &mut out);
                } else {
                    let step = self.queue.previous();
                    out.extend(self.apply_step(step));
                }
            }
            UserCommand::SeekTo { position } => {
                let mut out2 = Vec::new();
                self.seek_absolute(position.max(0.0), &mut out2);
                out.extend(out2);
            }
            UserCommand::SeekBy { delta } => {
                let target = (self.state.position_secs + delta).max(0.0);
                self.seek_absolute(target, &mut out);
            }
            UserCommand::SetVolume { volume } => {
                self.state.volume = volume.clamp(0.0, 100.0);
                self.touch_state();
                out.push(PlayerCommand::SetVolume(self.state.volume));
            }
            UserCommand::ToggleMute => {
                self.state.muted = !self.state.muted;
                self.touch_state();
                out.push(PlayerCommand::SetMuted(self.state.muted));
            }
            UserCommand::SetSpeed { speed } => {
                self.state.speed = if speed.is_finite() { speed.clamp(0.25, 4.0) } else { 1.0 };
                self.touch_state();
                out.push(PlayerCommand::SetSpeed(self.state.speed));
            }
            UserCommand::SetShuffle { enabled } => {
                self.queue.set_shuffle(enabled);
                self.touch_queue();
            }
            UserCommand::SetRepeat { mode } => {
                self.queue.set_repeat(mode);
                self.touch_queue();
            }
            UserCommand::PlayTrack { track } => {
                let step = self.queue.play_now(track);
                out.extend(self.apply_step(step));
            }
            UserCommand::AddToQueue { tracks } => {
                self.queue.add_tracks(tracks, crate::queue::AddPosition::End);
                self.touch_queue();
            }
            UserCommand::PlayNext { tracks } => {
                self.queue
                    .add_tracks(tracks, crate::queue::AddPosition::AfterCurrent);
                self.touch_queue();
            }
            UserCommand::RemoveQueueItem { item_id } => {
                let step = self.queue.remove(&item_id);
                self.touch_queue();
                if matches!(step, QueueStep::EndOfQueue) {
                    // The removed item WAS current: nothing should keep
                    // displaying it.
                    self.state.current_item_id = None;
                    self.state.current_track = None;
                    self.state.position_secs = 0.0;
                    self.state.duration_secs = None;
                    self.touch_state();
                }
                out.extend(self.apply_step(step));
            }
            UserCommand::JumpToQueueItem { item_id } => {
                let step = self.queue.jump_to(&item_id);
                self.touch_queue();
                out.extend(self.apply_step(step));
            }
            UserCommand::MoveQueueItem { item_id, up } => {
                if up {
                    self.queue.move_up(&item_id);
                } else {
                    self.queue.move_down(&item_id);
                }
                self.touch_queue();
            }
            UserCommand::ReorderQueue { from, to } => {
                self.queue.reorder_upcoming(from, to);
                self.touch_queue();
            }
            UserCommand::ClearUpcoming => {
                self.queue.clear_upcoming();
                self.touch_queue();
            }
            UserCommand::ClearQueue => {
                let step = self.queue.clear_all();
                self.touch_queue();
                out.extend(self.apply_step(step));
                self.state.current_item_id = None;
                self.state.current_track = None;
                self.state.position_secs = 0.0;
                self.state.duration_secs = None;
                self.touch_state();
                self.publish_position(true);
            }
            UserCommand::StartSequence { tracks, shuffle } => {
                let step = self.queue.start_sequence(tracks, shuffle);
                self.state.shuffle = shuffle;
                self.touch_queue();
                out.extend(self.apply_step(step));
            }
            UserCommand::LoadPausedAt { position } => {
                // Session restore: adopt position, stay idle until Play.
                self.state.position_secs = position.max(0.0);
                self.resume_at = Some(self.state.position_secs);
                self.state.status = PlaybackStatus::Idle;
                self.touch_state();
                self.publish_position(true);
            }
        }
        out
    }

    // ------------------------------------------------------------------
    // Engine events
    // ------------------------------------------------------------------

    /// Apply engine ground truth; returns commands for the engine (auto-next
    /// produces a `Load`).
    pub fn handle_engine(&mut self, ev: EngineEvent) -> Vec<PlayerCommand> {
        let mut out = Vec::new();
        match ev {
            EngineEvent::FileLoaded => {
                self.expecting_stop = false;
                self.eof_handled = false;
                self.state.error = None;
                self.state.status = if self.engine_paused {
                    PlaybackStatus::Paused
                } else {
                    PlaybackStatus::Playing
                };
                self.state.buffering_pct = None;
                self.touch_state();
                self.publish_position(true);
            }
            EngineEvent::PropertyTimePos(p) => {
                if p >= 0.0 {
                    self.state.position_secs = p;
                    self.publish_position(false);
                }
            }
            EngineEvent::PropertyDuration(d) => {
                if d.is_finite() && d > 0.0 {
                    self.state.duration_secs = Some(d);
                    self.touch_state();
                }
            }
            EngineEvent::PropertyPaused(paused) => {
                self.engine_paused = paused;
                match self.state.status {
                    PlaybackStatus::Loading | PlaybackStatus::Buffering => {
                        // Wait for FileLoaded / buffering end to settle status.
                    }
                    _ => {
                        self.state.status = if paused {
                            PlaybackStatus::Paused
                        } else {
                            PlaybackStatus::Playing
                        };
                        self.touch_state();
                        self.publish_position(true);
                    }
                }
            }
            EngineEvent::PropertySeeking(_) => {
                self.publish_position(true);
            }
            EngineEvent::PropertyBuffering(pct) => {
                if self.state.status == PlaybackStatus::Loading {
                    // Still loading the initial buffer; keep Loading.
                    self.state.buffering_pct = Some(pct);
                    self.touch_state();
                } else if pct > 0 && pct < 100 {
                    self.state.buffering_pct = Some(pct);
                    if self.state.status == PlaybackStatus::Playing {
                        self.state.status = PlaybackStatus::Buffering;
                    }
                    self.touch_state();
                } else {
                    self.state.buffering_pct = None;
                    if self.state.status == PlaybackStatus::Buffering {
                        self.state.status = PlaybackStatus::Playing;
                    }
                    self.touch_state();
                }
            }
            EngineEvent::PropertyVolume(v) => {
                if (v - self.state.volume).abs() > f64::EPSILON {
                    self.state.volume = v.clamp(0.0, 100.0);
                    self.touch_state();
                }
            }
            EngineEvent::PropertyMuted(m) => {
                if m != self.state.muted {
                    self.state.muted = m;
                    self.touch_state();
                }
            }
            EngineEvent::PropertySpeed(s) => {
                if (s - self.state.speed).abs() > f64::EPSILON {
                    self.state.speed = s;
                    self.touch_state();
                }
            }
            EngineEvent::PropertyEofReached => {
                // Safety net only (spec §3: single primary mechanism).
                if !self.eof_handled && self.state.status != PlaybackStatus::Idle {
                    let step = self.queue.advance(false);
                    out.extend(self.apply_step(step));
                }
            }
            EngineEvent::PropertyIdleActive(active) => {
                // Safety net: engine went idle while we believed something was
                // playing (missed end-file). Never fires after a user Stop
                // (status Idle) — stopping must not advance the queue.
                if active
                    && !self.eof_handled
                    && !self.expecting_stop
                    && self.state.status != PlaybackStatus::Idle
                {
                    let step = self.queue.advance(false);
                    out.extend(self.apply_step(step));
                }
            }
            EngineEvent::EndFile { reason } => match reason {
                EndReason::Eof => {
                    if !self.eof_handled {
                        self.eof_handled = true;
                        let step = self.queue.advance(false);
                        out.extend(self.apply_step(step));
                    }
                }
                EndReason::Stop => {
                    if self.expecting_stop {
                        self.expecting_stop = false;
                    } else if self.state.status == PlaybackStatus::Playing
                        || self.state.status == PlaybackStatus::Buffering
                    {
                        self.set_error("Playback stopped unexpectedly.", &mut out);
                    }
                }
                EndReason::Error => {
                    self.set_error("Couldn't play this track.", &mut out);
                }
                EndReason::Quit | EndReason::Redirect => {
                    // Engine shutting down or redirecting; nothing to do.
                }
            },
            EngineEvent::ProcessExited { detail } => {
                self.set_error(
                    &format!("Playback engine exited unexpectedly. {detail}"),
                    &mut out,
                );
            }
        }
        out
    }

    fn set_error(&mut self, msg: &str, _out: &mut Vec<PlayerCommand>) {
        self.state.status = PlaybackStatus::Error;
        self.state.error = Some(msg.to_string());
        // Latch EOF so the idle/eof signals that inevitably follow a failed
        // load don't silently advance the queue past the error (spec §29:
        // failures are surfaced, not skipped).
        self.eof_handled = true;
        self.touch_state();
    }

    // ------------------------------------------------------------------
    // Internal helpers
    // ------------------------------------------------------------------

    /// Translate a queue decision into engine commands + state updates.
    fn apply_step(&mut self, step: QueueStep) -> Vec<PlayerCommand> {
        let mut out = Vec::new();
        match step {
            QueueStep::None => {}
            QueueStep::Load(id) => {
                if let Some(item) = self.queue.item_by_id(&id) {
                    let track = item.track.clone();
                    self.load_track(track, None, false, &mut out);
                    self.touch_state();
                }
            }
            QueueStep::ReplayCurrent => {
                if let Some(item) = self.queue.current() {
                    let track = item.track.clone();
                    self.load_track(track, Some(0.0), false, &mut out);
                    self.touch_state();
                }
            }
            QueueStep::SeekStart => {
                self.seek_absolute(0.0, &mut out);
            }
            QueueStep::EndOfQueue => {
                self.expecting_stop = true;
                self.state.status = PlaybackStatus::Idle;
                self.state.position_secs = 0.0;
                self.state.buffering_pct = None;
                self.touch_state();
                self.publish_position(true);
                out.push(PlayerCommand::Stop);
            }
        }
        out
    }

    fn load_track(
        &mut self,
        track: Track,
        start_at: Option<f64>,
        start_paused: bool,
        out: &mut Vec<PlayerCommand>,
    ) {
        self.state.current_item_id = self.queue.current().map(|i| i.id.clone());
        self.state.current_track = Some(track.clone());
        self.state.status = PlaybackStatus::Loading;
        self.state.position_secs = start_at.unwrap_or(0.0);
        self.state.duration_secs = track.duration_secs;
        self.state.error = None;
        self.state.buffering_pct = None;
        self.eof_handled = false;
        self.expecting_stop = true; // loadfile replace ends the previous file
        self.resume_at = None;
        self.publish_position(true);
        self.touch_state();
        out.push(PlayerCommand::LoadTrack {
            track,
            start_paused,
            start_at,
        });
    }

    fn set_paused(&mut self, want_paused: bool) -> Vec<PlayerCommand> {
        let mut out = Vec::new();
        match self.state.status {
            PlaybackStatus::Idle | PlaybackStatus::Error => {
                // Nothing loaded: (re)start the current track, or the queue.
                if self.queue.current().is_some() || !self.queue.is_empty() {
                    let step = if self.queue.current().is_some() {
                        QueueStep::Load(self.queue.current().unwrap().id.clone())
                    } else {
                        self.queue.advance(true)
                    };
                    let start_at = self.resume_at.take();
                    if let QueueStep::Load(id) = &step {
                        if let Some(item) = self.queue.item_by_id(id) {
                            let track = item.track.clone();
                            self.load_track(track, start_at, want_paused, &mut out);
                        }
                    }
                    self.touch_state();
                }
            }
            PlaybackStatus::Loading | PlaybackStatus::Playing | PlaybackStatus::Paused
            | PlaybackStatus::Buffering => {
                self.state.status = if want_paused {
                    PlaybackStatus::Paused
                } else {
                    PlaybackStatus::Playing
                };
                self.touch_state();
                self.publish_position(true);
                out.push(PlayerCommand::SetPaused(want_paused));
            }
        }
        out
    }

    fn seek_absolute(&mut self, position: f64, out: &mut Vec<PlayerCommand>) {
        if self.state.status == PlaybackStatus::Idle || self.state.current_track.is_none() {
            return; // nothing loaded; seeking is meaningless
        }
        let clamped = match self.state.duration_secs {
            Some(d) if d > 0.5 => position.clamp(0.0, d - 0.25),
            _ => position.max(0.0),
        };
        self.state.position_secs = clamped;
        self.publish_position(true);
        self.touch_state();
        out.push(PlayerCommand::SeekAbsolute(clamped));
    }

    // ------------------------------------------------------------------
    // Session integration
    // ------------------------------------------------------------------

    /// Adopt a restored queue + settings without starting playback
    /// (spec §31: never autoplay on launch unless the user opted in).
    pub fn restore_queue(&mut self, queue: QueueMachine) {
        self.queue = queue;
        let current = self.queue.current().cloned();
        self.state.current_item_id = current.as_ref().map(|i| i.id.clone());
        self.state.current_track = current.map(|i| i.track);
        self.state.status = PlaybackStatus::Idle;
        self.state.error = None;
        self.resume_at = Some(self.state.position_secs);
        self.touch_queue();
        self.touch_state();
    }

    pub fn set_restored_audio(&mut self, volume: f64, muted: bool, speed: f64, position: f64) {
        self.state.volume = volume.clamp(0.0, 100.0);
        self.state.muted = muted;
        self.state.speed = speed.clamp(0.25, 4.0);
        self.state.position_secs = position.max(0.0);
        self.resume_at = Some(self.state.position_secs);
        self.touch_state();
        self.publish_position(true);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{ArtistRef, Track};
    use crate::domain::TrackSource;
    use crate::player::PlayerCommand::*;

    fn track(n: u32) -> Track {
        Track {
            id: format!("t:{n}"),
            source: TrackSource::YouTube,
            source_id: format!("v{n}"),
            title: format!("Track {n}"),
            artists: vec![ArtistRef { id: "a:1".into(), name: "Artist".into() }],
            album: None,
            duration_secs: Some(200.0),
            artwork: None,
            is_local: false,
            metadata: Default::default(),
        }
    }

    fn core() -> PlaybackCore {
        PlaybackCore::new(42)
    }

    /// Simulate the engine's response to a LoadTrack command.
    fn engine_loaded(core: &mut PlaybackCore) -> Vec<PlayerCommand> {
        let mut out = core.handle_engine(EngineEvent::FileLoaded);
        out.extend(core.handle_engine(EngineEvent::PropertyDuration(200.0)));
        out.extend(core.handle_engine(EngineEvent::PropertyTimePos(0.0)));
        out
    }

    fn loaded_url(cmds: &[PlayerCommand]) -> String {
        cmds.iter()
            .find_map(|c| match c {
                LoadTrack { track, .. } => Some(track.source_id.clone()),
                _ => None,
            })
            .unwrap_or_default()
    }

    #[test]
    fn play_track_loads_and_transitions_to_playing() {
        let mut c = core();
        let cmds = c.handle_user(UserCommand::PlayTrack { track: track(1) });
        assert_eq!(loaded_url(&cmds), "v1");
        assert_eq!(c.state().status, PlaybackStatus::Loading);
        engine_loaded(&mut c);
        assert_eq!(c.state().status, PlaybackStatus::Playing);
        assert_eq!(c.state().current_track.as_ref().unwrap().title, "Track 1");
        assert!(c.drain_state_dirty());
    }

    #[test]
    fn eof_auto_next_loads_second_track() {
        let mut c = core();
        c.handle_user(UserCommand::StartSequence {
            tracks: vec![track(1), track(2)],
            shuffle: false,
        });
        engine_loaded(&mut c);
        // Song A ends.
        let cmds = c.handle_engine(EngineEvent::EndFile { reason: EndReason::Eof });
        assert_eq!(loaded_url(&cmds), "v2");
        assert_eq!(c.state().status, PlaybackStatus::Loading);
        engine_loaded(&mut c);
        assert_eq!(c.state().current_track.as_ref().unwrap().title, "Track 2");
        c.queue().assert_invariants().unwrap();
    }

    #[test]
    fn duplicate_eof_signals_never_double_advance() {
        let mut c = core();
        c.handle_user(UserCommand::StartSequence {
            tracks: vec![track(1), track(2), track(3)],
            shuffle: false,
        });
        engine_loaded(&mut c);
        let a = c.handle_engine(EngineEvent::EndFile { reason: EndReason::Eof });
        let b = c.handle_engine(EngineEvent::PropertyEofReached);
        let d = c.handle_engine(EngineEvent::PropertyIdleActive(true));
        assert_eq!(loaded_url(&a), "v2");
        assert!(b.is_empty());
        assert!(d.is_empty());
        assert_eq!(c.state().current_track.as_ref().unwrap().title, "Track 2");
    }

    #[test]
    fn eof_at_end_with_repeat_off_stops_idle() {
        let mut c = core();
        c.handle_user(UserCommand::StartSequence {
            tracks: vec![track(1), track(2)],
            shuffle: false,
        });
        engine_loaded(&mut c);
        c.handle_engine(EngineEvent::EndFile { reason: EndReason::Eof });
        engine_loaded(&mut c);
        let cmds = c.handle_engine(EngineEvent::EndFile { reason: EndReason::Eof });
        assert!(cmds.iter().any(|cmd| matches!(cmd, PlayerCommand::Stop)));
        assert_eq!(c.state().status, PlaybackStatus::Idle);
        // Current track remains visible after the queue ran dry.
        assert_eq!(c.state().current_track.as_ref().unwrap().title, "Track 2");
    }

    #[test]
    fn repeat_one_replays_on_eof_but_next_advances() {
        let mut c = core();
        c.handle_user(UserCommand::StartSequence {
            tracks: vec![track(1), track(2)],
            shuffle: false,
        });
        c.handle_user(UserCommand::SetRepeat { mode: RepeatMode::One });
        engine_loaded(&mut c);
        let cmds = c.handle_engine(EngineEvent::EndFile { reason: EndReason::Eof });
        assert!(matches!(
            cmds.as_slice(),
            [LoadTrack { start_at: Some(0.0), .. }]
        ));
        assert_eq!(loaded_url(&cmds), "v1");
        engine_loaded(&mut c);
        let cmds = c.handle_user(UserCommand::Next);
        assert_eq!(loaded_url(&cmds), "v2");
    }

    #[test]
    fn pause_resume_roundtrip() {
        let mut c = core();
        c.handle_user(UserCommand::PlayTrack { track: track(1) });
        engine_loaded(&mut c);
        let cmds = c.handle_user(UserCommand::Pause);
        assert!(cmds.iter().any(|cmd| matches!(cmd, SetPaused(true))));
        assert_eq!(c.state().status, PlaybackStatus::Paused);
        let cmds = c.handle_user(UserCommand::Play);
        assert!(cmds.iter().any(|cmd| matches!(cmd, SetPaused(false))));
        assert_eq!(c.state().status, PlaybackStatus::Playing);
    }

    #[test]
    fn seek_clamps_to_duration() {
        let mut c = core();
        c.handle_user(UserCommand::PlayTrack { track: track(1) });
        engine_loaded(&mut c);
        let cmds = c.handle_user(UserCommand::SeekTo { position: 999.0 });
        assert!(matches!(cmds.as_slice(), [SeekAbsolute(p)] if (*p - 199.75).abs() < 0.01));
        assert!((c.state().position_secs - 199.75).abs() < 0.01);
        let cmds = c.handle_user(UserCommand::SeekBy { delta: -10.0 });
        assert!(matches!(cmds.as_slice(), [SeekAbsolute(p)] if (*p - 189.75).abs() < 0.01));
    }

    #[test]
    fn previous_restarts_fresh_tracks_then_walks_history() {
        let mut c = core();
        c.handle_user(UserCommand::StartSequence {
            tracks: vec![track(1), track(2)],
            shuffle: false,
        });
        engine_loaded(&mut c);
        c.handle_user(UserCommand::Next);
        engine_loaded(&mut c);
        // >3s in: previous restarts Track 2.
        c.handle_engine(EngineEvent::PropertyTimePos(12.0));
        let cmds = c.handle_user(UserCommand::Previous);
        assert!(matches!(cmds.as_slice(), [SeekAbsolute(0.0)]));
        // Early in track: previous walks history.
        let cmds = c.handle_user(UserCommand::Previous);
        assert_eq!(loaded_url(&cmds), "v1");
    }

    #[test]
    fn remove_current_mid_play_loads_next() {
        let mut c = core();
        c.handle_user(UserCommand::StartSequence {
            tracks: vec![track(1), track(2), track(3)],
            shuffle: false,
        });
        engine_loaded(&mut c);
        let id = c.state().current_item_id.clone().unwrap();
        let cmds = c.handle_user(UserCommand::RemoveQueueItem { item_id: id });
        assert_eq!(loaded_url(&cmds), "v2");
        engine_loaded(&mut c);
        assert_eq!(c.state().current_track.as_ref().unwrap().title, "Track 2");
    }

    #[test]
    fn queue_mutation_during_playback_keeps_next_correct() {
        let mut c = core();
        c.handle_user(UserCommand::StartSequence {
            tracks: vec![track(1), track(2), track(3)],
            shuffle: false,
        });
        engine_loaded(&mut c);
        c.handle_user(UserCommand::PlayNext { tracks: vec![track(9)] });
        let cmds = c.handle_engine(EngineEvent::EndFile { reason: EndReason::Eof });
        assert_eq!(loaded_url(&cmds), "v9");
        engine_loaded(&mut c);
        let cmds = c.handle_engine(EngineEvent::EndFile { reason: EndReason::Eof });
        assert_eq!(loaded_url(&cmds), "v2");
        c.queue().assert_invariants().unwrap();
    }

    #[test]
    fn shuffle_toggle_mid_play_does_not_restart_current() {
        let mut c = core();
        c.handle_user(UserCommand::StartSequence {
            tracks: (1..=6).map(track).collect(),
            shuffle: false,
        });
        engine_loaded(&mut c);
        let before = c.state().current_track.clone().unwrap();
        let cmds = c.handle_user(UserCommand::SetShuffle { enabled: true });
        assert!(cmds.is_empty());
        assert_eq!(c.state().current_track.as_ref().unwrap(), &before);
        assert_eq!(c.state().status, PlaybackStatus::Playing);
        // EOF still advances deterministically.
        let cmds = c.handle_engine(EngineEvent::EndFile { reason: EndReason::Eof });
        assert_eq!(loaded_url(&cmds).is_empty(), false);
        c.queue().assert_invariants().unwrap();
    }

    #[test]
    fn error_state_then_manual_next_recovers() {
        let mut c = core();
        c.handle_user(UserCommand::StartSequence {
            tracks: vec![track(1), track(2)],
            shuffle: false,
        });
        engine_loaded(&mut c);
        c.handle_engine(EngineEvent::EndFile { reason: EndReason::Error });
        assert_eq!(c.state().status, PlaybackStatus::Error);
        assert!(c.state().error.is_some());
        let cmds = c.handle_user(UserCommand::Next);
        assert_eq!(loaded_url(&cmds), "v2");
        engine_loaded(&mut c);
        assert_eq!(c.state().status, PlaybackStatus::Playing);
        assert!(c.state().error.is_none());
    }

    #[test]
    fn buffering_transitions_and_recovers() {
        let mut c = core();
        c.handle_user(UserCommand::PlayTrack { track: track(1) });
        engine_loaded(&mut c);
        c.handle_engine(EngineEvent::PropertyBuffering(35));
        assert_eq!(c.state().status, PlaybackStatus::Buffering);
        assert_eq!(c.state().buffering_pct, Some(35));
        c.handle_engine(EngineEvent::PropertyBuffering(100));
        assert_eq!(c.state().status, PlaybackStatus::Playing);
        assert_eq!(c.state().buffering_pct, None);
    }

    #[test]
    fn volume_mute_speed_are_clamped_and_applied() {
        let mut c = core();
        let cmds = c.handle_user(UserCommand::SetVolume { volume: 130.0 });
        assert!(matches!(cmds.as_slice(), [SetVolume(100.0)]));
        assert_eq!(c.state().volume, 100.0);
        let cmds = c.handle_user(UserCommand::ToggleMute);
        assert!(matches!(cmds.as_slice(), [SetMuted(true)]));
        assert!(c.state().muted);
        let cmds = c.handle_user(UserCommand::SetSpeed { speed: 9.0 });
        assert!(matches!(cmds.as_slice(), [SetSpeed(4.0)]));
        assert_eq!(c.state().speed, 4.0);
    }

    #[test]
    fn position_updates_are_throttled_and_forced_on_seeks() {
        let mut c = core();
        c.handle_user(UserCommand::PlayTrack { track: track(1) });
        engine_loaded(&mut c);
        assert!(c.take_position_update().is_some()); // forced on load
        c.handle_engine(EngineEvent::PropertyTimePos(0.05));
        assert!(c.take_position_update().is_none()); // below threshold
        c.handle_engine(EngineEvent::PropertyTimePos(0.25));
        let u = c.take_position_update().unwrap();
        assert_eq!(u.position_secs, 0.25);
        c.handle_engine(EngineEvent::PropertyTimePos(42.0));
        c.handle_user(UserCommand::Pause);
        let u = c.take_position_update().unwrap(); // forced on pause
        assert_eq!(u.position_secs, 42.0);
    }

    #[test]
    fn session_restore_does_not_autoplay_and_play_resumes_position() {
        let mut c = core();
        c.handle_user(UserCommand::StartSequence {
            tracks: vec![track(1), track(2)],
            shuffle: false,
        });
        engine_loaded(&mut c);
        // Simulate crash at 90s; restore from serialized queue.
        let serialized = serde_json::to_string(c.queue()).unwrap();
        let restored_queue: QueueMachine = serde_json::from_str(&serialized).unwrap();
        let mut c2 = core();
        c2.restore_queue(restored_queue);
        c2.set_restored_audio(55.0, false, 1.0, 90.0);
        assert_eq!(c2.state().status, PlaybackStatus::Idle);
        let cmds = c2.handle_user(UserCommand::Play);
        assert!(matches!(
            cmds.as_slice(),
            [LoadTrack { start_at: Some(90.0), .. }]
        ));
    }

    #[test]
    fn clear_queue_stops_and_empties_state() {
        let mut c = core();
        c.handle_user(UserCommand::StartSequence {
            tracks: vec![track(1), track(2)],
            shuffle: false,
        });
        engine_loaded(&mut c);
        let cmds = c.handle_user(UserCommand::ClearQueue);
        assert!(cmds.iter().any(|cmd| matches!(cmd, PlayerCommand::Stop)));
        assert_eq!(c.state().status, PlaybackStatus::Idle);
        assert!(c.state().current_track.is_none());
        assert!(c.queue().is_empty());
    }

    #[test]
    fn play_with_empty_queue_is_noop() {
        let mut c = core();
        let cmds = c.handle_user(UserCommand::TogglePlay);
        assert!(cmds.is_empty());
        assert_eq!(c.state().status, PlaybackStatus::Idle);
    }

    #[test]
    fn engine_death_sets_error_state() {
        let mut c = core();
        c.handle_user(UserCommand::PlayTrack { track: track(1) });
        engine_loaded(&mut c);
        c.handle_engine(EngineEvent::ProcessExited { detail: "mpv gone".into() });
        assert_eq!(c.state().status, PlaybackStatus::Error);
        assert!(c.state().error.is_some());
    }

    #[test]
    fn user_stop_then_engine_idle_does_not_advance_queue() {
        let mut c = core();
        c.handle_user(UserCommand::StartSequence {
            tracks: vec![track(1), track(2)],
            shuffle: false,
        });
        engine_loaded(&mut c);
        c.handle_user(UserCommand::Stop);
        // mpv will report end-file(stop) + idle-active — neither may advance.
        let a = c.handle_engine(EngineEvent::EndFile { reason: EndReason::Stop });
        let b = c.handle_engine(EngineEvent::PropertyIdleActive(true));
        assert!(a.is_empty());
        assert!(b.is_empty());
        assert_eq!(c.state().status, PlaybackStatus::Idle);
        // The stopped track stays visible; pressing play resumes it.
        assert_eq!(c.state().current_track.as_ref().unwrap().title, "Track 1");
        let cmds = c.handle_user(UserCommand::Play);
        assert_eq!(loaded_url(&cmds), "v1");
    }

    #[test]
    fn jump_to_queue_item_loads_it() {
        let mut c = core();
        c.handle_user(UserCommand::StartSequence {
            tracks: vec![track(1), track(2), track(3)],
            shuffle: false,
        });
        engine_loaded(&mut c);
        let view = c.queue().view();
        let target = view.upcoming[1].id.clone();
        let cmds = c.handle_user(UserCommand::JumpToQueueItem { item_id: target });
        assert_eq!(loaded_url(&cmds), "v3");
    }

    #[test]
    fn rapid_next_previous_burst_keeps_state_consistent() {
        let mut c = core();
        c.handle_user(UserCommand::StartSequence {
            tracks: (1..=5).map(track).collect(),
            shuffle: false,
        });
        engine_loaded(&mut c);
        // Next, Next, Previous, Next — only the last LoadTrack matters and
        // the queue cursor must match the current track.
        c.handle_user(UserCommand::Next);
        c.handle_user(UserCommand::Next);
        c.handle_user(UserCommand::Previous);
        let cmds = c.handle_user(UserCommand::Next);
        assert_eq!(loaded_url(&cmds), "v3");
        engine_loaded(&mut c);
        assert_eq!(c.state().current_track.as_ref().unwrap().title, "Track 3");
        c.queue().assert_invariants().unwrap();
        let view = c.queue().view();
        assert_eq!(view.current.as_ref().unwrap().track.title, "Track 3");
    }

    #[test]
    fn track_replacement_while_playing_does_not_error() {
        let mut c = core();
        c.handle_user(UserCommand::StartSequence {
            tracks: vec![track(1), track(2)],
            shuffle: false,
        });
        engine_loaded(&mut c);
        let cmds = c.handle_user(UserCommand::PlayTrack { track: track(9) });
        assert_eq!(loaded_url(&cmds), "v9");
        // mpv ends the replaced file with end-file(stop) — expected, no error.
        let a = c.handle_engine(EngineEvent::EndFile { reason: EndReason::Stop });
        assert!(a.is_empty());
        assert_eq!(c.state().status, PlaybackStatus::Loading);
        assert!(c.state().error.is_none());
        engine_loaded(&mut c);
        assert_eq!(c.state().status, PlaybackStatus::Playing);
        assert_eq!(c.state().current_track.as_ref().unwrap().title, "Track 9");
    }

    #[test]
    fn pause_during_loading_is_remembered_and_not_lost() {
        let mut c = core();
        c.handle_user(UserCommand::PlayTrack { track: track(1) });
        // User pauses while the engine is still loading the file.
        c.handle_user(UserCommand::Pause);
        assert_eq!(c.state().status, PlaybackStatus::Loading);
        // Engine confirms the pause property, then the file finishes loading.
        c.handle_engine(EngineEvent::PropertyPaused(true));
        c.handle_engine(EngineEvent::FileLoaded);
        assert_eq!(c.state().status, PlaybackStatus::Paused);
        let cmds = c.handle_user(UserCommand::Play);
        assert!(cmds.iter().any(|cmd| matches!(cmd, SetPaused(false))));
        assert_eq!(c.state().status, PlaybackStatus::Playing);
    }

    #[test]
    fn engine_restart_recovers_position_and_resumes() {
        let mut c = core();
        c.handle_user(UserCommand::StartSequence {
            tracks: vec![track(1), track(2)],
            shuffle: false,
        });
        engine_loaded(&mut c);
        c.handle_engine(EngineEvent::PropertyTimePos(90.0));
        // mpv dies mid-playback.
        c.handle_engine(EngineEvent::ProcessExited { detail: "crash".into() });
        assert_eq!(c.state().status, PlaybackStatus::Error);
        // Supervisor restarts the engine and parks the track at 90s.
        c.handle_user(UserCommand::LoadPausedAt { position: 90.0 });
        assert_eq!(c.state().status, PlaybackStatus::Idle);
        let cmds = c.handle_user(UserCommand::Play);
        assert!(matches!(
            cmds.as_slice(),
            [LoadTrack { start_at: Some(90.0), .. }]
        ));
        engine_loaded(&mut c);
        c.handle_engine(EngineEvent::PropertyTimePos(90.0));
        assert_eq!(c.state().status, PlaybackStatus::Playing);
        assert!((c.state().position_secs - 90.0).abs() < 1e-9);
    }

    #[test]
    fn seek_during_loading_is_ignored_not_crashed() {
        let mut c = core();
        c.handle_user(UserCommand::PlayTrack { track: track(1) });
        // Engine events race: a duration arrives before the file is loaded.
        c.handle_engine(EngineEvent::PropertyDuration(200.0));
        let cmds = c.handle_user(UserCommand::SeekTo { position: 50.0 });
        // Track is loading (status Loading but track known): the seek is
        // forwarded to the engine which queues it after load.
        assert!(cmds.iter().any(|cmd| matches!(cmd, SeekAbsolute(50.0))));
        engine_loaded(&mut c);
        assert_eq!(c.state().status, PlaybackStatus::Playing);
    }
}
