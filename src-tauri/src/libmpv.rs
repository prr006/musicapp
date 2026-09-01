//! libmpv binding, loaded at runtime — MELO's only media engine.
//!
//! Design rules (docs/ARCHITECTURE.md §"Native layer"):
//! * No subprocess, no named pipe, no JSON protocol: libmpv runs in-process
//!   and events arrive through `mpv_wait_event` on one dedicated thread.
//! * The DLL is loaded with `libloading` from an **absolute path** managed by
//!   `crate::runtime` — no import library, no build-time mpv requirement, no
//!   PATH lookup.
//! * Only the string-based subset of the client API is used (commands and
//!   string properties); observed properties use FLAG/DOUBLE/STRING formats,
//!   so `mpv_node` marshalling is never needed.
//! * libmpv stays authoritative: MELO caches the last observed values only to
//!   answer `player_get_state`; it never guesses (no watchdog, no timers).
//!
//! Threading & affinity model (the Windows startup-freeze fix, 2026-09):
//! * **Construction** — LoadLibraryW, symbol resolution, `mpv_create`,
//!   `mpv_set_option_string*`, `mpv_observe_property`, `mpv_initialize` —
//!   runs ONLY on the dedicated `melo-engine-start` thread spawned by
//!   `crate::start_engine` (never the Tauri main/UI thread). Reason:
//!   `mpv_create` starts mpv's core thread, whose pre-init playloop executes
//!   the dispatch handshake; a caller of those functions can block inside
//!   `mp_dispatch_lock` until the core thread next wakes — and pre-init, with
//!   nothing scheduled, the core parks with an INFINITE deadline. Doing this
//!   on an idle UI thread froze the whole app. A background thread that is
//!   *allowed* to block is the documented-safe arrangement; post-init the
//!   handshake concern does not exist.
//! * **Runtime calls** — `mpv_command`, `mpv_set_property_string`,
//!   `mpv_get_property_string`, `mpv_wakeup` — are made from Tauri IPC
//!   threads and the event thread interchangeably. client.h: "The client API
//!   is generally fully thread-safe, unless otherwise noted", and none of
//!   these carry a threading note.
//! * **`mpv_wait_event`** is called ONLY from the `melo-libmpv-events`
//!   thread (client.h: only one thread at a time may wait).
//! * **`mpv_terminate_destroy`** is called exactly once, from `shutdown`,
//!   AFTER the event thread was joined — by then no other thread can be
//!   inside libmpv. Shutdown cannot race initialization: a `Player` becomes
//!   visible (installed into `MeloState`) only after construction fully
//!   succeeded, and the app marks itself `exiting` before taking the engine
//!   down, so an in-flight start aborts or self-destructs instead.
//!
//! Event constants/struct layouts follow `include/mpv/client.h` from the mpv
//! repository (verified against master; the client API is ABI-stable).

use std::ffi::{c_char, c_double, c_int, c_ulong, CStr, CString};
use std::os::raw::c_void;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use libloading::Library;
use tauri::Emitter;

use crate::events;

// ---- raw client API (subset) --------------------------------------------
//
// Signatures verified against `include/mpv/client.h` @ mpv git 02a595ddc1 —
// the exact source of the pinned zhongfly runtime build (client API 2.5,
// MPV_CLIENT_API_VERSION = 0x00020005):
//   unsigned long        mpv_client_api_version(void)
//   mpv_handle          *mpv_create(void)
//   int                  mpv_initialize(mpv_handle *)
//   void                 mpv_terminate_destroy(mpv_handle *)
//   int                  mpv_command(mpv_handle *, const char **)
//   int                  mpv_set_property_string(mpv_handle *, const char *, const char *)
//   char                *mpv_get_property_string(mpv_handle *, const char *)
//   int                  mpv_set_option_string(mpv_handle *, const char *, const char *)
//   int                  mpv_observe_property(mpv_handle *, uint64_t, const char *, mpv_format)
//   mpv_event           *mpv_wait_event(mpv_handle *, double)
//   void                 mpv_wakeup(mpv_handle *)
//   void                 mpv_free(void *)
//   const char          *mpv_error_string(int)

