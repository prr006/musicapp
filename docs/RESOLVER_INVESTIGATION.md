# Hosted resolver investigation — 2026-09-09

## Scope and safety constraints

This investigation is limited to the provider-resolution layer. No queue code was
changed. It did not add cookies, account credentials, proxies, PO-token extraction,
missing-token formats, DRM handling, or access-control workarounds.

## Resolver paths compared

Desktop and hosted MELO do not have separate resolution algorithms:

```text
Wails App.GetPlayable ─┐
                       ├─ provider.Exec ─ media.Resolver.Resolve ─ ParseResolved
Hosted /api/v1/resolve ┘
```

Both paths use the same `internal/media/resolver.go`, the same ordered player-client
sets, the same 45-second resolution boundary, and the same progressive-format
picker. They diverge only after a successful resolution: desktop serves the chosen
upstream through `media.Proxy`; hosted web signs a capability and serves it through
`media.Streamer`. Neither downstream path runs for the failures documented here.

The subprocess invocation is also shared:

```text
yt-dlp --dump-single-json --no-playlist --no-warnings \
  --ignore-no-formats-error \
  --extractor-args youtube:player_client=<set> \
  https://www.youtube.com/watch?v=<source-id>
```

The bounded sets are tried in this order:

1. `visionos,web`
2. `android_vr`
3. `web_embedded,tv_downgraded`

## Binary/version comparison

| Runtime | Packaging | Expected version | Verified behavior |
| --- | --- | --- | --- |
| Wails desktop | checksum-verified standalone release asset from `internal/deps/manifest.json` | `2026.08.19` | Startup now executes `yt-dlp --version`, rejects a mismatch, and exposes the actual value in desktop diagnostics |
| Railway container | `pip install --no-cache-dir yt-dlp==2026.08.19` in `python:3.13-slim-bookworm` | `2026.08.19` | Startup executes `yt-dlp --version` and refuses to become healthy on a mismatch |
| Investigation sandbox | PyPI wheel installed outside the repository | `2026.08.19` | `yt-dlp --version` returned exactly `2026.08.19` |

Production `/api/v1/diagnostics` now reports:

```json
{
  "resolver": {
    "installed": true,
    "version": "2026.08.19",
    "message": "verified at startup"
  }
}
```

Therefore the Railway result is not explained by an old or unexpected yt-dlp
version. Desktop and Railway use different distributions of the same upstream
version (standalone executable versus Python wheel), but both execute the same
MELO resolver policy and yt-dlp extractor version.

## Exact affected-track metadata

The production YouTube Music search response returned these `Track` values:

| Source ID | Title | Artist | Album | Duration | Explicit |
| --- | --- | --- | --- | ---: | :---: |
| `Kx7B-XvmFtE` | Believer | Imagine Dragons | Evolve | 205 s | false |
| `9ssQKlLxBdQ` | Thunder | Imagine Dragons | Evolve | 188 s | false |
| `J1aVXLHQRd4` | Demons | Imagine Dragons | Night Visions | 176 s | false |

Believer and Thunder shared the Evolve artwork URL returned by YouTube Music:
`https://yt3.googleusercontent.com/weYQWfEwWNPOuAm34geXN1LkSYPlsJay78NnQgHC3PKsyZcdvBHIsMtqoFh3rioA4XgMdHMQd3h6vH6mbA=w544-h544-l90-rj`.
Demons returned:
`https://yt3.googleusercontent.com/q5PWa2JVJApX31A7QU2vE4RY8i5S_ofYbfpxgDjhz5fagMAxv8ROkEpUr2OAYgYrhzYqJpv0bV94DRCb=w544-h544-l90-rj`.

For all three IDs, yt-dlp itself returned parseable identity metadata on Railway:

| Source ID | `title` | `track` | `artist` | `uploader` | `album` |
| --- | --- | --- | --- | --- | --- |
| `Kx7B-XvmFtE` | Believer | Believer | Imagine Dragons | ImagineDragons | Evolve |
| `9ssQKlLxBdQ` | Thunder | Thunder | Imagine Dragons | ImagineDragons | Evolve |
| `J1aVXLHQRd4` | Demons | Demons | Imagine Dragons | ImagineDragons | Night Visions |

The resolver JSON did not contain a usable duration, availability label, or live
status for these attempts; those fields decoded to their empty/zero values.
Public YouTube metadata still describes each ID as public, embeddable,
auto-generated music from the Imagine Dragons topic catalogue. Thus catalogue
identity lookup succeeds even though playback format discovery does not.

