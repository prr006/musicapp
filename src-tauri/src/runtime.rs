//! Managed runtime: MELO ships/installs its own mpv + yt-dlp.
//!
//! MELO is a standalone desktop app — it must NOT depend on the user's PATH.
//! Binary resolution is deterministic, in this order (first hit wins):
//!
//! 1. `MELO_MPV_PATH` / `MELO_YTDLP_PATH` env — explicit per-binary override
//!    (absolute path; a bare name is honored verbatim as an explicit choice).
//! 2. `MELO_RUNTIME_DIR` env — explicit runtime root (`<dir>/bin` is used).
//! 3. Dev checkout: `<repo>/src-tauri/runtime/bin`, found by walking up from
//!    the running executable (target/debug → repo). `npm run tauri dev` uses
//!    this; the first run downloads into it so the cache survives `cargo
//!    clean`.
//! 4. Bundled install: `<exe_dir>/runtime/bin` (NSIS/MSI resources — see
//!    `tauri.conf.json` → `bundle.resources`).
//! 5. Managed download dir: `<config_dir>/runtime/bin` — writable location
//!    used for the first-run bootstrap in installed apps.
//!
//! There is **no PATH fallback**: if the runtime is missing, MELO downloads
//! it (mpv from the zhongfly/mpv-winbuild GitHub release, yt-dlp from its
//! stable `latest/download` URL) into the install dir and reports progress
//! through engine-status events. If the download fails, playback reports a
//! clear repair action (Settings → Diagnostics → Repair runtime) instead of
//! silently trying whatever happens to be on PATH.
//!
//! Archive handling: mpv Windows builds are `.7z`, so the bootstrap also
//! fetches the standalone LGPL `7zr.exe` from 7-zip.org into
//! `<runtime>/tools/` and shells out to it once (CREATE_NO_WINDOW). No new
//! Rust dependencies, no code from either project in this repository.

// Download/extract machinery is exercised on Windows only; keep the shared
// code compiling warning-clean elsewhere.
#![cfg_attr(not(windows), allow(dead_code))]

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::Emitter;

use crate::events;

const MPV_RELEASES_API: &str =
    "https://api.github.com/repos/zhongfly/mpv-winbuild/releases/latest";
/// Plain x86_64 build (not `-v3`, not `-debug`, not `-dev`) for the widest
/// CPU compatibility.
const MPV_ASSET_PREFIX: &str = "mpv-x86_64-";
const MPV_ASSET_SUFFIX: &str = ".7z";
const SEVENZR_URL: &str = "https://www.7-zip.org/a/7zr.exe";
const YTDLP_URL: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
const USER_AGENT: &str = "MELO/0.1 (desktop music player; https://github.com/prr006/musicapp)";

#[derive(Debug, Clone)]
pub struct RuntimePaths {
    pub config_dir: PathBuf,
    /// Where the bootstrap puts binaries (dev repo bin when developing,
    /// otherwise the managed config dir).
    pub install_bin: PathBuf,
    /// Absolute path to the mpv we will spawn (the intended install path when
    /// not yet installed — `mpv_found` says which).
    pub mpv: PathBuf,
    pub mpv_found: bool,
    pub ytdlp: Option<PathBuf>,
    /// Every bin dir considered, for diagnostics ("where did MELO look?").
    pub searched: Vec<PathBuf>,
}

fn mpv_file_name() -> &'static str {
    if cfg!(windows) {
        "mpv.exe"
    } else {
        "mpv"
    }
}

fn ytdlp_file_name() -> &'static str {
    if cfg!(windows) {
        "yt-dlp.exe"
    } else {
        "yt-dlp"
    }
}

/// `<repo>/src-tauri/runtime/bin` when running from a dev checkout.
fn dev_repo_bin() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let mut dir = exe.parent()?.to_path_buf();
    loop {
        let candidate = dir.join("src-tauri").join("runtime").join("bin");
        if candidate.is_dir() {
            return Some(candidate);
        }
        if !dir.pop() {
            return None;
        }
    }
}

fn exe_relative_bin() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("runtime").join("bin")))
        .filter(|d| d.is_dir())
}

fn env_bin() -> Option<PathBuf> {
    std::env::var("MELO_RUNTIME_DIR")
        .ok()
        .map(|d| PathBuf::from(d).join("bin"))
}