type Handle = *mut c_void;

/// Client-API generation this binding was verified against. The DLL name
/// `libmpv-2.dll` pins the major; a different major is an ABI MELO has never
/// been validated against, so construction is refused with a clear error
/// instead of misbehaving later.
const CLIENT_API_MAJOR_EXPECTED: c_ulong = 2;
/// Minor version of client.h @ 02a595ddc1. Everything MELO uses predates it,
/// so an older DLL is accepted (with a log line); a newer one is forward-
/// compatible by mpv's ABI policy.
const CLIENT_API_MINOR_VERIFIED: c_ulong = 5;

mod event_id {
    pub const SHUTDOWN: i32 = 1;
    pub const START_FILE: i32 = 6;
    pub const END_FILE: i32 = 7;
    pub const FILE_LOADED: i32 = 8;
    pub const SEEK: i32 = 20;
    pub const PLAYBACK_RESTART: i32 = 21;
    pub const PROPERTY_CHANGE: i32 = 22;
}

mod end_reason {
    pub const EOF: i32 = 0;
    pub const STOP: i32 = 2;
    pub const QUIT: i32 = 3;
    pub const ERROR: i32 = 4;
    pub const REDIRECT: i32 = 5;
}

mod format {
    pub const STRING: i32 = 1;
    pub const FLAG: i32 = 3;
    pub const DOUBLE: i32 = 5;
}

#[repr(C)]
struct MpvEvent {
    event_id: c_int,
    error: c_int,
    reply_userdata: u64,
    data: *mut c_void,
}

#[repr(C)]
struct MpvEventProperty {
    name: *const c_char,
    format: c_int,
    data: *mut c_void,
}

/// Prefix of `mpv_event_end_file` (extra trailing fields are never read).
#[repr(C)]
struct MpvEventEndFile {
    reason: c_int,
    error: c_int,
    /// `int64_t` in client.h (id of the playlist entry this end event is
    /// about). MELO never reads it, but the layout is kept true.
    #[allow(dead_code)]
    playlist_entry_id: i64,
}

type FnVersion = unsafe extern "C" fn() -> c_ulong;
type FnCreate = unsafe extern "C" fn() -> Handle;
type FnInit = unsafe extern "C" fn(Handle) -> c_int;
type FnTerminate = unsafe extern "C" fn(Handle);
type FnCommand = unsafe extern "C" fn(Handle, *const *const c_char) -> c_int;
type FnSetPropStr = unsafe extern "C" fn(Handle, *const c_char, *const c_char) -> c_int;
type FnGetPropStr = unsafe extern "C" fn(Handle, *const c_char) -> *mut c_char;
type FnSetOptStr = unsafe extern "C" fn(Handle, *const c_char, *const c_char) -> c_int;
type FnObserve = unsafe extern "C" fn(Handle, u64, *const c_char, c_int) -> c_int;
type FnWaitEvent = unsafe extern "C" fn(Handle, c_double) -> *mut MpvEvent;
type FnWakeup = unsafe extern "C" fn(Handle);
type FnFree = unsafe extern "C" fn(*mut c_void);
type FnErrStr = unsafe extern "C" fn(c_int) -> *const c_char;

struct Api {
    _lib: Library,
    client_api_version: FnVersion,
    create: FnCreate,
    initialize: FnInit,
    terminate_destroy: FnTerminate,
    command: FnCommand,
    set_property_string: FnSetPropStr,
    get_property_string: FnGetPropStr,
    set_option_string: FnSetOptStr,
    observe_property: FnObserve,
    wait_event: FnWaitEvent,
    wakeup: FnWakeup,
    free: FnFree,
    error_string: FnErrStr,
}