## Exact Railway player-client outcomes

The API now distinguishes a provider-declared unavailable response from a
successful metadata response that contains no supported audio. It also returns a
sanitized attempt summary containing no URLs, headers, cookies, tokens, raw
provider payload, or user data.

Each affected ID produced the same result for every bounded client set:

```json
{
  "code": "no_supported_audio",
  "resolverAttempts": [
    {
      "clients": "visionos,web",
      "outcome": "no_supported_audio",
      "formatCount": 0,
      "formatsWithUrl": 0,
      "audioFormatsWithUrl": 0,
      "supportedProgressiveAudio": 0,
      "protocols": []
    },
    {
      "clients": "android_vr",
      "outcome": "no_supported_audio",
      "formatCount": 0,
      "formatsWithUrl": 0,
      "audioFormatsWithUrl": 0,
      "supportedProgressiveAudio": 0,
      "protocols": []
    },
    {
      "clients": "web_embedded,tv_downgraded",
      "outcome": "no_supported_audio",
      "formatCount": 0,
      "formatsWithUrl": 0,
      "audioFormatsWithUrl": 0,
      "supportedProgressiveAudio": 0,
      "protocols": []
    }
  ]
}
```

This resolves the earlier ambiguity for the failure window: these IDs did **not**
return a provider `UNAVAILABLE` class and MELO was not rejecting an otherwise
usable AAC, Opus, HLS, or DASH format. yt-dlp received enough data to emit correct
metadata, but its final format list was empty for all supported client sets.

### Same-version recovery without a resolver-policy change

After commit `74be016` redeployed the same resolver policy with only richer zero
field serialization and documentation changes, production began returning formats
again. The startup-verified yt-dlp version remained `2026.08.19`:

| ID | Recovered production result |
| --- | --- |
| `Kx7B-XvmFtE` (Believer) | `audio/webm`, 204 s, 133 kbps |
| `9ssQKlLxBdQ` (Thunder) | `audio/mp4`, 187 s, 129 kbps |
| `J1aVXLHQRd4` (Demons) | `audio/mp4`, 175 s, 129 kbps |

This recovery is decisive: no queue change, client-set change, yt-dlp upgrade,
credential, token, proxy, or format-policy change produced it. The provider began
supplying formats to a new hosted process/time window where the immediately prior
process/time window received metadata-only empty lists.

A later `856f56d` deployment, whose only runtime change removed disabled legacy
local diagnostic logging, switched Believer, Thunder, Demons, and the non-music
developer control back to the exact zero-format response above. Repeating Believer
in that same process produced zero formats again, while `dQw4w9WgXcQ` still
resolved. Startup continued to verify `2026.08.19`. Across three consecutive
process epochs, the pattern was therefore **zero formats → playable formats → zero
formats** with an unchanged resolver command and extractor version. The `856f56d`
process was in the zero-format epoch when sampled.

## Cross-content production sample

All checks used the same deployed resolver and no credentials. Results are grouped
by the current result; several controls changed class across successive Railway
deployments/probe times, which is material evidence of provider/environment
variability.

### Music IDs

| ID | Content | Failure-window result | Recovered result |
| --- | --- | --- | --- |
| `Kx7B-XvmFtE` | Imagine Dragons — Believer (Topic) | zero formats on all sets | `audio/webm`, 204 s |
| `9ssQKlLxBdQ` | Imagine Dragons — Thunder (Topic) | zero formats on all sets | `audio/mp4`, 187 s |
| `J1aVXLHQRd4` | Imagine Dragons — Demons (Topic) | zero formats on all sets | `audio/mp4`, 175 s |
| `I203G1sMGDg` | Imagine Dragons — Bad Liar | `no_supported_audio` | `audio/webm`, 261 s |
| `3Yb2-CWjrME` | Imagine Dragons — Radioactive | `no_supported_audio` | not repeated after recovery |
| `pIWaVJPl0-c` | Alan Walker — Faded | `no_supported_audio` | `audio/webm`, 212 s |
| `kJQP7kiw5Fk` | Luis Fonsi — Despacito | `no_supported_audio` | `audio/webm`, 282 s |
| `fJ9rUzIMcZQ` | Queen — Bohemian Rhapsody | `no_supported_audio` | `audio/webm`, 359 s |
| `djV11Xbc914` | a-ha — Take On Me | `no_supported_audio` | `audio/webm`, 244 s |
| `DyDfgMOUjCI` | Billie Eilish — bad guy | `no_supported_audio` | `audio/webm`, 206 s |
| `lYBUbBu4W08` | Rick Astley — Never Gonna Give You Up (Topic) | resolved, then changed to zero formats | `audio/mp4`, 214 s |
| `dQw4w9WgXcQ` | Rick Astley official video | repeatedly resolved | `audio/mp4`, 213 s |

