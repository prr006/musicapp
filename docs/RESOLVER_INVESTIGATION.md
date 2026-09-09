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

This resolves the earlier ambiguity: these IDs are **not** consistently returning
a provider `UNAVAILABLE` class and MELO is not rejecting an otherwise usable AAC,
Opus, HLS, or DASH format. yt-dlp receives enough data to emit correct metadata,
but its final format list is empty for all supported client sets in the Railway
environment.

## Cross-content production sample

All checks used the same deployed resolver and no credentials. Results are grouped
by the current result; several controls changed class across successive Railway
deployments/probe times, which is material evidence of provider/environment
variability.

### Music IDs

| ID | Content | Current result |
| --- | --- | --- |
| `Kx7B-XvmFtE` | Imagine Dragons — Believer (Topic) | zero formats on all sets |
| `9ssQKlLxBdQ` | Imagine Dragons — Thunder (Topic) | zero formats on all sets |
| `J1aVXLHQRd4` | Imagine Dragons — Demons (Topic) | zero formats on all sets |
| `I203G1sMGDg` | Imagine Dragons — Bad Liar | `no_supported_audio` |
| `3Yb2-CWjrME` | Imagine Dragons — Radioactive | `no_supported_audio` |
| `pIWaVJPl0-c` | Alan Walker — Faded | `no_supported_audio` |
| `kJQP7kiw5Fk` | Luis Fonsi — Despacito | `no_supported_audio` |
| `fJ9rUzIMcZQ` | Queen — Bohemian Rhapsody | `no_supported_audio` |
| `djV11Xbc914` | a-ha — Take On Me | `no_supported_audio` |
| `DyDfgMOUjCI` | Billie Eilish — bad guy | `no_supported_audio` |
| `lYBUbBu4W08` | Rick Astley — Never Gonna Give You Up (Topic) | resolved earlier; later changed to zero formats on all sets |
| `dQw4w9WgXcQ` | Rick Astley official video | resolves (`audio/mp4`, 213 s, 129 kbps) |

### Non-music/control IDs

| ID | Content | Observed result |
| --- | --- | --- |
| `M7lc1UVf-VE` | YouTube embedded-player developer demo | resolved earlier (`audio/mp4`, 1344 s); later zero formats |
| `YE7VzlLtp-4` | Big Buck Bunny | resolved earlier (`audio/webm`, 597 s); later zero formats |
| `ScMzIvxBSi4` | Placeholder Video | resolved earlier (`audio/mp4`, 94 s); later zero formats |
| `rfscVS0vtbw` | Python tutorial | `no_supported_audio` |
| `iG9CE55wbtY` | TED talk | `no_supported_audio` |
| `jNQXAC9IVRw` | Me at the zoo | `no_supported_audio` |
| `aqz-KE-bpKQ` | Big Buck Bunny control | `no_supported_audio` |

The failure is therefore neither “all music” nor a fixed list of three tracks.
It is a provider response class affecting music and non-music IDs, with results
that can change across hosted instances/time. The one repeatedly successful music
control also proves that the executable and MELO format picker can still produce
a valid `Resolved` object when the provider supplies formats.

## Desktop/local comparison and first divergence

The resolver implementation does **not** diverge between Wails and hosted web.
The first possible divergence is inside the same `provider.Exec.Run` call, where
yt-dlp contacts YouTube from a different outbound environment:

- Railway: yt-dlp exits successfully and returns correct metadata but an empty
  `formats` array for the affected class.
- This investigation sandbox, running the exact `2026.08.19` wheel and exact MELO
  arguments, fails even earlier with `Unable to download API page: TLS/SSL
  connection has been closed (EOF)` for every tested client set.
- A physical end-user Wails machine uses its own network and the standalone build.
  No fresh capture from that machine was available in this session, so it would be
  incorrect to claim that the exact three IDs currently resolve there. If they do,
  the divergence is conclusively the yt-dlp/provider response at `Exec.Run`, before
  `ParseResolved`, proxying, streaming, player state, or queue state.

In other words, there is no desktop-only resolver fallback hidden elsewhere in
MELO. Desktop may behave differently only because its yt-dlp packaging and outbound
provider context differ; the Go resolution code and command policy are shared.

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

The queue is not involved. The failure occurs before a `PlayableSource` exists.
The affected production responses are metadata-only, zero-format yt-dlp results,
not false queue promotion and not a MELO codec-selection mistake. The sample shows
a broad, variable provider response class tied to the hosted outbound context,
not a universal music-content rule. Until YouTube supplies a supported progressive
format to one of the bounded unauthenticated clients from that environment, this is
an external provider limitation and the Believer audible-transition test remains
blocked.