impl Api {
    fn load(dll: &Path) -> Result<Self, String> {
        // Field types drive inference: each `symbol` call resolves to the
        // exact fn-pointer type declared in the struct.
        unsafe fn symbol<T: Copy>(lib: &Library, name: &[u8]) -> Result<T, String> {
            let s = unsafe { lib.get::<T>(name) }.map_err(|e| {
                format!("symbol {}: {e}", String::from_utf8_lossy(name))
            })?;
            Ok(*s)
        }
        unsafe {
            let lib = Library::new(dll)
                .map_err(|e| format!("could not load {}: {e}", dll.display()))?;
            Ok(Api {
                client_api_version: symbol(&lib, b"mpv_client_api_version")?,
                create: symbol(&lib, b"mpv_create")?,
                initialize: symbol(&lib, b"mpv_initialize")?,
                terminate_destroy: symbol(&lib, b"mpv_terminate_destroy")?,
                command: symbol(&lib, b"mpv_command")?,
                set_property_string: symbol(&lib, b"mpv_set_property_string")?,
                get_property_string: symbol(&lib, b"mpv_get_property_string")?,
                set_option_string: symbol(&lib, b"mpv_set_option_string")?,
                observe_property: symbol(&lib, b"mpv_observe_property")?,
                wait_event: symbol(&lib, b"mpv_wait_event")?,
                wakeup: symbol(&lib, b"mpv_wakeup")?,
                free: symbol(&lib, b"mpv_free")?,
                error_string: symbol(&lib, b"mpv_error_string")?,
                _lib: lib,
            })
        }
    }

    fn err_text(&self, code: c_int) -> String {
        unsafe {
            let p = (self.error_string)(code);
            if p.is_null() {
                format!("mpv error {code}")
            } else {
                CStr::from_ptr(p).to_string_lossy().into_owned()
            }
        }
    }
}

// ---- engine state (cache of observed values; libmpv is authoritative) ----