### Non-music/control IDs

| ID | Content | Failure-window result | Recovered result |
| --- | --- | --- | --- |
| `M7lc1UVf-VE` | YouTube embedded-player developer demo | resolved, then changed to zero formats | `audio/mp4`, 1344 s |
| `YE7VzlLtp-4` | Big Buck Bunny | resolved, then changed to zero formats | `audio/webm`, 597 s |
| `ScMzIvxBSi4` | Placeholder Video | resolved, then changed to zero formats | `audio/mp4`, 94 s |
| `rfscVS0vtbw` | Python tutorial | `no_supported_audio` | `audio/mp4`, 16012 s |
| `iG9CE55wbtY` | TED talk | `no_supported_audio` | `audio/mp4`, 1203 s |
| `jNQXAC9IVRw` | Me at the zoo | `no_supported_audio` | `audio/mp4`, 19 s |
| `aqz-KE-bpKQ` | Big Buck Bunny control | `no_supported_audio` | `audio/mp4`, 635 s |

The failure was therefore neither “all music” nor a fixed list of three tracks.
It was a metadata-only provider response class affecting music and non-music IDs,
and it changed across hosted processes/time. Successful results before, during,
and after the broad failure also prove that the executable and MELO picker create
a valid `Resolved` object whenever the provider supplies formats.

## Desktop/local comparison and first divergence

The resolver implementation does **not** diverge between Wails and hosted web.
The first possible divergence is inside the same `provider.Exec.Run` call, where
yt-dlp contacts YouTube from a different outbound environment:

- Railway's failure-window process exited successfully with correct metadata but
  an empty `formats` array. Its next process returned playable formats for the
  same IDs with the same executable version and command policy.
- This investigation sandbox, running the exact `2026.08.19` wheel and exact MELO
  arguments, failed even earlier with `Unable to download API page: TLS/SSL
  connection has been closed (EOF)` for every tested client set.
- A physical end-user Wails machine uses its own network and the standalone build.
  No fresh capture from that machine was available in this session, so it would be
  incorrect to claim that the exact three IDs currently resolve there. If its
  result differs, the divergence is conclusively the yt-dlp/provider response at
  `Exec.Run`, before `ParseResolved`, proxying, streaming, player state, or queue
  state.

The first exact environment divergence observed here is therefore Railway's valid
provider JSON versus the sandbox's pre-metadata TLS EOF. That sandbox is not a
substitute for the requested physical Wails sample, so no actual desktop-versus-
Railway divergence is claimed. There is no desktop-only resolver fallback hidden
elsewhere in MELO; desktop can behave differently only because its yt-dlp packaging
and outbound provider context differ.

## Existing non-bypass alternatives in the repository

The repository contains no second playback-source provider:

- YouTube Music InnerTube search returns catalogue metadata and IDs, not a playable
  media URL.
- yt-dlp search fallback also returns catalogue entries; it does not bypass a
  zero-format player response.
- `media.Proxy` and `media.Streamer` can transport only an upstream URL already
  selected by `ParseResolved`; they cannot manufacture one.
- The signed stream endpoint deliberately accepts only the resolver-selected URL
  and provider headers. Weakening that boundary would not create missing formats.

Consequently, no existing supported, non-bypass repository strategy can resolve an
ID for which all bounded yt-dlp clients return zero formats. Adding credentials,
cookies, a proxy, token extraction, missing-token formats, or DRM handling would
violate the task constraints and was not attempted.

## Conclusion

The queue is not involved. During the failure window, the break occurred before a
`PlayableSource` existed. The affected responses were metadata-only, zero-format
yt-dlp results—not false queue promotion and not a MELO codec-selection mistake.
The sample shows a broad, variable provider response class tied to hosted outbound
process/time context, not a universal music-content rule.

The provider did not permanently refuse those IDs: without changing resolver
policy or yt-dlp version, one deployment resolved Believer, Thunder, Demons,
unrelated music, and non-music controls again. The following deployment reverted
to zero-format responses, establishing a process/time-dependent hosted environment
limitation. The last documented runtime sample (`856f56d`) was blocked for the
affected class, so an eight-audible-transition Believer browser run cannot honestly
be claimed. It must be repeated and recorded if a compliant format-serving epoch
becomes stable.
