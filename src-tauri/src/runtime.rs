//! Managed runtime: the pinned libmpv DLL + yt-dlp.exe MELO needs.
//!
//! Deliberately minimal (this replaces a much larger bootstrap):
//! * Two files: `libmpv-2.dll` (engine) and `yt-dlp.exe` (resolver).
//! * Everything is **pinned to an exact release tag** and verified against
//!   the SHA-256 digest GitHub publishes for that asset — no "latest", no
//!   floating versions, no unverified downloads.
//! * Lookup order (first hit wins, no PATH ever):
//!     1. `MELO_RUNTIME_DIR` (`<dir>/bin`, plus `<dir>/tools`)
//!     2. `<exe_dir>/runtime/bin` — manual sidecar override (nothing is
//!        bundled: the runtime is always downloaded + verified on first run)
//!     3. `<repo>/.melo-runtime/bin` — `tauri dev` cache. Repo root, NOT
//!        `src-tauri`: the Tauri dev watcher rebuilds on any change under the
//!        crate dir, which once killed the app mid-download. The dir is
//!        created on first use.
//!     4. `<config_dir>/runtime/bin` — writable fallback (download target
//!        when neither repo nor exe dir applies, e.g. installed builds
//!        without bundled resources).
//! * The download target is (1) or (3) or (4) — never the (usually
//!   read-only) install dir next to the exe.
//! * Progress/status is reported via `runtime://status` events; failures
//!   produce an actionable message (Settings → Diagnostics → Repair runtime).
//!
//! Only Windows downloads automatically. Elsewhere, point `MELO_RUNTIME_DIR`
//! at a directory containing `bin/libmpv-2.dll` (+ optional `bin/yt-dlp.exe`).

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use sha2::{Digest, Sha256};
use tauri::Emitter;

use crate::events;

// ---- pinned releases (verify before changing!) ---------------------------

/// zhongfly/mpv-winbuild release containing the libmpv dev archive.
const MPV_RELEASE_TAG: &str = "2026-08-31-02a595ddc1";
const MPV_RELEASES_API: &str = "https://api.github.com/repos/zhongfly/mpv-winbuild/releases/tags";
/// Plain x86_64 libmpv (not `-v3`, not `-lgpl`, not full player builds).
const MPV_DEV_PREFIX: &str = "mpv-dev-x86_64-";
const MPV_DEV_SUFFIX: &str = ".7z";

const YTDLP_RELEASE_TAG: &str = "2026.08.19";
const YTDLP_RELEASES_API: &str = "https://api.github.com/repos/yt-dlp/yt-dlp/releases/tags";
const YTDLP_ASSET: &str = "yt-dlp.exe";

/// Standalone 7-Zip extractor used once, to unpack the libmpv archive.
const SEVENZIP_RELEASE_TAG: &str = "26.02";
const SEVENZIP_RELEASES_API: &str = "https://api.github.com/repos/ip7z/7zip/releases/tags";
const SEVENZIP_ASSET: &str = "7zr.exe";

const USER_AGENT: &str = "MELO/0.1 (desktop music player; https://github.com/prr006/musicapp)";

// ---- paths ---------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct RuntimePaths {
    /// Download target (never the read-only install dir).
    pub install_bin: PathBuf,
    /// `<install_bin>/../tools` for 7zr.exe.
    pub tools_dir: PathBuf,
    pub libmpv: PathBuf,
    pub libmpv_found: bool,
    pub ytdlp: Option<PathBuf>,
    pub searched: Vec<PathBuf>,
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

/// Repo root located via the `src-tauri` marker (exe at `<repo>/target/debug`).
fn dev_repo_root() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let mut dir = exe.parent()?.to_path_buf();
    loop {
        if dir.join("src-tauri").is_dir() {
            return Some(dir);
        }
        if !dir.pop() {
            return None;
        }
    }
}

fn dev_bin() -> Option<PathBuf> {
    dev_repo_root().map(|root| root.join(".melo-runtime").join("bin"))
}

