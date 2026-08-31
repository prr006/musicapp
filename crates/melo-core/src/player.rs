//! The player abstraction.
//!
//! MELO does not link its state machine to mpv directly. Instead there is a
//! small *data protocol*:
//!
//! ```text
//!   PlayerCommand   (state machine → engine)   "make sound happen"
//!   EngineEvent     (engine → state machine)   "this is what actually happened"
//! ```
//!
//! `melo-core` defines and consumes the protocol; `melo-app` implements it on
//! top of mpv's JSON IPC. A different engine (test double, GStreamer, ...) can
//! implement the same protocol without touching state logic.
//!
//! There is exactly ONE authoritative playback clock: the engine reports
//! positions, the state machine records them, the UI renders them. Nothing
//! else may invent a position.

use serde::{Deserialize, Serialize};

/// Why the engine finished a file (mpv `end-file` reasons, normalized).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EndReason {
    /// Track played to completion → the queue advances (auto-next).
    Eof,
    /// Playback of the file was aborted (loadfile replace, stop, skip).
    Stop,
    /// Engine error while playing/loading.
    Error,
    /// Engine is shutting down.
    Quit,
    /// Playlist redirection happened.
    Redirect,
}

/// What the state machine asks the engine to do. Pure data — easily logged,
/// replayed, and asserted on in tests.
///
/// Note `LoadTrack` is *semantic*: the host (melo-app) resolves the track to
/// a playable URL (yt-dlp / local file / direct stream) before handing it to
/// the engine. The core never sees URLs, so it is 100% source-agnostic.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlayerCommand {
    /// Load `track` replacing whatever plays. `start_paused` is used on session
    /// restore. `start_at` seeks as soon as the file is loaded.
    LoadTrack {
        track: crate::domain::Track,
        #[serde(default)]
        start_paused: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        start_at: Option<f64>,
    },
    /// `true` = pause, `false` = resume.
    SetPaused(bool),
    SeekAbsolute(f64),
    SeekRelative(f64),
    /// Hard stop; engine returns to idle.
    Stop,
    /// 0.0 – 100.0.
    SetVolume(f64),
    SetMuted(bool),
    /// Playback rate, 0.25 – 4.0 typical.
    SetSpeed(f64),
}

/// Events the engine reports back. `Property*` variants mirror observed mpv
/// properties; the state machine treats them as ground truth.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EngineEvent {
    /// A freshly loaded file is ready and (unless told otherwise) playing.
    FileLoaded,
    /// File ended. `Eof` is THE auto-next signal (spec §3).
    EndFile { reason: EndReason },
    PropertyTimePos(f64),
    PropertyDuration(f64),
    PropertyPaused(bool),
    /// `eof-reached` observed true — safety net only (deduped by the SM).
    PropertyEofReached,
    PropertySeeking(bool),
    /// Buffer fill percentage 0–100 while streaming.
    PropertyBuffering(u8),
    PropertyVolume(f64),
    PropertyMuted(bool),
    PropertySpeed(f64),
    /// Engine went idle (no file). Only unexpected when mid-track.
    PropertyIdleActive(bool),
    /// Engine process died; message is for logs, not users.
    ProcessExited { detail: String },
}

/// How healthy the engine process is (surfaced for UI toasts / diagnostics).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EngineHealth {
    Starting,
    Running,
    Restarting,
    Dead,
}

impl EngineEvent {
    /// Human-facing description, used in logs.
    pub fn describe(&self) -> String {
        match self {
            EngineEvent::FileLoaded => "file loaded".into(),
            EngineEvent::EndFile { reason } => format!("end-file ({reason:?})"),
            EngineEvent::PropertyTimePos(p) => format!("time-pos {p:.2}"),
            EngineEvent::PropertyDuration(d) => format!("duration {d:.2}"),
            EngineEvent::PropertyPaused(b) => format!("pause {b}"),
            EngineEvent::PropertyEofReached => "eof-reached".into(),
            EngineEvent::PropertySeeking(b) => format!("seeking {b}"),
            EngineEvent::PropertyBuffering(p) => format!("buffering {p}%"),
            EngineEvent::PropertyVolume(v) => format!("volume {v}"),
            EngineEvent::PropertyMuted(b) => format!("mute {b}"),
            EngineEvent::PropertySpeed(s) => format!("speed {s}"),
            EngineEvent::PropertyIdleActive(b) => format!("idle-active {b}"),
            EngineEvent::ProcessExited { detail } => format!("engine exited: {detail}"),
        }
    }
}
