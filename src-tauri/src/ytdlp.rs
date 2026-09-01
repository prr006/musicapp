//! yt-dlp process integration: search + resolve to a direct media URL.
//!
//! Spawned with the **absolute path** from `crate::runtime` (never PATH),
//! hidden window on Windows, and hard timeouts so a hung yt-dlp can never
//! wedge the UI. Parsing lives in `melo-core::ytdlp` (pure, unit-tested).

use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use melo_core::persistence::AudioQuality;
use melo_core::providers::ProviderError;
use melo_core::ytdlp;

pub fn search(
    binary: &Path,
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

/// Run a command, capture stdout, kill on timeout (poll try_wait).
fn run_with_timeout(mut cmd: Command, timeout: Duration) -> Result<String, ProviderError> {
    use std::io::Read;
    let mut child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .spawn()
        .map_err(|e| ProviderError::Detail(format!("could not start yt-dlp: {e}")))?;
    let deadline = Instant::now() + timeout;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| ProviderError::Detail("yt-dlp produced no output pipe".into()))?;
    // Read+wait interleaved: the pipe read blocks until data or EOF, so the
    // reading happens on a worker thread while we poll the deadline here.
    let reader = std::thread::spawn(move || {
        let mut buf = String::new();
        let _ = stdout.read_to_string(&mut buf);
        buf
    });
    loop {
        if let Ok(Some(_status)) = child.try_wait() {
            break;
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(ProviderError::Detail("yt-dlp timed out".into()));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let out = reader
        .join()
        .map_err(|_| ProviderError::Detail("yt-dlp output lost".into()))?;
    if out.trim().is_empty() {
        return Err(ProviderError::Detail("yt-dlp returned nothing".into()));
    }
    Ok(out)
}