impl RuntimePaths {
    pub fn resolve(config_dir: &Path) -> Self {
        let managed = config_dir.join("runtime").join("bin");

        let mut searched: Vec<PathBuf> = Vec::new();
        if let Some(dir) = env_bin() {
            searched.push(dir);
        }
        if let Some(dir) = exe_relative_bin() {
            searched.push(dir);
        }
        if let Some(dir) = dev_bin() {
            searched.push(dir);
        }
        searched.push(managed.clone());

        let install_bin = env_bin()
            .or_else(dev_bin)
            .unwrap_or_else(|| managed.clone());
        let tools_dir = install_bin
            .parent()
            .map(|p| p.join("tools"))
            .unwrap_or_else(|| install_bin.clone());

        let libmpv = searched
            .iter()
            .find_map(|d| {
                let f = d.join("libmpv-2.dll");
                f.is_file().then_some(f)
            })
            .unwrap_or_else(|| install_bin.join("libmpv-2.dll"));

        let ytdlp = searched.iter().find_map(|d| {
            let f = d.join(YTDLP_ASSET);
            f.is_file().then_some(f)
        });

        Self {
            install_bin,
            tools_dir,
            libmpv_found: libmpv.is_file(),
            libmpv,
            ytdlp,
            searched,
        }
    }
}

/// Shared live view; reloaded after an install so a running app sees the new
/// files without a restart.
#[derive(Clone)]
pub struct RuntimeHandle {
    inner: Arc<Mutex<RuntimePaths>>,
    config_dir: PathBuf,
}

impl RuntimeHandle {
    pub fn new(config_dir: &Path) -> Self {
        Self {
            inner: Arc::new(Mutex::new(RuntimePaths::resolve(config_dir))),
            config_dir: config_dir.to_path_buf(),
        }
    }

    fn with<R>(&self, f: impl FnOnce(&RuntimePaths) -> R) -> R {
        let guard = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        f(&guard)
    }

    pub fn libmpv_path(&self) -> PathBuf {
        self.with(|p| p.libmpv.clone())
    }

    pub fn libmpv_found(&self) -> bool {
        self.with(|p| p.libmpv_found)
    }

    pub fn ytdlp_path(&self) -> Option<PathBuf> {
        self.with(|p| p.ytdlp.clone())
    }

    pub fn ytdlp_found(&self) -> bool {
        self.with(|p| p.ytdlp.as_ref().map_or(false, |y| y.is_file()))
    }

    pub fn install_bin(&self) -> PathBuf {
        self.with(|p| p.install_bin.clone())
    }

    pub fn reload(&self) {
        let mut guard = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        *guard = RuntimePaths::resolve(&self.config_dir);
    }
}

// ---- download + verify ---------------------------------------------------

struct Asset {
    url: String,
    sha256: String,
}

fn http_agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(30))
        .timeout_read(Duration::from_secs(180))
        .user_agent(USER_AGENT)
        .build()
}

/// Look up one asset of a pinned release, with its published SHA-256 digest.
fn pinned_asset(api_base: &str, tag: &str, pick: &dyn Fn(&str) -> bool) -> Result<Asset, String> {
    let url = format!("{api_base}/{tag}");
    let agent = http_agent();
    let resp = agent
        .get(&url)
        .set("Accept", "application/vnd.github+json")
        .call()
        .map_err(|e| format!("release index {tag}: {e}"))?;
    let doc: serde_json::Value = resp
        .into_json()
        .map_err(|e| format!("bad release index {tag}: {e}"))?;
    let assets = doc
        .get("assets")
        .and_then(|a| a.as_array())
        .ok_or_else(|| format!("release {tag} has no assets"))?;
    for a in assets {
        let name = a.get("name").and_then(|n| n.as_str()).unwrap_or("");
        if !pick(name) {
            continue;
        }
        let dl = a
            .get("browser_download_url")
            .and_then(|u| u.as_str())
            .ok_or("asset without download url")?;
        let digest = a
            .get("digest")
            .and_then(|d| d.as_str())
            .and_then(|d| d.strip_prefix("sha256:"))
            .ok_or_else(|| format!("asset {name} has no sha256 digest"))?;
        return Ok(Asset {
            url: dl.to_string(),
            sha256: digest.to_string(),
        });
    }
    Err(format!("pinned asset not found in release {tag}"))
}

