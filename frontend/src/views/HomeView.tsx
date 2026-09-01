import { useMemo } from 'react'
import { MediaCard } from '../components/MediaCard'
import { EmptyState } from '../components/States'
import { TrackRow } from '../components/TrackRow'
import { HomeIcon, SearchIcon } from '../components/Icons'
import { deriveAlbums } from '../lib/derive'
import { relativeTime } from '../lib/format'
import { useLibraryStore } from '../state/libraryStore'
import { playback } from '../state/playback'
import { search } from '../state/searchStore'
import { ui } from '../state/uiStore'

export function HomeView() {
  const history = useLibraryStore((s) => s.history)
  const liked = useLibraryStore((s) => s.liked)
  const playlists = useLibraryStore((s) => s.playlists)
  const searchHistory = useLibraryStore((s) => s.searchHistory)

  const recent = useMemo(() => {
    const seen = new Set<string>()
    return history.filter((h) => (seen.has(h.track.id) ? false : (seen.add(h.track.id), true))).slice(0, 12)
  }, [history])

  const albums = useMemo(() => deriveAlbums([...liked, ...history.map((h) => h.track)]).slice(0, 12), [liked, history])

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

      {recent.length > 0 && (
        <section className="section">
          <div className="section-head">
            <h2>Recently played</h2>
            <button className="link" onClick={() => ui.navigate({ name: 'library', tab: 'recent' })} type="button">
              See all
            </button>
          </div>
          <div className="card-grid">
            {recent.slice(0, 6).map((record) => (
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

      {liked.length > 0 && (
        <section className="section">
          <div className="section-head">
            <h2>Liked songs</h2>
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

      {playlists.length > 0 && (
        <section className="section">
          <div className="section-head">
            <h2>Your playlists</h2>
            <button className="link" onClick={() => ui.navigate({ name: 'library', tab: 'playlists' })} type="button">
              See all
            </button>
          </div>
          <div className="card-grid">
            {playlists.slice(0, 6).map((pl) => (
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

      {albums.length > 0 && (
        <section className="section">
          <div className="section-head">
            <h2>Albums in your library</h2>
            <button className="link" onClick={() => ui.navigate({ name: 'library', tab: 'albums' })} type="button">
              See all
            </button>
          </div>
          <div className="card-grid">
            {albums.slice(0, 6).map((album) => (
              <MediaCard
                key={album.id}
                title={album.title}
                subtitle={album.artist}
                artwork={album.artwork}
                onOpen={() => ui.navigate({ name: 'album', key: album.id })}
                onPlay={() => void playback.playAll(album.tracks ?? [], album.title)}
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
