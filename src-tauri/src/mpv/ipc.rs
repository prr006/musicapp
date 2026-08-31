//! mpv JSON IPC protocol: encoding commands, decoding events.
//!
//! mpv speaks newline-delimited JSON over a Unix socket (`--input-ipc-server`)
//! or, on Windows, a named pipe (`\\.\pipe\melo-mpv-<pid>`).
//!
//! Reference: <https://mpv.io/manual/master/#json-ipc>

use melo_core::player::{EndReason, EngineEvent};
use serde_json::{json, Value};

/// Engine-level commands (already URL-resolved; distinct from the semantic
/// `PlayerCommand` the state machine emits).
#[derive(Debug, Clone, PartialEq)]
pub enum MpvCommand {
    /// `loadfile <url> replace`. Loading always normalizes the pause state
    /// first (`set_property pause <start_paused>`) — the guaranteed-safe way
    /// to start paused or unpaused across mpv versions. Start positions are
    /// applied by the service as a seek right after `file-loaded`.
    LoadUrl { url: String, start_paused: bool },
    SetPaused(bool),
    SeekAbsolute(f64),
    SeekRelative(f64),
    Stop,
    SetVolume(f64),
    SetMuted(bool),
    SetSpeed(f64),
}

/// Serialize a command as the wire lines to write. `LoadUrl` expands into
/// two lines (pause state + loadfile); everything else is one line.
/// `next_request_id` allocates ids for each line.
pub fn encode_command_seq(cmd: &MpvCommand, next_request_id: &mut impl FnMut() -> u64) -> Vec<String> {
    match cmd {
        MpvCommand::LoadUrl { url, start_paused } => {
            vec![
                json!({
                    "command": ["set_property", "pause", start_paused],
                    "request_id": next_request_id(),
                })
                .to_string(),
                json!({
                    "command": ["loadfile", url, "replace"],
                    "request_id": next_request_id(),
                })
                .to_string(),
            ]
        }
        other => vec![encode_command(other, next_request_id())],
    }
}

/// Serialize a single (non-load) command.
pub fn encode_command(cmd: &MpvCommand, request_id: u64) -> String {
    let command: Value = match cmd {
        MpvCommand::LoadUrl { url, start_paused } => {
            json!({ "command": ["loadfile", url, "replace", { "pause": start_paused }] })
        }
        MpvCommand::SetPaused(p) => json!({ "command": ["set_property", "pause", p] }),
        MpvCommand::SeekAbsolute(t) => json!({ "command": ["seek", t, "absolute"] }),
        MpvCommand::SeekRelative(d) => json!({ "command": ["seek", d, "relative"] }),
        MpvCommand::Stop => json!({ "command": ["stop"] }),
        MpvCommand::SetVolume(v) => json!({ "command": ["set_property", "volume", v] }),
        MpvCommand::SetMuted(m) => json!({ "command": ["set_property", "mute", m] }),
        MpvCommand::SetSpeed(s) => json!({ "command": ["set_property", "speed", s] }),
    };
    let mut obj = command;
    obj["request_id"] = json!(request_id);
    obj.to_string()
}

/// `observe_property` registrations: id → property name.
/// The ids are protocol-level only; events are matched by property name.
pub const OBSERVED_PROPERTIES: &[(&str, u64)] = &[
    ("time-pos", 1),
    ("duration", 2),
    ("pause", 3),
    ("eof-reached", 4),
    ("seeking", 5),
    ("buffering-state", 6),
    ("volume", 7),
    ("mute", 8),
    ("speed", 9),
    ("idle-active", 10),
];

pub fn encode_observe_all(request_id: u64) -> Vec<String> {
    OBSERVED_PROPERTIES
        .iter()
        .map(|(name, id)| {
            json!({
                "command": ["observe_property", id, name],
                "request_id": request_id,
            })
            .to_string()
        })
        .collect()
}

/// Decode one line from mpv into an engine event. `Ok(None)` = ignored line
/// (async reply, unknown event, keepalive...).
pub fn decode_line(line: &str) -> Option<EngineEvent> {
    let v: Value = serde_json::from_str(line.trim()).ok()?;
    let event = v.get("event")?.as_str()?;
    match event {
        "file-loaded" => Some(EngineEvent::FileLoaded),
        "end-file" => {
            let reason = v
                .get("reason")
                .and_then(|r| r.as_str())
                .map(parse_end_reason)
                .unwrap_or(EndReason::Stop);
            Some(EngineEvent::EndFile { reason })
        }
        "property-change" => {
            let name = v.get("name")?.as_str()?.to_string();
            let data = v.get("data").cloned();
            decode_property(&name, data)
        }
        _ => None,
    }
}

fn decode_property(name: &str, data: Option<Value>) -> Option<EngineEvent> {
    let num = || data.as_ref().and_then(|d| d.as_f64());
    match name {
        "time-pos" => num().map(EngineEvent::PropertyTimePos),
        "duration" => num().filter(|d| *d > 0.0).map(EngineEvent::PropertyDuration),
        "pause" => data.as_ref().and_then(|d| d.as_bool()).map(EngineEvent::PropertyPaused),
        "eof-reached" => data
            .as_ref()
            .and_then(|d| d.as_bool())
            .filter(|b| *b)
            .map(|_| EngineEvent::PropertyEofReached),
        "seeking" => data
            .as_ref()
            .and_then(|d| d.as_bool())
            .map(EngineEvent::PropertySeeking),
        "buffering-state" => num().map(|n| EngineEvent::PropertyBuffering(n.clamp(0.0, 100.0) as u8)),
        "volume" => num().map(EngineEvent::PropertyVolume),
        "mute" => data.as_ref().and_then(|d| d.as_bool()).map(EngineEvent::PropertyMuted),
        "speed" => num().map(EngineEvent::PropertySpeed),
        "idle-active" => data
            .as_ref()
            .and_then(|d| d.as_bool())
            .map(EngineEvent::PropertyIdleActive),
        _ => None,
    }
}