fn sha256_of(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|e| format!("open {}: {e}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 65536];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| format!("read {}: {e}", path.display()))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let out = hasher.finalize();
    let mut s = String::with_capacity(64);
    for b in out {
        s.push_str(&format!("{b:02x}"));
    }
    Ok(s)
}

/// Download to `<dest>.part`, verify SHA-256 against the pinned digest, then
/// atomically rename. Returns Err with the mismatch on integrity failure.
fn download_verified(asset: &Asset, dest: &Path, progress: &dyn Fn(&str)) -> Result<(), String> {
    if let Some(dir) = dest.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    }
    let part = dest.with_extension("part");
    let label = dest
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    progress(&format!("Downloading {label}…"));
    let agent = http_agent();
    let resp = agent
        .get(&asset.url)
        .call()
        .map_err(|e| format!("download failed: {e}"))?;
    let mut reader = resp.into_reader();
    let mut buf = Vec::new();
    reader
        .read_to_end(&mut buf)
        .map_err(|e| format!("download read: {e}"))?;
    if buf.is_empty() {
        return Err("download was empty".into());
    }
    fs::write(&part, &buf).map_err(|e| format!("write {}: {e}", part.display()))?;
    let actual = sha256_of(&part)?;
    if !actual.eq_ignore_ascii_case(&asset.sha256) {
        let _ = fs::remove_file(&part);
        return Err(format!(
            "integrity check failed for {} (expected sha256 {}, got {actual}) — download discarded",
            dest.display(),
            asset.sha256
        ));
    }
    fs::rename(&part, dest).map_err(|e| format!("finalize {}: {e}", dest.display()))?;
    Ok(())
}

