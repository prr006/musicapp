//! mpv engine module: JSON IPC protocol, process transport, supervision.

pub mod ipc;
pub mod process;

pub use ipc::MpvCommand;
pub use process::{endpoint_for, start, RunningEngine};
