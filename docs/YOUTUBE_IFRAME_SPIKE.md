# YouTube IFrame playback adapter spike

Date: 2026-09-09

## Scope and activation

This is an isolated, web-only feasibility spike. It does **not** remove or change the resolver API, signed stream routes, yt-dlp installation, container composition, or Wails desktop media path.

The default remains:

```text
MELO queue/state → PlaybackAdapter (resolved-url) → backend.getPlayable() → HTMLAudioElement
```

Opt in on a hosted or local web build by adding `?player=youtube` to the app URL, or build with `VITE_MELO_YOUTUBE_IFRAME_SPIKE=1`:

```text
MELO queue/state → PlaybackAdapter (youtube-video-id) → visible official YT.Player
```

The query flag is ignored in Wails. In IFrame mode, `PlaybackController` passes `track.sourceId || track.id` directly to the adapter and does not call `backend.getPlayable()` or prefetch playable URLs. Search, queue selection, explicit/discovery ordering, Song Radio refill, history, lyrics, likes, and session code remain shared.

The one persistent official player is mounted in the main shell. Its viewport is 480×270 when space allows and never less than 200×200. It is not hidden, off-screen, covered by MELO UI, or presented as audio-only. Native YouTube controls, video, branding, ads, and provider interaction remain intact.

## Transaction boundary

The existing provisional-selection transaction is unchanged:

1. The queue controller calls `beginLoad(track.id)` and leaves `current`, explicit cursor, and discovery consumption uncommitted.
2. Resolved-URL mode awaits `backend.getPlayable(track)`; IFrame mode selects `track.sourceId || track.id` locally.
3. The selected adapter starts its media source.
4. Only a confirmed HTML media `play()` or YouTube `PLAYING` event resolves `load(..., autoplay=true)` successfully.
5. The controller then commits current track, queue cursor/source, metadata, history, lyrics, and refill work.
6. A failed candidate removes only itself and the canonical explicit-first selection policy chooses the next candidate.
7. Generation checks reject stale resolver/provider events after rapid switching.

If browser policy explicitly blocks autoplay, the IFrame adapter emits `autoplay-blocked`, keeps the candidate provisional without a timeout, and waits for a user to press Play in the visible native player (or choose another track). It does not misclassify the track as unembeddable. A separate 30-second startup timeout applies only when the provider produces neither `PLAYING` nor an explicit autoplay-blocked event.

## Complete IFrame event mapping

### Lifecycle and state

| YouTube event/state | Value | MELO mapping | Transaction effect |
|---|---:|---|---|
| `onReady` | — | No public engine state; applies stored volume, mute, and rate | Makes the adapter ready to accept a source ID |
| `onStateChange: UNSTARTED` | `-1` | `state(snapshot.status = loading)` | Candidate remains provisional |
| `onStateChange: ENDED` | `0` | Paused snapshot, then one `ended(trackId)` per playback cycle | Existing ended handler applies repeat or canonical next selection |
| `onStateChange: PLAYING` | `1` | `state(playing)` and 250 ms position polling | Resolves an autoplay load `true`; controller can commit candidate |
| `onStateChange: PAUSED` | `2` | `state(paused)` | Current track/cursor remain unchanged |
| `onStateChange: BUFFERING` | `3` | `state(loading)` | Candidate remains provisional, or committed current reports loading |
| `onStateChange: CUED` | `5` | `state(paused)` for a non-autoplay load | Resolves only a deliberate `autoplay=false` cue; normal queue starts still wait for `PLAYING` |
| `onAutoplayBlocked` | — | `autoplay-blocked(trackId)` plus paused provider snapshot | Candidate stays provisional; UI asks for interaction in the visible player |
| `onPlaybackRateChange` | numeric rate | Updates adapter snapshot rate and emits `state` | Keeps MELO speed state aligned with a provider-confirmed rate |
| `onPlaybackQualityChange` | quality string | Observed no-op | MELO has no video-quality domain state; native player remains authoritative |
| `onApiChange` | — | Observed no-op | No relevant MELO transport state |

Position polling reads `getCurrentTime()`, `getDuration()`, and `getVideoLoadedFraction()` while playing and maps them to existing `position`, duration, and buffered state. Pause, play, seek, volume, mute, and playback rate map to `pauseVideo`, `playVideo`, `seekTo`, `setVolume`, `mute`/`unMute`, and `setPlaybackRate` respectively.

### Provider errors

All errors are sanitized before entering MELO state. They are non-recoverable by the same IFrame instance for that candidate, so the queue controller removes only that candidate and continues in canonical order where possible.