#[derive(Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineState {
    /// idle | loading | playing | paused | buffering | ended | error | dead
    pub status: &'static str,
    pub position_secs: f64,
    pub duration_secs: Option<f64>,
    pub paused: bool,
    pub buffering: bool,
    pub seeking: bool,
    pub speed: f64,
    pub volume: f64,
    pub muted: bool,
    /// Increments on every `load`; end events carry it so the app can drop
    /// stale notifications from a file that was replaced mid-play.
    pub epoch: u64,
    pub mpv_version: Option<String>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PositionUpdate {
    pub position_secs: f64,
    pub duration_secs: Option<f64>,
    pub epoch: u64,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EndOfFile {
    /// eof | stop | quit | error | redirect
    pub reason: &'static str,
    pub error: Option<String>,
    pub epoch: u64,
}

struct Inner {
    api: Api,
    ctx: Handle,
    app: tauri::AppHandle,
    epoch: AtomicU64,
    alive: AtomicBool,
    state: Mutex<EngineState>,
    /// (position, start_paused) applied right after `file-loaded`.
    pending_start: Mutex<Option<(Option<f64>, bool)>>,
}

// The mpv client API is thread-safe for commands/properties; the raw handle
// is only destroyed once, from `shutdown`, after the event thread joined.
unsafe impl Send for Inner {}
unsafe impl Sync for Inner {}

/// A running libmpv instance. Cheap to clone. The engine terminates on
/// explicit `shutdown`, or when the *last* player handle is dropped (the
/// event thread holds `Inner` but not an owner token, so it never keeps the
/// engine alive by itself).
#[derive(Clone)]
pub struct Player {
    inner: Arc<Inner>,
    thread: Arc<Mutex<Option<JoinHandle<()>>>>,
    /// Shared by player handles only (not the event thread).
    owner: Arc<()>,
}

impl Player {
    /// Load the DLL, initialize mpv, start the event thread.
    ///
    /// MUST be called from a thread that is allowed to block — never the
    /// Tauri main/UI thread (see the module header). `crate::start_engine`
    /// is the only caller and runs it on the dedicated `melo-engine-start`
    /// thread. The order below is deterministic and every step is
    /// sequential on that one thread:
    ///   1. LoadLibrary + resolve the 13 symbols     (`Api::load`)
    ///   2. gate the client-API version              (ABI check, no ctx yet)
    ///   3. `mpv_create`                             (spawns mpv's core thread)
    ///   4. `mpv_set_option_string` × 9              (pre-init, fixed order)
    ///   5. `mpv_observe_property` × 8               (pre-init, ids 1..=8)
    ///   6. `mpv_initialize`
    ///   7. read `"mpv-version"`                     (post-init only)
    ///   8. spawn `melo-libmpv-events`, publish ready
    pub fn start(
        dll: &Path,
        app: tauri::AppHandle,
        volume: f64,
        muted: bool,
        speed: f64,
    ) -> Result<Player, String> {
        let api = Api::load(dll)?;

        // ABI gate before any mpv object exists, so a wrong DLL fails with
        // an actionable message and needs no cleanup. (`c_ulong` on Windows
        // x86_64 = the header's `unsigned long`.)
        let raw_version = unsafe { (api.client_api_version)() };
        let major = (raw_version >> 16) & 0xffff;
        let minor = raw_version & 0xffff;
        if major != CLIENT_API_MAJOR_EXPECTED {
            return Err(format!(
                "libmpv reports client API {major}.{minor}, but MELO supports \
                 major 2 — {} is not a compatible libmpv-2.dll",
                dll.display()
            ));
        }
        if minor < CLIENT_API_MINOR_VERIFIED {
            eprintln!(
                "[melo] libmpv client API {major}.{minor} is older than the \
                 verified {CLIENT_API_MAJOR_EXPECTED}.{CLIENT_API_MINOR_VERIFIED}; \
                 continuing with the documented-stable subset"
            );
        }

        let ctx = unsafe { (api.create)() };
        if ctx.is_null() {
            return Err("mpv_create() returned NULL".into());
        }

        // Options must be set before mpv_initialize. Audio-only player,
        // idle keeps the engine alive between tracks, no scripts (MELO
        // resolves URLs itself — mpv's ytdl hook is never used).
        let opts: Vec<(&str, String)> = vec![
            ("idle", "yes".into()),
            ("vid", "no".into()),
            ("audio-display", "no".into()),
            ("cache", "yes".into()),
            ("load-scripts", "no".into()),
            ("demuxer-max-bytes", "64MiB".into()),
            ("volume", format!("{volume:.2}")),
            ("mute", if muted { "yes".into() } else { "no".into() }),
            ("speed", format!("{speed:.3}")),
        ];
        for (name, value) in &opts {
            let rc = unsafe {
                (api.set_option_string)(
                    ctx,
                    cstr(name).as_ptr(),
                    cstr(value).as_ptr(),
                )
            };
            if rc < 0 {
                unsafe { (api.terminate_destroy)(ctx) };
                return Err(format!("mpv option {name}={value}: {}", api.err_text(rc)));
            }
        }

        // Authoritative state: everything the UI sees arrives via these.
        let observed: &[(&str, i32)] = &[
            ("time-pos", format::DOUBLE),
            ("duration", format::DOUBLE),
            ("pause", format::FLAG),
            ("paused-for-cache", format::FLAG),
            ("seeking", format::FLAG),
            ("speed", format::DOUBLE),
            ("volume", format::DOUBLE),
            ("mute", format::FLAG),
        ];
        for (i, (name, fmt)) in observed.iter().enumerate() {
            let rc = unsafe {
                (api.observe_property)(ctx, i as u64 + 1, cstr(name).as_ptr(), *fmt)
            };
            if rc < 0 {
                unsafe { (api.terminate_destroy)(ctx) };
                return Err(format!("observe {name}: {}", api.err_text(rc)));
            }
        }

        let rc = unsafe { (api.initialize)(ctx) };
        if rc < 0 {
            unsafe { (api.terminate_destroy)(ctx) };
            return Err(format!("mpv_initialize: {}", api.err_text(rc)));
        }

        // Step 7: read the real version string only now. Pre-init,
        // `mpv-version` is not available (mpv answers
        // MPV_ERROR_INVALID_PARAMETER / NULL — the old pre-init read here
        // was a no-op at best); post-init it is an ordinary property.
        let mpv_version = unsafe {
            let p = (api.get_property_string)(ctx, cstr("mpv-version").as_ptr());
            if p.is_null() {
                None
            } else {
                let s = CStr::from_ptr(p).to_string_lossy().into_owned();
                (api.free)(p as *mut c_void);
                Some(s)
            }
        };
        eprintln!(
            "[melo] libmpv initialized: client API {major}.{minor}, {}",
            mpv_version.as_deref().unwrap_or("mpv-version unavailable")
        );

        let inner = Arc::new(Inner {
            api,
            ctx,
            app: app.clone(),
            epoch: AtomicU64::new(0),
            alive: AtomicBool::new(true),
            state: Mutex::new(EngineState {
                status: "idle",
                volume,
                muted,
                speed,
                mpv_version,
                ..EngineState::default()
            }),
            pending_start: Mutex::new(None),
        });

        let thread_inner = inner.clone();
        let handle = match std::thread::Builder::new()
            .name("melo-libmpv-events".into())
            .spawn(move || event_loop(thread_inner))
        {
            Ok(h) => h,
            Err(e) => {
                // Never leak a live mpv core when the event thread cannot
                // start: no events are consumed yet and this is the only
                // reference, so tearing the context down here is safe.
                unsafe { (inner.api.terminate_destroy)(inner.ctx) };
                return Err(format!("event thread: {e}"));
            }
        };

        let player = Player {
            inner,
            thread: Arc::new(Mutex::new(Some(handle))),
            owner: Arc::new(()),
        };
        player.publish(true);
        let _ = app.emit(
            events::RUNTIME_STATUS,
            events::RuntimeStatus {
                phase: "ready",
                message: format!("libmpv ready (client API {major}.{minor})"),
            },
        );
        Ok(player)
    }

    // ---- operations (the complete surface MELO needs) --------------------

    /// Load a file, replacing anything playing. Returns the load epoch.
    pub fn load(
        &self,
        url: &str,
        start_paused: bool,
        start_at: Option<f64>,
    ) -> Result<u64, String> {
        let epoch = self.inner.epoch.fetch_add(1, Ordering::SeqCst) + 1;
        // Start paused when a start position is given (seek after load, then
        // unpause) to avoid an audio blip at the old position.
        let load_paused = start_paused || start_at.is_some();
        *self.inner.pending_start.lock().unwrap() = Some((start_at, start_paused));
        self.set_property("pause", if load_paused { "yes" } else { "no" })?;
        self.command(&["loadfile", url, "replace"])?;
        self.with_state(|s| {
            s.status = "loading";
            s.position_secs = start_at.unwrap_or(0.0);
            s.duration_secs = None;
            s.epoch = epoch;
        });
        self.publish(false);
        Ok(epoch)
    }

    pub fn play(&self) -> Result<(), String> {
        self.set_property("pause", "no")
    }

    pub fn pause(&self) -> Result<(), String> {
        self.set_property("pause", "yes")
    }

    pub fn toggle_pause(&self) -> Result<(), String> {
        let paused = self.state().paused;
        self.set_property("pause", if paused { "no" } else { "yes" })
    }

    /// Manual stop: mpv answers with END_FILE reason STOP — MELO never
    /// auto-advances on that (queue logic distinguishes it from EOF).
    pub fn stop(&self) -> Result<(), String> {
        self.command(&["stop"])
    }

    pub fn seek_to(&self, position: f64) -> Result<(), String> {
        let pos = format!("{position:.3}");
        self.command(&["seek", &pos, "absolute"])
    }

    pub fn set_volume(&self, volume: f64) -> Result<(), String> {
        self.set_property("volume", &format!("{volume:.2}"))
    }

    pub fn set_mute(&self, muted: bool) -> Result<(), String> {
        self.set_property("mute", if muted { "yes" } else { "no" })
    }

    pub fn set_speed(&self, speed: f64) -> Result<(), String> {
        self.set_property("speed", &format!("{speed:.3}"))
    }

    /// Volume normalization (loudness evening) via libmpv's `loudnorm`
    /// audio filter. Applied live and re-applied by the app after boot.
    pub fn set_normalization(&self, on: bool) -> Result<(), String> {
        self.set_property("af", if on { "loudnorm" } else { "" })
    }

    pub fn state(&self) -> EngineState {
        self.inner.state.lock().unwrap().clone()
    }

    pub fn is_alive(&self) -> bool {
        self.inner.alive.load(Ordering::SeqCst)
    }

    pub fn shutdown(&self) {
        if !self.inner.alive.swap(false, Ordering::SeqCst) {
            return;
        }
        unsafe { (self.inner.api.wakeup)(self.inner.ctx) };
        if let Ok(mut guard) = self.thread.lock() {
            if let Some(t) = guard.take() {
                let _ = t.join();
            }
        }
        // After the event thread is joined no other code touches mpv.
        unsafe { (self.inner.api.terminate_destroy)(self.inner.ctx) };
    }

    // ---- internals --------------------------------------------------------

    fn command(&self, args: &[&str]) -> Result<(), String> {
        let inner = &self.inner;
        if !inner.alive.load(Ordering::SeqCst) {
            return Err("playback engine is not running".into());
        }
        let cstrs: Vec<CString> = args
            .iter()
            .map(|a| CString::new(*a))
            .collect::<Result<_, _>>()
            .map_err(|_| "command argument contains NUL".to_string())?;
        let mut ptrs: Vec<*const c_char> = cstrs.iter().map(|c| c.as_ptr()).collect();
        ptrs.push(std::ptr::null());
        let rc = unsafe { (inner.api.command)(inner.ctx, ptrs.as_ptr()) };
        if rc < 0 {
            Err(inner.api.err_text(rc))
        } else {
            Ok(())
        }
    }

    fn set_property(&self, name: &str, value: &str) -> Result<(), String> {
        let inner = &self.inner;
        if !inner.alive.load(Ordering::SeqCst) {
            return Err("playback engine is not running".into());
        }
        let rc = unsafe {
            (inner.api.set_property_string)(
                inner.ctx,
                cstr(name).as_ptr(),
                cstr(value).as_ptr(),
            )
        };
        if rc < 0 {
            Err(format!("property {name}: {}", inner.api.err_text(rc)))
        } else {
            Ok(())
        }
    }

    fn with_state(&self, f: impl FnOnce(&mut EngineState)) {
        let mut s = self.inner.state.lock().unwrap();
        f(&mut s);
    }

    fn publish(&self, force: bool) {
        let snapshot = self.state();
        if force || snapshot.status != "idle" {
            let _ = self.inner.app.emit(events::PLAYER_STATE, &snapshot);
        }
    }
}

impl Drop for Player {
    fn drop(&mut self) {
        // Only the last handle tears the engine down; short-lived clones
        // (e.g. held by an in-flight command) must not.
        if Arc::strong_count(&self.owner) == 1 {
            self.shutdown();
        }
    }
}

fn cstr(s: &str) -> CString {
    CString::new(s).unwrap_or_else(|_| CString::new("").unwrap())
}

// ---- event thread --------------------------------------------------------

fn event_loop(inner: Arc<Inner>) {
    let api = &inner.api;
    loop {
        if !inner.alive.load(Ordering::SeqCst) {
            break;
        }
        let ev = unsafe { (api.wait_event)(inner.ctx, 0.25) };
        if ev.is_null() {
            break;
        }
        let id = unsafe { (*ev).event_id };
        match id {
            event_id::PROPERTY_CHANGE => unsafe {
                let prop = (*ev).data as *const MpvEventProperty;
                if !prop.is_null() {
                    handle_property(&inner, &*prop);
                }
            },
            event_id::FILE_LOADED => {
                let pending = inner
                    .pending_start
                    .lock()
                    .unwrap()
                    .take();
                if let Some((start_at, start_paused)) = pending {
                    if let Some(pos) = start_at {
                        let pos_s = format!("{pos:.3}");
                        let _ = run_command(&inner, &["seek", &pos_s, "absolute"]);
                    }
                    let _ = run_command(
                        &inner,
                        &["set_property", "pause", if start_paused { "yes" } else { "no" }],
                    );
                }
                let paused = inner.state.lock().unwrap().paused;
                with_state(&inner, |s| {
                    s.status = if paused { "paused" } else { "playing" };
                });
                publish(&inner);
            }
            event_id::SEEK => {
                with_state(&inner, |s| s.seeking = true);
                publish(&inner);
            }
            event_id::PLAYBACK_RESTART => {
                // Playback actually running again (after start or seek).
                with_state(&inner, |s| {
                    s.seeking = false;
                    s.buffering = false;
                    if s.status == "loading" || s.status == "ended" {
                        s.status = if s.paused { "paused" } else { "playing" };
                    }
                });
                publish(&inner);
            }
            event_id::END_FILE => unsafe {
                let end = (*ev).data as *const MpvEventEndFile;
                let (reason, error) = if end.is_null() {
                    ("quit", None)
                } else {
                    let reason = match (*end).reason {
                        end_reason::EOF => "eof",
                        end_reason::STOP => "stop",
                        end_reason::QUIT => "quit",
                        end_reason::REDIRECT => "redirect",
                        _ => "error",
                    };
                    let error = if (*end).reason == end_reason::ERROR {
                        Some(api.err_text((*end).error))
                    } else {
                        None
                    };
                    (reason, error)
                };
                let epoch = inner.epoch.load(Ordering::SeqCst);
                with_state(&inner, |s| {
                    s.seeking = false;
                    s.buffering = false;
                    s.status = match reason {
                        "eof" => "ended",
                        "stop" | "quit" | "redirect" => "idle",
                        _ => "error",
                    };
                });
                publish(&inner);
                let _ = inner.app.emit(
                    events::PLAYER_END,
                    EndOfFile { reason, error, epoch },
                );
            },
            event_id::SHUTDOWN => {
                with_state(&inner, |s| s.status = "dead");
                publish(&inner);
                break;
            }
            _ => {}
        }
    }
}

/// Raw command access for the event thread (no alive-check needed there).
fn run_command(inner: &Inner, args: &[&str]) -> Result<(), String> {
    let cstrs: Vec<CString> = args
        .iter()
        .map(|a| CString::new(*a))
        .collect::<Result<_, _>>()
        .map_err(|_| "NUL in command".to_string())?;
    let mut ptrs: Vec<*const c_char> = cstrs.iter().map(|c| c.as_ptr()).collect();
    ptrs.push(std::ptr::null());
    let rc = unsafe { (inner.api.command)(inner.ctx, ptrs.as_ptr()) };
    if rc < 0 {
        Err(inner.api.err_text(rc))
    } else {
        Ok(())
    }
}

unsafe fn handle_property(inner: &Arc<Inner>, prop: &MpvEventProperty) {
    let name = if prop.name.is_null() {
        return;
    } else {
        CStr::from_ptr(prop.name).to_string_lossy().into_owned()
    };
    let epoch = inner.epoch.load(Ordering::SeqCst);
    match name.as_str() {
        "time-pos" => {
            if prop.format == format::DOUBLE && !prop.data.is_null() {
                let v = *(prop.data as *const f64);
                let mut s = inner.state.lock().unwrap();
                s.position_secs = v;
                s.epoch = epoch;
                let update = PositionUpdate {
                    position_secs: v,
                    duration_secs: s.duration_secs,
                    epoch,
                };
                drop(s);
                let _ = inner.app.emit(events::PLAYER_POSITION, &update);
            }
        }
        "duration" => {
            if prop.format == format::DOUBLE && !prop.data.is_null() {
                with_state(inner, |s| {
                    s.duration_secs = Some(*(prop.data as *const f64));
                    s.epoch = epoch;
                });
                publish(inner);
            }
        }
        "pause" => {
            if prop.format == format::FLAG && !prop.data.is_null() {
                let paused = *(prop.data as *const c_int) != 0;
                with_state(inner, |s| {
                    s.paused = paused;
                    if s.status == "playing" || s.status == "paused" {
                        s.status = if paused { "paused" } else { "playing" };
                    }
                    s.epoch = epoch;
                });
                publish(inner);
            }
        }
        "paused-for-cache" => {
            if prop.format == format::FLAG && !prop.data.is_null() {
                let buffering = *(prop.data as *const c_int) != 0;
                with_state(inner, |s| {
                    s.buffering = buffering;
                    if s.status == "playing" || s.status == "paused" || s.status == "buffering" {
                        s.status = if buffering {
                            "buffering"
                        } else if s.paused {
                            "paused"
                        } else {
                            "playing"
                        };
                    }
                    s.epoch = epoch;
                });
                publish(inner);
            }
        }
        "seeking" => {
            if prop.format == format::FLAG && !prop.data.is_null() {
                let seeking = *(prop.data as *const c_int) != 0;
                with_state(inner, |s| {
                    s.seeking = seeking;
                    s.epoch = epoch;
                });
                publish(inner);
            }
        }
        "speed" | "volume" | "mute" => {
            let mut s = inner.state.lock().unwrap();
            if prop.format == format::DOUBLE && !prop.data.is_null() {
                let v = *(prop.data as *const f64);
                match name.as_str() {
                    "speed" => s.speed = v,
                    "volume" => s.volume = v,
                    _ => {}
                }
            } else if prop.format == format::FLAG && !prop.data.is_null() {
                s.muted = *(prop.data as *const c_int) != 0;
            }
            s.epoch = epoch;
            // These ARE engine truth (UI slider/mute/speed must reflect the
            // actual player, e.g. after boot re-apply or a repair restart).
            publish(inner);
        }
        _ => {}
    }
}

fn with_state(inner: &Inner, f: impl FnOnce(&mut EngineState)) {
    let mut s = inner.state.lock().unwrap();
    f(&mut s);
}

fn publish(inner: &Inner) {
    let snapshot = inner.state.lock().unwrap().clone();
    let _ = inner.app.emit(events::PLAYER_STATE, &snapshot);
}

#[cfg(test)]
mod tests {
    // The FFI surface itself needs a real DLL; the pure mapping logic is
    // covered by the frontend suite against the same event semantics.
    #[test]
    fn event_constants_match_client_h() {
        // Guards against accidental drift from include/mpv/client.h.
        assert_eq!(super::event_id::END_FILE, 7);
        assert_eq!(super::event_id::FILE_LOADED, 8);
        assert_eq!(super::event_id::SEEK, 20);
        assert_eq!(super::event_id::PLAYBACK_RESTART, 21);
        assert_eq!(super::event_id::PROPERTY_CHANGE, 22);
        assert_eq!(super::end_reason::EOF, 0);
        assert_eq!(super::end_reason::STOP, 2);
        assert_eq!(super::end_reason::QUIT, 3);
        assert_eq!(super::end_reason::ERROR, 4);
        assert_eq!(super::end_reason::REDIRECT, 5);
        assert_eq!(super::format::STRING, 1);
        assert_eq!(super::format::FLAG, 3);
        assert_eq!(super::format::DOUBLE, 5);
    }

    #[test]
    fn struct_layouts_match_client_h() {
        // mpv_event @ client.h (x86_64): int + int + u64 + ptr = 24 bytes.
        assert_eq!(std::mem::size_of::<super::MpvEvent>(), 24);
        // mpv_event_property: ptr + int(+pad) + ptr = 24 bytes.
        assert_eq!(std::mem::size_of::<super::MpvEventProperty>(), 24);
        // mpv_event_end_file prefix: int + int + int64 = 16 bytes
        // (playlist_entry_id is int64_t in client.h).
        assert_eq!(std::mem::size_of::<super::MpvEventEndFile>(), 16);
    }

    #[test]
    fn client_api_gate_matches_pinned_runtime() {
        // client.h @ 02a595ddc1 (the pinned zhongfly build) is API 2.5.
        assert_eq!(super::CLIENT_API_MAJOR_EXPECTED, 2);
        assert_eq!(super::CLIENT_API_MINOR_VERIFIED, 5);
    }
}
