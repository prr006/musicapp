//! Tauri event names + payload types (the other half of the IPC contract,
//! see docs/IPC.md).

use melo_core::playback::{PlaybackSnapshot, PositionUpdate};
use melo_core::queue::QueueView;

pub const PLAYBACK_STATE: &str = "playback://state";
pub const PLAYBACK_POSITION: &str = "playback://position";
pub const QUEUE_VIEW: &str = "queue://view";
pub const ENGINE_STATUS: &str = "engine://status";

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    pub health: melo_core::player::EngineHealth,
    pub message: String,
}