fn hide_window(cmd: &mut std::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

// ---- install --------------------------------------------------------------

/// Install missing runtime pieces. `progress` gets human-readable status.
#[cfg(windows)]
pub fn install(paths: &RuntimePaths, progress: &dyn Fn(&str)) -> Result<(), String> {
    let bin = &paths.install_bin;
    fs::create_dir_all(bin).map_err(|e| format!("create {}: {e}", bin.display()))?;

    if paths.ytdlp.as_ref().map_or(true, |p| !p.is_file()) {
        let asset = pinned_asset(YTDLP_RELEASES_API, YTDLP_RELEASE_TAG, &|n| n == YTDLP_ASSET)?;
        let dest = bin.join(YTDLP_ASSET);
        download_verified(&asset, &dest, progress)?;
        progress("yt-dlp installed.");
    }

    if !paths.libmpv_found {
        let asset = pinned_asset(
            MPV_RELEASES_API,
            MPV_RELEASE_TAG,
            &|n| {
                n.starts_with(MPV_DEV_PREFIX)
                    && n.ends_with(MPV_DEV_SUFFIX)
                    && !n.contains("-v3")
                    && !n.contains("-lgpl")
            },
        )?;
        let tmp = std::env::temp_dir().join(format!("melo-runtime-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).map_err(|e| format!("create {}: {e}", tmp.display()))?;
        let archive = tmp.join("mpv-dev.7z");
        download_verified(&asset, &archive, progress)?;

        // 7zr.exe (pinned + digest-verified) unpacks it once.
        let tools = &paths.tools_dir;
        fs::create_dir_all(tools).map_err(|e| format!("create {}: {e}", tools.display()))?;
        let sevenzr = tools.join(SEVENZIP_ASSET);
        if !sevenzr.is_file() {
            let sz = pinned_asset(
                SEVENZIP_RELEASES_API,
                SEVENZIP_RELEASE_TAG,
                &|n| n == SEVENZIP_ASSET,
            )?;
            download_verified(&sz, &sevenzr, progress)?;
        }
        let out = tmp.join("x");
        fs::create_dir_all(&out).map_err(|e| format!("create {}: {e}", out.display()))?;
        let mut extract = std::process::Command::new(&sevenzr);
        extract
            .arg("x")
            .arg("-y")
            .arg(format!("-o{}", out.display()))
            .arg(&archive);
        extract
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        hide_window(&mut extract);
        let status = extract
            .status()
            .map_err(|e| format!("could not run 7zr: {e}"))?;
        if !status.success() {
            return Err(format!("7zr extraction failed with {status}"));
        }

        // The archive holds headers + import libs; we need only the DLL.
        let dll = find_file(&out, "libmpv-2.dll")
            .ok_or("libmpv-2.dll not found inside the downloaded archive")?;
        let dest = bin.join("libmpv-2.dll");
        fs::copy(&dll, &dest).map_err(|e| {
            format!("copy {} -> {}: {e}", dll.display(), dest.display())
        })?;
        let _ = fs::remove_dir_all(&tmp);
        if !dest.is_file() {
            return Err("libmpv install finished but the DLL is missing".into());
        }
        progress("libmpv installed.");
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn install(_paths: &RuntimePaths, _progress: &dyn Fn(&str)) -> Result<(), String> {
    Err(
        "automatic runtime install is Windows-only; put libmpv-2.dll (and optionally yt-dlp.exe) \
         in a directory and point MELO_RUNTIME_DIR at it"
            .into(),
    )
}

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

// ---- ensure / repair ------------------------------------------------------

/// Ensure the runtime exists (downloading missing pieces on a background
/// thread), then invoke `on_ready`. Failures are reported through
/// `runtime://status` and never silently fall back to PATH lookups.
pub fn ensure_and_report(
    app: tauri::AppHandle,
    runtime: RuntimeHandle,
    on_ready: impl FnOnce() + Send + 'static,
) {
    std::thread::Builder::new()
        .name("melo-runtime".into())
        .spawn(move || {
            if runtime.libmpv_found() && runtime.ytdlp_found() {
                on_ready();
                return;
            }
            let _ = app.emit(
                events::RUNTIME_STATUS,
                events::RuntimeStatus {
                    phase: "installing",
                    message: "Installing MELO playback runtime (one-time, verified)…".into(),
                },
            );
            let snapshot = {
                let guard = runtime.inner.lock().unwrap_or_else(|p| p.into_inner());
                guard.clone()
            };
            let result = install(&snapshot, &|msg| {
                let _ = app.emit(
                    events::RUNTIME_STATUS,
                    events::RuntimeStatus {
                        phase: "installing",
                        message: msg.to_string(),
                    },
                );
            });
            match result {
                Ok(()) => {
                    runtime.reload();
                    let _ = app.emit(
                        events::RUNTIME_STATUS,
                        events::RuntimeStatus {
                            phase: "ready",
                            message: "Playback runtime ready.".into(),
                        },
                    );
                    on_ready();
                }
                Err(e) => {
                    eprintln!("[melo] runtime install failed: {e}");
                    let _ = app.emit(
                        events::RUNTIME_STATUS,
                        events::RuntimeStatus {
                            phase: "error",
                            message: format!(
                                "Couldn't install the playback runtime: {e}. \
                                 Check your connection, then use Settings → Diagnostics → \
                                 Repair runtime."
                            ),
                        },
                    );
                }
            }
        })
        .map(|_| ())
        .unwrap_or_else(|e| eprintln!("[melo] runtime thread spawn failed: {e}"));
}

/// Delete MELO-managed binaries so the next `install` is a full re-download.
/// Only files inside the install dir are touched.
pub fn reset_for_repair(runtime: &RuntimeHandle) {
    let snap = {
        let guard = runtime.inner.lock().unwrap_or_else(|p| p.into_inner());
        guard.clone()
    };
    let managed = [Some(snap.libmpv.clone()), snap.ytdlp.clone()].into_iter().flatten();
    for path in managed {
        if path.starts_with(&snap.install_bin) && path.is_file() {
            let _ = fs::remove_file(&path);
        }
    }
    runtime.reload();
}
