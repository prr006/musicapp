//! mpv process + IPC transport.
//!
//! MELO runs mpv as a child process in `--idle` mode and speaks its JSON IPC
//! over a Unix socket / Windows named pipe. Process+IPC (rather than libmpv
//! linking) keeps the build dependency-free on every platform and isolates
//! engine crashes from the UI process.
//!
//! Threads (all daemon; die with the channel/process):
//! * *reader* — decodes IPC lines → `EngineEvent`s into the service loop.
//! * *writer* — drains `MpvCommand`s, serializes, writes (one line each).

use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use melo_core::player::EngineEvent;

use super::ipc::{self, MpvCommand};

/// Cross-platform duplex stream over the mpv IPC endpoint.
pub enum DuplexStream {
    #[cfg(unix)]
    Unix(std::os::unix::net::UnixStream),
    #[cfg(windows)]
    Named(std::fs::File),
}

impl Read for DuplexStream {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        match self {
            #[cfg(unix)]
            DuplexStream::Unix(s) => s.read(buf),
            #[cfg(windows)]
            DuplexStream::Named(f) => f.read(buf),
        }
    }
}

impl Write for DuplexStream {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        match self {
            #[cfg(unix)]
            DuplexStream::Unix(s) => s.write(buf),
            #[cfg(windows)]
            DuplexStream::Named(f) => f.write(buf),
        }
    }
    fn flush(&mut self) -> std::io::Result<()> {
        match self {
            #[cfg(unix)]
            DuplexStream::Unix(s) => s.flush(),
            #[cfg(windows)]
            DuplexStream::Named(f) => f.flush(),
        }
    }
}

impl DuplexStream {
    fn try_clone(&self) -> std::io::Result<DuplexStream> {
        Ok(match self {
            #[cfg(unix)]
            DuplexStream::Unix(s) => DuplexStream::Unix(s.try_clone()?),
            #[cfg(windows)]
            DuplexStream::Named(f) => DuplexStream::Named(f.try_clone()?),
        })
    }
}

/// How the mpv child is launched and where its IPC endpoint lives.
pub struct MpvEndpoint {
    pub program: String,
    /// Socket path (unix) or pipe name (windows), already platform-shaped.
    pub ipc_endpoint: String,
    /// Explicit yt-dlp binary for mpv's ytdl_hook (Windows-friendly).
    pub ytdl_path: Option<String>,
    #[cfg(unix)]
    socket_path: std::path::PathBuf,
}

pub fn endpoint_for(program: &str, ytdl_path: Option<String>) -> MpvEndpoint {
    #[cfg(unix)]
    {
        let path = std::env::temp_dir().join(format!("melo-mpv-{}.sock", std::process::id()));
        // Remove a stale socket from a previous run so mpv binds fresh.
        let _ = std::fs::remove_file(&path);
        MpvEndpoint {
            program: program.to_string(),
            ipc_endpoint: path.to_string_lossy().into_owned(),
            ytdl_path,
            socket_path: path,
        }
    }
    #[cfg(windows)]
    {
        MpvEndpoint {
            program: program.to_string(),
            ipc_endpoint: format!(r"\\.\pipe\melo-mpv-{}", std::process::id()),
            ytdl_path,
        }
    }
}

/// Spawn the mpv child process.
fn spawn_process(endpoint: &MpvEndpoint) -> Result<Child, String> {
    let mut cmd = Command::new(&endpoint.program);
    cmd.arg("--idle=yes")
        .arg("--no-terminal")
        .arg("--no-video")
        .arg("--audio-display=no")
        .arg("--keep-open=no")
        // Network streams: stall → buffering events instead of hard errors.
        .arg("--cache=yes")
        .arg("--demuxer-max-bytes=64M")
        // yt-dlp: explicit path when we found one (mpv only checks PATH and
        // its own config dir — this makes portable Windows installs work).
        .arg("--ytdl=yes");
    if let Some(ytdl) = &endpoint.ytdl_path {
        cmd.arg(format!("--script-opts=ytdl_hook-ytdl_path={ytdl}"));
    }
    cmd.arg(format!("--input-ipc-server={}", endpoint.ipc_endpoint))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn()
        .map_err(|e| format!("could not start mpv ({}): {e}", endpoint.program))
}