fn parse_end_reason(reason: &str) -> EndReason {
    match reason {
        "eof" => EndReason::Eof,
        "quit" => EndReason::Quit,
        "error" => EndReason::Error,
        "redirect" => EndReason::Redirect,
        // "stop" and anything unknown
        _ => EndReason::Stop,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_url_expands_to_pause_then_loadfile() {
        let mut ids = 0u64;
        let lines = encode_command_seq(
            &MpvCommand::LoadUrl { url: "http://x/y.opus".into(), start_paused: true },
            &mut || {
                ids += 1;
                ids
            },
        );
        assert_eq!(lines.len(), 2);
        let pause: Value = serde_json::from_str(&lines[0]).unwrap();
        assert_eq!(pause["command"][0], "set_property");
        assert_eq!(pause["command"][1], "pause");
        assert_eq!(pause["command"][2], true);
        let load: Value = serde_json::from_str(&lines[1]).unwrap();
        assert_eq!(load["command"][0], "loadfile");
        assert_eq!(load["command"][1], "http://x/y.opus");
        assert_eq!(load["command"][2], "replace");
        // Distinct request ids.
        assert_ne!(pause["request_id"], load["request_id"]);
    }

    #[test]
    fn unpaused_load_still_normalizes_pause_state() {
        let lines = encode_command_seq(
            &MpvCommand::LoadUrl { url: "http://x".into(), start_paused: false },
            &mut || 1,
        );
        let pause: Value = serde_json::from_str(&lines[0]).unwrap();
        assert_eq!(pause["command"][2], false);
    }

    #[test]
    fn encodes_plain_commands() {
        assert_eq!(
            encode_command(&MpvCommand::SetPaused(true), 2),
            r#"{"command":["set_property","pause",true],"request_id":2}"#
        );
        assert_eq!(
            encode_command(&MpvCommand::SeekAbsolute(12.5), 3),
            r#"{"command":["seek",12.5,"absolute"],"request_id":3}"#
        );
        assert_eq!(
            encode_command(&MpvCommand::SeekRelative(-10.0), 3),
            r#"{"command":["seek",-10.0,"relative"],"request_id":3}"#
        );
        assert_eq!(
            encode_command(&MpvCommand::SetVolume(80.0), 4),
            r#"{"command":["set_property","volume",80.0],"request_id":4}"#
        );
        assert_eq!(
            encode_command(&MpvCommand::Stop, 5),
            r#"{"command":["stop"],"request_id":5}"#
        );
    }

    #[test]
    fn observes_all_properties() {
        let lines = encode_observe_all(99);
        assert_eq!(lines.len(), OBSERVED_PROPERTIES.len());
        let v: Value = serde_json::from_str(&lines[0]).unwrap();
        assert_eq!(v["command"][0], "observe_property");
        assert_eq!(v["command"][1], 1);
        assert_eq!(v["command"][2], "time-pos");
    }

    #[test]
    fn decodes_property_change_events() {
        assert_eq!(
            decode_line(r#"{"event":"property-change","id":1,"name":"time-pos","data":83.42}"#),
            Some(EngineEvent::PropertyTimePos(83.42))
        );
        assert_eq!(
            decode_line(r#"{"event":"property-change","id":3,"name":"pause","data":true}"#),
            Some(EngineEvent::PropertyPaused(true))
        );
        assert_eq!(
            decode_line(r#"{"event":"property-change","id":6,"name":"buffering-state","data":42.0}"#),
            Some(EngineEvent::PropertyBuffering(42))
        );
        // eof-reached false is not an event (we only care about the latch).
        assert_eq!(
            decode_line(r#"{"event":"property-change","id":4,"name":"eof-reached","data":false}"#),
            None
        );
        // time-pos can be null (idle) — ignored.
        assert_eq!(
            decode_line(r#"{"event":"property-change","id":1,"name":"time-pos","data":null}"#),
            None
        );
    }

    #[test]
    fn decodes_lifecycle_events() {
        assert_eq!(decode_line(r#"{"event":"file-loaded"}"#), Some(EngineEvent::FileLoaded));
        assert_eq!(
            decode_line(r#"{"event":"end-file","reason":"eof","playlist_entry_id":5}"#),
            Some(EngineEvent::EndFile { reason: EndReason::Eof })
        );
        assert_eq!(
            decode_line(r#"{"event":"end-file","reason":"stop"}"#),
            Some(EngineEvent::EndFile { reason: EndReason::Stop })
        );
        // Async command replies are ignored.
        assert_eq!(decode_line(r#"{"data":null,"error":"success","request_id":7}"#), None);
        // Unknown events ignored.
        assert_eq!(decode_line(r#"{"event":"log-message","prefix":"cplayer","text":"hi"}"#), None);
    }
}