impl RuntimePaths {
    pub fn resolve(config_dir: &Path) -> Self {
        let mpv_name = mpv_file_name();
        let ytdlp_name = ytdlp_file_name();
        let managed = config_dir.join("runtime").join("bin");

        // Search order (deterministic, no PATH).
        let mut searched: Vec<PathBuf> = Vec::new();
        if let Some(dir) = env_bin() {
            searched.push(dir);
        }
        if let Some(dir) = dev_repo_bin() {
            searched.push(dir);
        }
        if let Some(dir) = exe_relative_bin() {
            searched.push(dir);
        }
        searched.push(managed.clone());

        // The download target: explicit env root, else the dev checkout (so
        // `tauri dev` caches across builds), else the managed config dir.
        // A bundled-but-incomplete install dir (Program Files) is NOT a
        // download target — it is usually not writable without elevation.
        let install_bin = env_bin()
            .or_else(dev_repo_bin)
            .unwrap_or_else(|| managed.clone());

        let env_mpv = std::env::var("MELO_MPV_PATH").ok().map(PathBuf::from);
        let env_ytdlp = std::env::var("MELO_YTDLP_PATH").ok().map(PathBuf::from);

        let (mpv, mpv_found) = match env_mpv {
            Some(p) => {
                // An explicit env override is used verbatim; if the user
                // points at something missing, the mpv spawn error will say
                // so (with the absolute path) rather than MELO guessing.
                (p, true)
            }
            None => match searched.iter().find_map(|d| {
                let f = d.join(mpv_name);
                f.is_file().then_some(f)
            }) {
                Some(found_path) => (found_path, true),
                None => (install_bin.join(mpv_name), false),
            },
        };

        let ytdlp = match env_ytdlp {
            Some(p) => Some(p),
            None => searched
                .iter()
                .find_map(|d| {
                    let f = d.join(ytdlp_name);
                    f.is_file().then_some(f)
                }),
        };

        Self {
            config_dir: config_dir.to_path_buf(),
            install_bin,
            mpv,
            mpv_found,
            ytdlp,
            searched,
        }
    }

    pub fn mpv_string(&self) -> String {
        self.mpv.to_string_lossy().into_owned()
    }

    pub fn ytdlp_found(&self) -> bool {
        self.ytdlp.as_ref().is_some_and(|p| p.is_file())
    }
}

/// Shared, live view of the runtime paths. The bootstrap updates it after a
/// successful install so the resolver + engine see the new binaries without
/// an app restart.
#[derive(Clone)]
pub struct RuntimeHandle {
    inner: Arc<Mutex<RuntimePaths>>,
}

impl RuntimeHandle {
    pub fn resolve(config_dir: &Path) -> Self {
        Self {
            inner: Arc::new(Mutex::new(RuntimePaths::resolve(config_dir))),
        }
    }

    fn with<R>(&self, f: impl FnOnce(&RuntimePaths) -> R) -> R {
        let guard = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        f(&guard)
    }

    pub fn mpv_string(&self) -> String {
        self.with(|p| p.mpv_string())
    }

    pub fn mpv_found(&self) -> bool {
        self.with(|p| p.mpv_found)
    }

    pub fn ytdlp(&self) -> Option<PathBuf> {
        self.with(|p| p.ytdlp.clone())
    }

    pub fn ytdlp_path_string(&self) -> Option<String> {
        self.with(|p| p.ytdlp.as_ref().map(|y| y.to_string_lossy().into_owned()))
    }

    pub fn ytdlp_found(&self) -> bool {
        self.with(|p| p.ytdlp_found())
    }

    /// Clone the current paths for a worker thread.
    pub fn with_clone(&self) -> RuntimePaths {
        self.with(|p| p.clone())
    }

    /// Re-run discovery (after an install) and publish the new paths.
    pub fn reload(&self) {
        let mut guard = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        *guard = RuntimePaths::resolve(&guard.config_dir);
    }
}

// ----------------------------------------------------------------------
// Bootstrap (download + install)
// ----------------------------------------------------------------------

fn http_agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(30))
        .timeout_read(Duration::from_secs(120))
        .user_agent(USER_AGENT)
        .build()
}

/// Stream a URL to `dest` (atomic: `.part` then rename), reporting progress.
fn download(url: &str, dest: &Path, progress: &dyn Fn(&str)) -> Result<(), String> {
    let agent = http_agent();
    let resp = agent
        .get(url)
        .call()
        .map_err(|e| format!("download failed ({url}): {e}"))?;
    let total: Option<u64> = resp
        .header("Content-Length")
        .and_then(|v| v.parse::<u64>().ok());
    let part = dest.with_extension("part");
    if let Some(dir) = part.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    }
    let mut reader = resp.into_reader();
    let mut buf = Vec::new();
    reader
        .read_to_end(&mut buf)
        .map_err(|e| format!("download read error ({url}): {e}"))?;
    if buf.is_empty() {
        return Err(format!("download was empty ({url})"));
    }
    fs::write(&part, &buf).map_err(|e| format!("write {}: {e}", part.display()))?;
    if let Some(total) = total {
        let mb = |n: u64| format!("{:.1}", n as f64 / 1_048_576.0);
        progress(&format!(
            "Downloading runtime… {} / {} MB",
            mb(buf.len() as u64),
            mb(total)
        ));
    }
    fs::rename(&part, dest).map_err(|e| format!("finalize {}: {e}", dest.display()))?;
    Ok(())
}