/// Wait for the endpoint to accept connections (mpv creates it asynchronously).
fn connect_with_retry(endpoint: &MpvEndpoint, timeout: Duration) -> Result<DuplexStream, String> {
    let start = Instant::now();
    let mut last_err = String::new();
    while start.elapsed() < timeout {
        #[cfg(unix)]
        {
            match std::os::unix::net::UnixStream::connect(&endpoint.socket_path) {
                Ok(s) => return Ok(DuplexStream::Unix(s)),
                Err(e) => last_err = e.to_string(),
            }
        }
        #[cfg(windows)]
        {
            // OpenOptions on a named pipe path opens a byte-mode duplex
            // handle; ERROR_PIPE_BUSY / NOT_FOUND just retry.
            match std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(&endpoint.ipc_endpoint)
            {
                Ok(f) => return Ok(DuplexStream::Named(f)),
                Err(e) => last_err = e.to_string(),
            }
        }
        std::thread::sleep(Duration::from_millis(60));
    }
    Err(format!("mpv IPC endpoint never appeared ({last_err})"))
}

/// A live engine: send commands via `commands`, events arrive on `events`.
pub struct RunningEngine {
    pub commands: mpsc::Sender<MpvCommand>,
    child: Arc<Mutex<Option<Child>>>,
}

impl RunningEngine {
    /// Politely stop the child (best effort; the supervisor drops it after).
    pub fn shutdown(&self) {
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

/// Start mpv, connect to its IPC endpoint, and spawn the reader/writer
/// threads. `events` receives decoded `EngineEvent`s; when the process dies a
/// final `ProcessExited` is delivered and the threads unwind.
pub fn start(
    endpoint: &MpvEndpoint,
    events: mpsc::Sender<EngineEvent>,
    initial_volume: f64,
    initial_muted: bool,
) -> Result<RunningEngine, String> {
    // Only moved into `RunningEngine` below; kill/wait go through its
    // Arc<Mutex<Option<Child>>> in shutdown.
    let child = spawn_process(endpoint)?;
    let stream = connect_with_retry(endpoint, Duration::from_secs(10))?;
    let writer_stream = stream.try_clone().map_err(|e| format!("clone IPC stream: {e}"))?;

    let (cmd_tx, cmd_rx) = mpsc::channel::<MpvCommand>();
    let req_counter = Arc::new(AtomicU64::new(1));

    // ---- writer thread ----
    {
        let mut out = writer_stream;
        let counter = req_counter.clone();
        std::thread::Builder::new()
            .name("melo-mpv-writer".into())
            .spawn(move || {
                let mut next_req = move || counter.fetch_add(1, Ordering::Relaxed);
                // Initial observes + audio settings.
                let mut boot = ipc::encode_observe_all(next_req());
                boot.push(ipc::encode_command(&MpvCommand::SetVolume(initial_volume), next_req()));
                boot.push(ipc::encode_command(&MpvCommand::SetMuted(initial_muted), next_req()));
                for line in boot {
                    if write_line(&mut out, &line).is_err() {
                        return;
                    }
                }
                while let Ok(cmd) = cmd_rx.recv() {
                    // LoadUrl expands into multiple lines (pause + loadfile).
                    for line in ipc::encode_command_seq(&cmd, &mut next_req) {
                        if write_line(&mut out, &line).is_err() {
                            break;
                        }
                    }
                }
            })
            .map_err(|e| format!("spawn writer: {e}"))?;
    }

    // ---- reader thread ----
    {
        let events = events.clone();
        std::thread::Builder::new()
            .name("melo-mpv-reader".into())
            .spawn(move || {
                let reader = BufReader::new(stream);
                let mut exited = false;
                for line in reader.lines() {
                    match line {
                        Ok(text) => {
                            if let Some(ev) = ipc::decode_line(&text) {
                                if events.send(ev).is_err() {
                                    break;
                                }
                            }
                        }
                        Err(_) => {
                            // Stream closed → mpv exited.
                            let _ = events.send(EngineEvent::ProcessExited {
                                detail: "IPC stream closed".into(),
                            });
                            exited = true;
                            break;
                        }
                    }
                }
                if !exited {
                    let _ = events.send(EngineEvent::ProcessExited {
                        detail: "mpv closed the IPC connection".into(),
                    });
                }
            })
            .map_err(|e| format!("spawn reader: {e}"))?;
    }

    Ok(RunningEngine {
        commands: cmd_tx,
        child: Arc::new(Mutex::new(Some(child))),
    })
}

fn write_line(out: &mut DuplexStream, line: &str) -> std::io::Result<()> {
    out.write_all(line.as_bytes())?;
    out.write_all(b"\n")?;
    out.flush()
}
