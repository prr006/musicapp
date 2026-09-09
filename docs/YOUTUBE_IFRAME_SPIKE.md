# YouTube IFrame playback adapter validation

Date: 2026-09-09

## Scope and activation

This is an isolated, web-only playback path. It does **not** remove or change the resolver API, signed stream routes, yt-dlp installation, container composition, or Wails desktop media path.

The default remains:

```text
Melo UI → PlaybackController → ResolvedUrlPlaybackAdapter → backend.getPlayable() → HTMLAudioElement
```

Opt in on a hosted or local web build with `?player=youtube`, or build with `VITE_MELO_YOUTUBE_IFRAME_SPIKE=1`:

```text
Melo UI → PlaybackController → YouTubeIframePlaybackAdapter → visible official YT.Player
```

The query flag is ignored in Wails. `PlaybackController` always gives the selected adapter the same domain `Track`. The IFrame adapter selects `track.sourceId || track.id` internally and has no `backend.getPlayable()`, playable-prefetch, `/resolve`, `/stream`, or resolved-media-URL dependency. Search, explicit/discovery ordering, radio refill, history, lyrics, likes, and session code remain shared.

## Player presentation

There is one persistent official provider surface, integrated into Melo's Now Playing experience:

- Expanded Now Playing places the video beside Melo artwork and metadata.
- Closing expanded Now Playing retains the same keyed player in a compact dock; it does not destroy and recreate the active playback engine.
- The visible viewport is 200×200, including on the compact surface. It is not hidden, off-screen, covered, 1px-sized, or presented as background/audio-only playback.
- The official IFrame remains the real playback engine. Provider video, branding, overlays, ads, and provider interaction remain visible.
- `controls: 0`, `disablekb: 1`, and `fs: 0` avoid presenting a second full transport set. Melo artwork, progress, play/pause, seek, volume, mute, speed, next, queue, and repeat remain the primary controls and drive `YT.Player` through the adapter.
- Provider-required overlays may still appear; Melo does not cover or attempt to suppress them.

The old standalone 480×270 spike dashboard, direct source-ID buttons, duplicate transport buttons, and event counters are no longer rendered.

## Transaction boundary

The provisional-selection transaction is shared by both adapters:

1. The controller calls `beginLoad(track.id)` and leaves `current`, explicit cursor, and discovery consumption uncommitted.
2. It calls `adapter.load(token, track, startAt, autoplay)` without inspecting transport type.
3. The selected adapter starts its actual player.
4. Only confirmed HTML media `play()` or YouTube `PLAYING` resolves an autoplay load successfully.
5. The controller then commits current track, queue cursor/source, metadata, history, lyrics, and refill work.
6. A failed candidate removes only itself; canonical explicit-first selection chooses the next candidate.
7. Generation and intent checks reject stale resolver, radio, or provider events after rapid switching.

If browser policy reports `onAutoplayBlocked`, the IFrame adapter emits `autoplay-blocked`, keeps the candidate provisional, and waits for interaction with the visible provider. It does not misclassify the track as unembeddable. A separate 30-second startup timeout applies only when the provider emits neither `PLAYING` nor an explicit autoplay-blocked event.

## IFrame event mapping

| YouTube event/state | Value | Melo mapping |
|---|---:|---|
| `onReady` | — | Applies stored volume, mute, and rate; adapter is ready for an ID |
| `UNSTARTED` | `-1` | Loading; candidate remains provisional |
| `ENDED` | `0` | One canonical `ended(trackId)` per playback cycle |
| `PLAYING` | `1` | Playing; resolves pending autoplay load and begins 250 ms position polling |
| `PAUSED` | `2` | Paused; current track/cursor remain unchanged |
| `BUFFERING` | `3` | Loading/buffering |
| `CUED` | `5` | Paused; resolves only a deliberate `autoplay=false` cue |
| `onAutoplayBlocked` | — | Paused provider snapshot plus `autoplay-blocked(trackId)` |
| `onPlaybackRateChange` | numeric rate | Provider-confirmed Melo rate state |
| `onPlaybackQualityChange` / `onApiChange` | — | Observed no-op; no matching Melo domain state |

