# Third-party components & licenses

MELO downloads its runtime at first launch — nothing below is bundled into
or redistributed by this repository. Pins and SHA-256 digests are enforced
in `src-tauri/src/runtime.rs`.

| Component | Version / pin | License | How MELO uses it |
|---|---|---|---|
| libmpv (`libmpv-2.dll`, from zhongfly/mpv-winbuild) | `2026-08-31-02a595ddc1` | mpv is **GPL-2.0-or-later** (this is the full/GPL dev build, not the `-lgpl` variant) | Dynamically loaded at runtime via `libloading`; never bundled, never modified — downloaded verbatim from the upstream release. MELO itself calls the documented C client API and is an independent work. |
| yt-dlp (`yt-dlp.exe`) | `2026.08.19` | **Unlicense** (public domain) | Spawned as a subprocess for search + stream resolution only |
| 7-Zip `7zr.exe` (ip7z/7zip) | `26.02` | **LGPL-2.1** (+ BSD-3-Clause for some code, unRAR restriction) | Used once to extract the libmpv archive |
| ureq | 2.x | **MIT OR Apache-2.0** | HTTP client (runtime downloads, LRCLIB) |
| Tauri 2 / React / Vite / Vitest | — | MIT (Tauri: MIT/Apache-2.0) | App framework, UI, tooling (see package.json) |
| LRCLIB (lrclib.net) | — | Service, CC0 data; comply with their API etiquette | Lyrics provider with local cache |
| melo-core crate (in-repo) | — | Same as MELO (see LICENSE) | Pure domain logic |

Note on the GPL libmpv build: MELO does not compile against, statically
link, or redistribute mpv sources or binaries — it loads the unmodified
`libmpv-2.dll` from the user's own disk at runtime, exactly like other
desktop front-ends (e.g. Plex for Windows uses this same artifact). If a
fully LGPL engine is ever required, switch the asset picker to the
`-lgpl` build in `runtime.rs` (it exists in the same release).
