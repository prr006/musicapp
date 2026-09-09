# Bounded zero-format resilience — 2026-09-09

## Scope

This change is confined to `internal/media.Resolver` and sanitized hosted API
diagnostics. It does not change queue, playback cursor, radio, recommendation,
stream signing, or desktop/web state semantics. It does not add credentials,
cookies, proxies, token extraction, missing-token formats, DRM handling, or an
access-control workaround.

## Policy

The established transient condition has all of these properties:

1. the yt-dlp subprocess exits successfully;
2. its JSON is parseable and contains identity metadata;
3. `formats` has length zero; and
4. none of the existing ordered client sets resolves a playable source.

Only that condition starts another resolution round. MELO runs at most three
rounds total: the initial round, a retry after 150 ms, and a final retry after
350 ms. Every client attempt uses a fresh yt-dlp subprocess. Every round preserves
the existing order:

1. `visionos,web`
2. `android_vr`
3. `web_embedded,tv_downgraded`

Thus one logical resolution can start no more than nine subprocesses, plus only
500 ms of configured backoff. The existing request context remains authoritative
and can terminate a subprocess or backoff wait. The resolver's in-flight map
coalesces concurrent requests around the entire bounded sequence, so concurrent
callers do not multiply retries.

These conditions are deliberately not retried by the new layer:

- normal first-attempt success;
- process crash or unreadable process result;
- timeout/cancellation or provider transport failure;
- an explicit unavailable/private/removed response; or
- a non-empty format list containing no MELO-supported progressive audio.

A later playable result continues through the existing proxy/streaming path. If
all bounded rounds contain only successful zero-format responses, the public API
returns the existing sanitized `media_unavailable` result.

## Sanitized observability

Both success and failure responses expose `resolverDiagnostics`. Each subprocess
entry contains only:

- monotonic attempt number;
- configured client-set name;
- safe outcome class (`resolved`, `zero_formats`, `no_supported_audio`,
  `provider_unavailable`, `provider_network`, `provider_timeout`, or
  `resolver_process_error`);
- duration in milliseconds;
- whether it is final;
- aggregate format/URL/audio/progressive counts; and
- the set of protocol names.

The summary contains final outcome, total duration, retry-recovery status, and
cache/coalescing status. It cannot include media URLs, request headers, signed
capabilities, cookies, tokens, command stderr, or raw provider output.

## Automated coverage

The Go suite verifies:

- one all-zero round followed by a successful fresh subprocess;
- all three rounds returning zero formats and mapping to `media_unavailable`;
- normal success invoking only one subprocess;
- timeout and process failure staying distinct and receiving no zero-format retry;
- concurrent retry recovery being coalesced;
- concurrent exhausted retries starting one bounded sequence, not one per caller;
- existing normal request coalescing and cache behavior; and
- sanitized API diagnostics on success and exhaustion.

CI run `34319312872` passed Go tests, vet, server build, Windows Wails build,
frontend tests/build, and production container smoke for implementation commit
`81e1907`.

## First live Railway sample

After Railway deployed `81e1907`, ten unique, uncached music IDs were resolved.
The set contained the required three tracks and seven unrelated controls:

| ID | Track/control | Result | yt-dlp attempts | Zero-format attempts | Retry recovery |
| --- | --- | --- | ---: | ---: | :---: |
| `Kx7B-XvmFtE` | Believer | success, `audio/webm`, 204 s | 1 | 0 | no |
| `9ssQKlLxBdQ` | Thunder | success, `audio/mp4`, 187 s | 1 | 0 | no |
| `J1aVXLHQRd4` | Demons | success, `audio/mp4`, 175 s | 1 | 0 | no |
| `I203G1sMGDg` | Bad Liar | success, `audio/webm`, 261 s | 1 | 0 | no |
| `3Yb2-CWjrME` | Radioactive | success, `audio/webm`, 187 s | 1 | 0 | no |
| `pIWaVJPl0-c` | Faded | success, `audio/webm`, 212 s | 1 | 0 | no |
| `kJQP7kiw5Fk` | Despacito | success, `audio/webm`, 282 s | 1 | 0 | no |
| `fJ9rUzIMcZQ` | Bohemian Rhapsody | success, `audio/webm`, 359 s | 1 | 0 | no |
| `djV11Xbc914` | Take On Me | success, `audio/webm`, 244 s | 1 | 0 | no |
| `DyDfgMOUjCI` | bad guy | success, `audio/webm`, 206 s | 1 | 0 | no |