Position polling reads `getCurrentTime()`, `getDuration()`, and `getVideoLoadedFraction()`. Melo commands map to `playVideo`, `pauseVideo`, `seekTo`, `setVolume`, `mute`/`unMute`, and `setPlaybackRate`.

## Provider errors

Errors are sanitized before entering Melo state. The queue controller removes only the failed candidate and continues in canonical order where possible.

| YouTube error | Meaning presented to Melo |
|---:|---|
| `2` | YouTube rejected the video ID |
| `5` | YouTube could not play the video in an HTML5 player |
| `100` | Video is private, removed, or unavailable |
| `101` / `150` | Owner does not allow embedding |
| `153` | Embedding site could not be identified; check origin/referrer policy |
| other | Generic YouTube playback failure containing only the numeric code |

## Automated evidence

- Fake-`YT.Player` adapter tests cover visible mount creation, ID loading, buffering/playing/paused mapping, play, pause, seek, volume, mute, rate, position, natural-ended de-duplication, cueing, autoplay-blocked behavior, documented embed errors, and stale-event rejection.
- Adapter configuration assertions cover `controls: 0`, `disablekb: 1`, and `fs: 0`.
- A real-`PlaybackController`/fake-`YT.Player` flow covers explicit additions, next, automatic advance, active queue mutations, Song Radio, explicit-over-discovery priority, candidate error 101, repeat-one, competing plays, and committed UI/provider-ID alignment.
- Source-ID controller tests assert zero `backend.getPlayable()` calls.
- Radio controller tests cover eight source-ID transitions and a separate fifteen-track incremental stream. The fifteen observed tracks contain at least seven normalized primary artists, no artist contributes more than two in that finite batch, the visible buffer never has more than two tracks from one artist, and no resolver call occurs.
- Queue/domain tests cover exact explicit ordering and priority, current/discovery artist occupancy, bounded low-water refill, title/ID deduplication, and failed-candidate-only removal.

Automated `PLAYING` events prove event translation, not audible output or live provider reliability.

## Real-browser evidence

Evidence from the previously deployed large spike surface:

| Check | Actual browser result |
|---|---|
| Believer, Thunder, and Demons playback | User reported the visible videos playing correctly |
| At least eight consecutive audible Song Radio transitions | Passed by direct user observation |
| Play/pause, seek, and volume as separate checks | Not separately itemized; automated mapping passed |
| Autoplay-blocked path without gesture | Not separately reported |

The compact integrated surface and new diversified 10–15-track production radio response have not yet been browser-verified. An oEmbed response confirms public metadata, not autoplay, audibility, embed permission at playback time, or controls.

## Required manual validation

1. Open the app with `?player=youtube` and start a normal track.
2. Confirm one coherent Melo player and one visible 200×200 official provider viewport, first expanded and then in the compact dock.
3. Use Melo play/pause, scrubber seek, volume, mute, and speed; verify the visible provider and heard output follow.
4. In DevTools Network, confirm playback does not call `/resolve`, `/stream`, or any resolved-media endpoint.
5. Add at least two explicit tracks, start Song Radio, and confirm explicit items retain exact order and play before discovery.
6. Record 10–15 generated recommendation titles/artists/IDs. Confirm there is no single-artist discography dump or long same-artist run.
7. Let several tracks end naturally. Confirm refill occurs in small top-ups (discovery is normally five to eight ready entries), not as a large visible dump.
8. During transitions, compare Melo current track, queue source, and the visible YouTube video. They must identify the same track after each committed `PLAYING`.
9. Record any provider error with the source ID and numeric code rather than silently treating it as success.
10. Repeat in a fresh browser context to exercise autoplay-blocked behavior and verify interaction with the visible provider can complete the provisional selection.

Do not make the IFrame adapter the default or begin backend cleanup until the compact UX and the full control/radio matrix above have direct browser evidence.
