import { useMemo } from 'react'
import { MediaCard } from '../components/MediaCard'
import { EmptyState } from '../components/States'
import { TrackRow } from '../components/TrackRow'
import { HomeIcon, RadioIcon, SearchIcon } from '../components/Icons'
import { primaryArtist } from '../lib/derive'
import { relativeTime } from '../lib/format'
import { mostPlayed } from '../lib/taste'
import { useLibraryStore } from '../state/libraryStore'
import { playback } from '../state/playback'
import { search } from '../state/searchStore'
import { ui } from '../state/uiStore'

/** Radio mixes need a few seeds to be worth starting. */
const MIN_RADIO_SEEDS = 3

export function HomeView() {
  const history = useLibraryStore((s) => s.history)
  const stats = useLibraryStore((s) => s.stats)
  const liked = useLibraryStore((s) => s.liked)
  const playlists = useLibraryStore((s) => s.playlists)
  const searchHistory = useLibraryStore((s) => s.searchHistory)

  const recent = useMemo(() => {
    const seen = new Set<string>()
    return history.filter((h) => (seen.has(h.track.id) ? false : (seen.add(h.track.id), true))).slice(0, 12)
  }, [history])

  // The whole local library (same derivation the Library page uses).
  const allTracks = useMemo(() => {
    const seen = new Set<string>()
    const out = []
    for (const t of [...liked, ...playlists.flatMap((p) => p.tracks), ...history.map((h) => h.track)]) {
      if (seen.has(t.id)) continue
      seen.add(t.id)
      out.push(t)
    }
    return out
  }, [liked, playlists, history])

  const quickPicks = useMemo(() => mostPlayed(history, stats, 8).filter((t) => t.playCount > 1), [history, stats])

  // "Because you listened to …" — the most-played primary artist in the
  // recent listening window; pure view-level derivation from history.
  const recentArtist = useMemo(() => {
    const counts = new Map<string, { count: number; tracks: typeof history }>()
    for (const record of history.slice(0, 80)) {
      const name = primaryArtist(record.track.artist || '')
      if (!name) continue
      const entry = counts.get(name) ?? { count: 0, tracks: [] }
      entry.count += 1
      if (!entry.tracks.some((t) => t.track.id === record.track.id)) entry.tracks.push(record)
      counts.set(name, entry)
    }
    let best: { artist: string; tracks: typeof history } | null = null
    for (const [artist, entry] of counts) {
      if (entry.count >= 3 && (!best || entry.count > counts.get(best.artist)!.count)) {
        best = { artist, tracks: entry.tracks }
      }
    }
    return best
  }, [history])

  const hour = new Date().getHours()
  const greeting = hour < 5 ? 'Late night' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'

  const nothingYet = recent.length === 0 && liked.length === 0 && playlists.length === 0 && searchHistory.length === 0

  return (
    <div className="page">
      <div className="page-header">
        <div className="eyebrow">{new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</div>
        <h1>{greeting}</h1>
      </div>

      {nothingYet && (
        <EmptyState
          icon={<HomeIcon size={20} />}
          title="Your library starts here"
          message="Search for a song and press play. Everything you listen to, like or save shows up on this page."
          action={
            <button className="btn primary" onClick={() => ui.navigate({ name: 'search' })} type="button">
              <SearchIcon size={16} /> Start searching
            </button>
          }
        />
      )}

      {quickPicks.length > 0 && (
        <section className="section">
          <div className="section-head">
            <h2>Quick picks</h2>
            <button className="link" onClick={() => ui.navigate({ name: 'library', tab: 'most-played' })} type="button">
              See all
            </button>
          </div>
          <div className="scroll-row cards">
            {quickPicks.slice(0, 8).map((entry) => (
              <MediaCard
                key={entry.track.id}
                title={entry.track.title}
                subtitle={`${entry.playCount} plays`}
                artwork={entry.track.artwork}
                onOpen={() =>
                  void playback.play(entry.track, {
                    tracks: quickPicks.map((t) => t.track),
                    label: 'Quick picks',
                  })
                }
                onPlay={() =>
                  void playback.play(entry.track, {
                    tracks: quickPicks.map((t) => t.track),
                    label: 'Quick picks',
                  })
                }
              />
            ))}
          </div>
        </section>
      )}

      {recent.length > 0 && (
        <section className="section">
          <div className="section-head">
            <h2>Recently played</h2>
            <button className="link" onClick={() => ui.navigate({ name: 'library', tab: 'recent' })} type="button">
              See all
            </button>
          </div>
          <div className="scroll-row cards">
            {recent.slice(0, 8).map((record) => (
              <MediaCard
                key={record.track.id}
                title={record.track.title}
                subtitle={relativeTime(record.playedAt)}
                artwork={record.track.artwork}
                onOpen={() => void playback.play(record.track, { tracks: recent.map((r) => r.track), label: 'Recently played' })}
                onPlay={() => void playback.play(record.track, { tracks: recent.map((r) => r.track), label: 'Recently played' })}
              />
            ))}
          </div>
        </section>
      )}

      {(liked.length >= MIN_RADIO_SEEDS || allTracks.length >= MIN_RADIO_SEEDS) && (
        <section className="section">
          <div className="section-head">
            <h2>Made for you</h2>
          </div>
          <div className="mix-grid">
            {liked.length >= MIN_RADIO_SEEDS && (
              <button
                className="mix-card"
                onClick={() => void playback.startListRadio(liked, 'Liked Songs')}
                type="button"
              >
                <span className="mix-glyph warm">
                  <RadioIcon size={18} />
                </span>
                <span className="mix-text">
                  <span className="mix-title">Liked Songs Radio</span>
                  <span className="mix-sub">Endless mix from the {liked.length} songs you've liked</span>
                </span>
              </button>
            )}
            {allTracks.length >= MIN_RADIO_SEEDS && (
              <button
                className="mix-card"
                onClick={() => void playback.startListRadio(allTracks, 'Your Library')}
                type="button"
              >
                <span className="mix-glyph">
                  <RadioIcon size={18} />
                </span>
                <span className="mix-text">
                  <span className="mix-title">Your Library Radio</span>
                  <span className="mix-sub">Everything you play, like and save, shuffled endlessly</span>
                </span>
              </button>
            )}
          </div>
        </section>
      )}

      {liked.length > 0 && (
        <section className="section">
          <div className="section-head">
            <h2>Your favorites</h2>
            <button className="link" onClick={() => ui.navigate({ name: 'library', tab: 'liked' })} type="button">
              See all
            </button>
          </div>
          <div className="track-list">
            {liked.slice(0, 5).map((track, i) => (
              <TrackRow
                key={track.id}
                track={track}
                index={i}
                onPlay={() => void playback.play(track, { tracks: liked, index: i, label: 'Liked Songs' })}
              />
            ))}
          </div>
        </section>
      )}

      {recentArtist && recentArtist.tracks.length > 0 && (
        <section className="section">
          <div className="section-head">
            <h2>Because you listened to {recentArtist.artist}</h2>
            <button className="link" onClick={() => ui.navigate({ name: 'artist', artist: recentArtist.artist })} type="button">
              See artist
            </button>
          </div>
          <div className="track-list">
            {recentArtist.tracks.slice(0, 5).map((record, i) => (
              <TrackRow
                key={record.track.id}
                track={record.track}
                index={i}
                onPlay={() =>
                  void playback.play(record.track, {
                    tracks: recentArtist.tracks.map((r) => r.track),
                    index: i,
                    label: recentArtist!.artist,
                  })
                }
              />
            ))}
          </div>
        </section>
      )}

      {playlists.length > 0 && (
        <section className="section">
          <div className="section-head">
            <h2>Your playlists</h2>
            <button className="link" onClick={() => ui.navigate({ name: 'library', tab: 'playlists' })} type="button">
              See all
            </button>
          </div>
          <div className="scroll-row cards">
            {playlists.slice(0, 8).map((pl) => (
              <MediaCard
                key={pl.id}
                title={pl.name}
                subtitle={`${pl.tracks.length} song${pl.tracks.length === 1 ? '' : 's'}`}
                artwork={pl.tracks[0]?.artwork}
                onOpen={() => ui.navigate({ name: 'playlist', id: pl.id })}
                onPlay={pl.tracks.length > 0 ? () => void playback.playAll(pl.tracks, pl.name) : undefined}
              />
            ))}
          </div>
        </section>
      )}

      {searchHistory.length > 0 && (
        <section className="section">
          <div className="section-head">
            <h2>Recent searches</h2>
          </div>
          <div className="tabs">
            {searchHistory.slice(0, 10).map((term) => (
              <button
                key={term}
                className="chip"
                type="button"
                onClick={() => {
                  ui.navigate({ name: 'search' })
                  void search.run(term)
                }}
              >
                <SearchIcon size={13} /> {term}
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