Totals:

- successes: **10 / 10**
- responses containing any zero-format attempt: **0 / 10**
- final zero-format responses: **0 / 10**
- retry recoveries: **0**
- final failures: **0**

Every underlying result was uncached. Two observed HTTP callers were marked
`coalesced`, meaning duplicate concurrent requests shared their one underlying
resolution as designed; they did not create additional subprocess sequences.
All ten underlying resolutions succeeded on `visionos,web`, with 41–47 formats
for the sampled videos and five supported progressive-audio candidates.

This sample does **not** demonstrate that retries materially improved success:
it landed in a provider epoch where every initial attempt already worked. It only
shows that the layer adds no unnecessary retries during a healthy epoch. A retry
recovery can be credited only when live diagnostics show one or more
`zero_formats` attempts followed by `resolved` with `recoveredAfterRetry: true`.
The earlier zero → playable → zero Railway epochs remain evidence that the
external condition is intermittent; this bounded mitigation is not described as
a provider fix.

## Second live Railway sample: zero-format epoch

The documentation deployment `27532af` started a new Railway process without
changing resolver execution policy. The same ten unique IDs were then measured
again. This process landed in the opposite provider epoch:

| ID | Track/control | Final result | Subprocess attempts | Zero-format attempts | Retry recovery |
| --- | --- | --- | ---: | ---: | :---: |
| `Kx7B-XvmFtE` | Believer | `media_unavailable` | 9 | 9 | no |
| `9ssQKlLxBdQ` | Thunder | `media_unavailable` | 9 | 9 | no |
| `J1aVXLHQRd4` | Demons | `media_unavailable` | 9 | 9 | no |
| `I203G1sMGDg` | Bad Liar | `media_unavailable` | 9 | 9 | no |
| `3Yb2-CWjrME` | Radioactive | `media_unavailable` | 9 | 9 | no |
| `pIWaVJPl0-c` | Faded | `media_unavailable` | 9 | 9 | no |
| `kJQP7kiw5Fk` | Despacito | `media_unavailable` | 9 | 9 | no |
| `fJ9rUzIMcZQ` | Bohemian Rhapsody | `media_unavailable` | 9 | 9 | no |
| `djV11Xbc914` | Take On Me | `media_unavailable` | 9 | 9 | no |
| `DyDfgMOUjCI` | bad guy | `media_unavailable` | 9 | 9 | no |

Totals for this required 10-attempt sample:

- successes: **0 / 10**
- final zero-format responses: **10 / 10**
- retry recoveries: **0**
- final failures: **10**
- zero-format subprocess outcomes: **90 / 90**
- total bounded resolution duration: approximately **12.7–15.9 seconds** per ID

Every subprocess exited successfully with correct identity metadata and zero
formats. Both retry rounds reproduced the initial result across all three client
sets. Therefore the bounded retry layer did **not** materially improve resolution
in this zero-format hosted epoch. Combined with the immediately preceding 10/10
healthy epoch, the evidence continues to classify this as an external,
process/time-dependent hosted-provider limitation. No further MELO core
architecture change is justified by these results.

## Browser playback status

HTTP resolution succeeded during the first sample, making browser playback
eligible at that time, but no controllable audio-capable browser was available in
the agent environment. The second and latest measured process failed resolution
for all ten IDs, so an actual media source was no longer available to test. HTTP
success is not a substitute for audible playback; accordingly, no audible
transition or Song Radio pass is claimed. The production browser test remains a
separate required verification if resolution becomes stable.
