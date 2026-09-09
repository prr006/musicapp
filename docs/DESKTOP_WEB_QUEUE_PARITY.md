# Desktop/web queue parity baseline

Date: 2026-09-09

## Finding: there are not two queue implementations

The Wails desktop build and hosted React web build already render the same frontend and import the same queue/state files:

- `frontend/src/state/playerStore.ts` owns `current`, explicit `queue`, discovery `autoQueue`, `index`, `playingFrom`, shuffle, and repeat.
- `frontend/src/domain/queueEngine.ts` is the pure canonical selection/order policy.
- `frontend/src/state/playback.ts` is the only queue/playback controller.
- `frontend/src/components/QueuePanel.tsx`, `MiniPlayer.tsx`, and `NowPlaying.tsx` render the same state in both builds.

There is no independent Go or Wails queue engine. Go persists the shared session shape and supplies backend capabilities; it does not choose next/previous tracks. Therefore “make desktop canonical” means preserve the behavior of this shared controller rather than copy a second implementation into web.

## Canonical behavior observed side by side

| Behavior | Desktop Wails | Web IFrame spike | Canonical rule |
|---|---|---|---|
| Current track/index | Shared `playerStore` | Same store | Candidate stays provisional; commit `current` and explicit `index` only after actual transport start succeeds |
| Queue ordering | Shared `queueEngine` | Same engine | Explicit upcoming entries (`index + 1…`) precede discovery entries |
| Next | Shared `selectNextTrack` | Same function | Next explicit; repeat-all wrap for an explicit session; then discovery when autoplay is enabled |
| Previous | Shared controller | Same controller | Restart after 3 seconds; otherwise previous explicit entry; repeat-all may wrap to final explicit entry |
| Natural end | Shared controller event path | IFrame maps `ENDED` into that path | Exactly one advance per playback cycle/generation; repeat-one restarts instead |
| Radio tracks | Shared `autoQueue` and refill | Same | Radio/discovery stays distinct from explicit queue, appends without replacing its existing prefix, and refills toward 8 at/below the threshold of 5 |
| Manual add/play-next/remove/reorder | Shared controller | Same | Mutate explicit queue only; adjust index around removals/reorders; do not consume discovery accidentally |
| Replay current | Shared repeat-one/restart path | Same path | Seek to zero and replay through the active adapter without rebuilding the queue |
| Unavailable media/embed | Shared failed-candidate policy | Same policy | Remove only the failed explicit/discovery candidate; preserve all others; select again in canonical order |
| Mutation during playback | Shared store/controller | Same | Never yank the current track; explicit entries added while discovery plays still receive priority |
| UI consistency | Shared store | Same store | Metadata is committed only after adapter start confirmation; provisional/stale events cannot replace current UI state |
| Shuffle/repeat | Shared controller | Same | Shuffle changes upcoming explicit ordering; repeat-one restarts; repeat-all wraps explicit queue before discovery |
| Play a new track | Shared `play` transaction | Same | A deliberate play-now starts a new one-track session; a context play uses that context; loading itself must not reset a prepared context |
| Competing transitions | Shared generation and intent guards | Same | A later play/next/radio intent supersedes earlier async work; ended is handled once |

## Difference found after the initial IFrame spike

Queue semantics are shared, but the first adapter seam leaked transport selection back into `PlaybackController`:

```text
PlaybackController
  ├─ if resolved URL: backend.getPlayable(track)
  └─ if YouTube:      track.sourceId
```

The controller also knew that only resolved URLs should be prefetched/invalidated. This did not duplicate queue order, but it violated the desired boundary and made future transport changes capable of creating web-only queue branches.

The minimum correction is:

```text
PlaybackController → PlaybackAdapter.load(track) → actual player
```

- `PlaybackController` passes a `Track`, generation, start position, and autoplay intent only.
- `ResolvedUrlPlaybackAdapter` owns resolver/prefetch/invalidation/reporting and delegates media operations to the existing `PlaybackEngine`/`HTMLAudioElement` for desktop and the preserved default path.
- `YouTubeIframePlaybackAdapter` owns `Track.sourceId` selection and drives the one visible `YT.Player`; it has no resolver, stream, or media-URL dependency.
- Queue selection, commit, skip, refill, explicit/discovery priority, next/previous, repeat, and shuffle remain transport-agnostic and unchanged.

This is an adapter-boundary correction, not a second queue rewrite and not backend cleanup.

## Realistic parity test flow

The automated parity flow must exercise the same controller with a fake source-ID/IFrame transport:

1. Play and commit one track.
2. Add several explicit tracks without changing current.
3. Select next and commit the correct explicit index.
4. Emit natural end twice and prove only one advance occurs.
5. Start Song Radio and complete at least eight source-ID transitions with refill.
6. Remove and add entries while playback is active without changing actual/current track.
7. Fail one provider candidate and prove only that candidate disappears.
8. Exercise repeat-one, repeat-all, shuffle, and a rapid competing play.
9. At each committed `PLAYING`, assert UI `current.id` equals the fake provider player's active track ID.

Existing tests already cover these rules individually. The adapter refactor should add one end-to-end source-ID flow and keep the entire existing desktop/resolved suite passing.
