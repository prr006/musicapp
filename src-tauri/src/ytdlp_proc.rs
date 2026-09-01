//! yt-dlp process integration (spawn + timeout). Parsing lives in
//! `melo-core::ytdlp`; this module only runs the binary and returns stdout.
//!
//! Windows: child processes are hidden (`CREATE_NO_WINDOW`) so no console
//! flashes on every search/resolve. Timeouts are enforced by polling
//! `try_wait` so a hung yt-dlp can never wedge playback.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use melo_core::persistence::AudioQuality;
use melo_core::providers::ProviderError;
use melo_core::ytdlp;

fn hide_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

fn base_command(binary: &Path) -> Command {
    let mut cmd = Command::new(binary);
    cmd.arg("--no-warnings")
        .arg("--ignore-config")
        .arg("--no-progress")
        .arg("--no-color");
    hide_window(&mut cmd);
    cmd
}

/// Run a command, capture stdout, kill on timeout.
fn run_with_timeout(mut cmd: Command, timeout: Duration) -> Result<String, ProviderError> {
    use std::io::Read;
    let mut child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .spawn()
        .map_err(|e| ProviderError::Detail(format!("could not start process: {e}")))?;
    let mut stdout = child.stdout.take().expect("piped stdout");
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        buf
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if Instant::now() > deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(ProviderError::Timeout);
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(e) => return Err(ProviderError::Detail(format!("wait failed: {e}"))),
        }
    };
    let output = reader.join().unwrap_or_default();
    if !status.success() {
        return Err(ProviderError::Detail(format!(
            "yt-dlp exited with {status}: {}",
            String::from_utf8_lossy(&output).chars().take(300).collect::<String>()
        )));
    }
    Ok(String::from_utf8_lossy(&output).into_owned())
}

/// Search YouTube via `ytsearch{limit}:` and map to domain tracks.
pub fn search(
    binary: &PathBuf,
    query: &str,
    limit: u32,
) -> Result<Vec<melo_core::domain::Track>, ProviderError> {
    let limit = limit.clamp(1, 40);
    let mut cmd = base_command(binary);
    cmd.arg("-J")
        .arg("--flat-playlist")
        .arg(format!("ytsearch{limit}:{query}"));
    let out = run_with_timeout(cmd, Duration::from_secs(30))?;
    ytdlp::parse_search_document(&out, limit as usize)
}

/// Resolve a YouTube video id to a direct media URL.
pub fn resolve(
    binary: &Path,
    source_id: &str,
    quality: AudioQuality,
) -> Result<melo_core::providers::ResolvedMedia, ProviderError> {
    let mut cmd = base_command(binary);
    cmd.arg("-J")
        .arg("--no-playlist")
        .arg("-f")
        .arg(ytdlp::format_selector(quality))
        .arg(ytdlp::watch_url(source_id));
    let out = run_with_timeout(cmd, Duration::from_secs(45))?;
    ytdlp::parse_resolve_document(&out)
}