/// Latest mpv x86_64 `.7z` asset URL from the zhongfly/mpv-winbuild release.
fn latest_mpv_asset_url() -> Result<String, String> {
    let agent = http_agent();
    let resp = agent
        .get(MPV_RELEASES_API)
        .set("Accept", "application/vnd.github+json")
        .call()
        .map_err(|e| format!("could not reach the mpv release index: {e}"))?;
    let doc: serde_json::Value = resp
        .into_json()
        .map_err(|e| format!("bad mpv release index: {e}"))?;
    let assets = doc
        .get("assets")
        .and_then(|a| a.as_array())
        .ok_or("mpv release index had no assets")?;
    let pick = assets
        .iter()
        .filter_map(|a| {
            let name = a.get("name")?.as_str()?;
            let url = a.get("browser_download_url")?.as_str()?;
            Some((name, url))
        })
        .find(|(name, _)| {
            name.starts_with(MPV_ASSET_PREFIX)
                && name.ends_with(MPV_ASSET_SUFFIX)
                && !name.contains("v3")
                && !name.contains("debug")
                && !name.contains("dev")
        });
    pick.map(|(_, url)| url.to_string())
        .ok_or("no suitable mpv x86_64 build in the latest release")
}

fn hide_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

fn run_quiet(mut cmd: Command, what: &str) -> Result<(), String> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    hide_window(&mut cmd);
    let status = cmd
        .status()
        .map_err(|e| format!("could not run {what}: {e}"))?;
    if !status.success() {
        return Err(format!("{what} failed with {status}"));
    }
    Ok(())
}

/// Find `file_name` anywhere under `root` (depth-first, bounded).
fn find_file(root: &Path, file_name: &str) -> Option<PathBuf> {
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = fs::read_dir(&dir).ok()?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.file_name().map_or(false, |n| n == file_name) {
                return Some(path);
            }
        }
    }
    None
}

/// Install missing runtime pieces into `paths.install_bin`.
/// `progress` receives human-readable status lines.
#[cfg(windows)]
pub fn install(paths: &RuntimePaths, progress: &dyn Fn(&str)) -> Result<(), String> {
    let bin = &paths.install_bin;
    fs::create_dir_all(bin).map_err(|e| format!("create {}: {e}", bin.display()))?;

    if paths.ytdlp.is_none() {
        progress("Downloading yt-dlp…");
        let dest = bin.join(ytdlp_file_name());
        download(YTDLP_URL, &dest, progress)?;
        progress("yt-dlp installed.");
    }

    if !paths.mpv_found {
        install_mpv(bin, progress)?;
    }
    Ok(())
}

/// Automatic install is Windows-only; elsewhere MELO expects an explicit
/// `MELO_MPV_PATH` / `MELO_YTDLP_PATH` (documented) instead of guessing.
#[cfg(not(windows))]
pub fn install(_paths: &RuntimePaths, _progress: &dyn Fn(&str)) -> Result<(), String> {
    Err(
        "automatic runtime install is Windows-only; install mpv and yt-dlp \
         manually and set MELO_MPV_PATH / MELO_YTDLP_PATH to their absolute paths"
            .into(),
    )
}

