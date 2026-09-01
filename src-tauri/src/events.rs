//! Tauri event names + shared payload structs.
//!
//! The engine events are emitted by `crate::libmpv` directly (libmpv is
//! authoritative); `runtime://status` comes from `crate::runtime`.

use serde::Serialize;

pub const PLAYER_STATE: &str = "player://state";
pub const PLAYER_POSITION: &str = "player://position";
pub const PLAYER_END: &str = "player://end";
pub const RUNTIME_STATUS: &str = "runtime://status";
pub const LIBRARY_UPDATED: &str = "library://updated";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    /// installing | ready | error
    pub phase: &'static str,
    pub message: String,
}