| YouTube error | Meaning presented to MELO |
|---:|---|
| `2` | YouTube rejected the video ID |
| `5` | YouTube could not play the video in an HTML5 player |
| `100` | Video is private, removed, or unavailable |
| `101` | Owner does not allow embedding |
| `150` | Owner does not allow embedding (same treatment as 101) |
| `153` | Embedding site could not be identified; check origin/referrer policy |
| other | Generic YouTube playback failure containing only the numeric code |

## Required source IDs

The spike panel includes direct buttons for these exact catalog/provider IDs:

| Track | `Track.sourceId` | 2026-09-09 oEmbed preflight |
|---|---|---|
| Imagine Dragons — Believer | `Kx7B-XvmFtE` | Metadata returned |
| Imagine Dragons — Thunder | `9ssQKlLxBdQ` | Metadata returned |
| Imagine Dragons — Demons | `J1aVXLHQRd4` | Metadata returned |

The hosted Song Radio endpoint was also queried for the Believer seed on 2026-09-09. It returned six candidates: `Kx7B-XvmFtE`, `9ssQKlLxBdQ`, `3Yb2-CWjrME`, `n5lmg1MX_sE`, `YI1XZfBTWGc`, and `6I2y_UbVz4U`. Every ID returned oEmbed metadata; no required or sampled radio ID failed this metadata preflight. None is therefore reported as known-unembeddable yet.

An oEmbed response confirms the IDs and public metadata, not autoplay, IFrame API behavior, embedding permission at playback time, or audibility. Only an actual IFrame error 101/150 run can establish that a candidate is unembeddable.

## Evidence

### Automated

- Fake `YT.Player` adapter tests cover visible mount creation, source-ID load, buffering/playing/paused mapping, play, pause, seek, volume, mute, provider-confirmed rate, position, natural-ended de-duplication, cueing, autoplay-blocked behavior, all documented embed errors, and rapid-switch stale-event rejection.
- Playback-controller tests run the existing current-track transaction in source-ID mode and assert that the resolver is never called.
- The existing Song Radio test now runs eight consecutive transitions in source-ID mode using Believer, Thunder, Demons, and a syntactically valid candidate set. It verifies current-track/cursor commits, an eight-item refill buffer, canonical-title de-duplication, and zero resolver calls.
- The full pre-existing queue suite continues to cover explicit-before-discovery priority, failed-candidate-only removal, refill, prefetch isolation in resolved-URL mode, repeat, shuffle, ended-once handling, and rapid changes.

Automated provider `PLAYING` events prove event translation, not that a human heard sound.

### Real-browser matrix

Do not mark a row passed from unit tests, oEmbed, network responses, or the counter in the spike UI. `PLAYING events` is deliberately labelled as instrumentation rather than audibility proof.

| Check | Actual browser result | Unembeddable IDs |
|---|---|---|
| Believer play, pause, seek, volume | Pending direct observation | None established |
| Thunder direct transition | Pending direct observation | None established |
| Demons direct transition | Pending direct observation | None established |
| Autoplay from initial user gesture | Pending direct observation | N/A |
| Autoplay-blocked path without gesture | Pending direct observation | N/A |
| Natural end and exactly-one advance | Pending direct observation | None established |
| At least eight consecutive audible Song Radio transitions | Pending direct observation | None established |

The agent environment does not currently contain a runnable browser, and Chromium download previously failed with a TLS connection reset. Therefore this document does **not** claim browser audibility or eight real provider transitions. The visible spike surface and event/error counters are included so that the matrix can be completed honestly in a real browser before any production migration decision.

## Manual browser procedure

1. Open the web app with `?player=youtube`; confirm a visible native player is present at compliant size.
2. Press **Believer**. If autoplay is blocked, press Play inside the native player. Confirm sound personally before recording success.
3. Use MELO pause/play, scrubber seek, mute, and volume; confirm both visible video and heard audio follow.
4. Press **Thunder**, then **Demons**; record any error code/message and ID rather than silently retrying it.
5. Let one track end naturally; verify current track and queue cursor advance once.
6. Press **Believer Song Radio**. Count eight consecutive transitions only when each is personally heard. Record every candidate ID that reports errors 100, 101, or 150.
7. During the run, add an explicit queue item and verify it plays before discovery; remove one discovery item and verify no other item/cursor changes; inspect that refill returns the discovery buffer to its target.
8. Repeat once in a fresh browser context without a prior gesture to exercise `onAutoplayBlocked`, then interact with the visible player and verify the same provisional candidate commits on `PLAYING`.

## Decision gate

This spike justifies a production migration only after the real-browser matrix has named evidence for all required controls and eight audible radio transitions, with an acceptable observed embed-failure rate. Until then, the resolved-stream implementation remains the default and no backend cleanup should begin.