#[cfg(windows)]
fn install_mpv(bin: &Path, progress: &dyn Fn(&str)) -> Result<(), String> {
    let asset = latest_mpv_asset_url()?;
    let tmp = std::env::temp_dir().join(format!("melo-runtime-{}", std::process::id()));
    let _ = fs::remove_dir_all(&tmp);
    fs::create_dir_all(&tmp).map_err(|e| format!("create {}: {e}", tmp.display()))?;

    let archive = tmp.join("mpv.7z");
    download(&asset, &archive, progress)?;

    // Standalone 7-Zip extractor (LGPL; downloaded, not bundled).
    let tools = bin
        .parent()
        .map(|p| p.join("tools"))
        .unwrap_or_else(|| tmp.join("tools"));
    fs::create_dir_all(&tools).map_err(|e| format!("create {}: {e}", tools.display()))?;
    let sevenzr = tools.join("7zr.exe");
    if !sevenzr.is_file() {
        download(SEVENZR_URL, &sevenzr, progress)?;
    }

    let out = tmp.join("x");
    fs::create_dir_all(&out).map_err(|e| format!("create {}: {e}", out.display()))?;
    run_quiet(
        Command::new(&sevenzr).args(["x", "-y", &format!("-o{}", out.display())]).arg(&archive),
        "7zr extraction",
    )?;

    // The archive contains a versioned folder with mpv.exe (+ dlls) inside.
    let mpv_exe =
        find_file(&out, "mpv.exe").ok_or("mpv.exe not found inside the downloaded archive")?;
    let src_dir = mpv_exe
        .parent()
        .ok_or("unexpected archive layout")?
        .to_path_buf();
    for entry in fs::read_dir(&src_dir).map_err(|e| format!("read {}: {e}", src_dir.display()))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let dest = bin.join(entry.file_name());
        if entry.path().is_dir() {
            continue; // mpv needs only the flat exe + dlls
        }
        if dest.exists() {
            let _ = fs::remove_file(&dest);
        }
        fs::rename(entry.path(), &dest)
            .or_else(|_| fs::copy(entry.path(), &dest).map(|_| ()))?;
    }
    let _ = fs::remove_dir_all(&tmp);

    if !bin.join("mpv.exe").is_file() {
        return Err("mpv install finished but mpv.exe is missing".into());
    }
    progress("mpv installed.");
    Ok(())
}

#[cfg(not(windows))]
fn install_mpv(_bin: &Path, _progress: &dyn Fn(&str)) -> Result<(), String> {
    Err(
        "automatic mpv install is Windows-only; on this platform install mpv \
         manually and point MELO_MPV_PATH at the absolute executable path"
            .into(),
    )
}

// ----------------------------------------------------------------------
// First-run bootstrap (background thread + engine-status progress)
// ----------------------------------------------------------------------

/// Emit progress/result through the existing engine-status event channel so
/// the UI shows it without a new event type.
fn emit_status(app: &tauri::AppHandle, health: &str, message: String) {
    // Health is re-serialized from the string form to avoid depending on
    // melo_core here; the frontend only toasts on dead/restarting.
    let health = match health {
        "running" => melo_core::player::EngineHealth::Running,
        "restarting" => melo_core::player::EngineHealth::Restarting,
        _ => melo_core::player::EngineHealth::Dead,
    };
    let _ = app.emit(
        events::ENGINE_STATUS,
        events::EngineStatus {
            health,
            message,
        },
    );
}

/// Best-effort removal of MELO-managed binaries so the next [`install`] is a
/// full re-download. Only files inside `install_bin` are touched — explicit
/// env overrides are never deleted. Used by "Repair runtime".
pub fn reset_for_repair(runtime: &RuntimeHandle) {
    let snap = runtime.with_clone();
    let managed = [Some(snap.mpv.clone()), snap.ytdlp.clone()]
        .into_iter()
        .flatten();
    for path in managed {
        if path.starts_with(&snap.install_bin) && path.is_file() {
            let _ = fs::remove_file(&path);
        }
    }
    runtime.reload();
}

/// Ensure the runtime exists; download missing pieces. Runs on a background
/// thread. On success the handle is reloaded and `on_ready` (re)starts the
/// engine.
pub fn bootstrap_and_report(
    app: tauri::AppHandle,
    runtime: RuntimeHandle,
    on_ready: impl FnOnce() + Send + 'static,
) {
    std::thread::Builder::new()
        .name("melo-runtime-bootstrap".into())
        .spawn(move || {
            let snapshot = runtime.with_clone();
            emit_status(
                &app,
                "restarting",
                "Installing MELO playback runtime (first run)…".into(),
            );
            let result =
                install(&snapshot, &|msg| emit_status(&app, "restarting", msg.to_string()));
            match result {
                Ok(()) => {
                    runtime.reload();
                    emit_status(&app, "running", "Playback runtime ready — press play.".into());
                    on_ready();
                }
                Err(e) => {
                    log_note(&format!("runtime install failed: {e}"));
                    emit_status(
                        &app,
                        "dead",
                        format!(
                            "Couldn't install the playback runtime ({e}). \
                             Open Settings → Diagnostics → Repair runtime."
                        ),
                    );
                }
            }
        })
        .map(|_| ())
        .unwrap_or_else(|e| log_note(&format!("bootstrap thread spawn failed: {e}")));
}

fn log_note(msg: &str) {
    eprintln!("[melo] {msg}");
}
