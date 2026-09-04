import { CloseIcon, SearchIcon } from '../components/Icons'
import { MediaCard } from '../components/MediaCard'
import { EmptyState, ErrorState, LoadingCards, LoadingRows } from '../components/States'
import { albumKey } from '../lib/derive'
import { TrackRow } from '../components/TrackRow'
import { library, useLibraryStore } from '../state/libraryStore'
import { playback } from '../state/playback'
import { search, useSearchStore } from '../state/searchStore'
import { ui } from '../state/uiStore'

const FILTERS = [
  { id: '', label: 'All' },
  { id: 'songs', label: 'Songs' },
  { id: 'videos', label: 'Videos' },
  { id: 'albums', label: 'Albums' },
]

export function SearchView() {
  const status = useSearchStore((s) => s.status)
  const results = useSearchStore((s) => s.results)
  const error = useSearchStore((s) => s.error)
  const filter = useSearchStore((s) => s.filter)
  const submitted = useSearchStore((s) => s.submitted)
  const history = useLibraryStore((s) => s.searchHistory)

  // The Go backend marshals empty slices as JSON `null` (the yt-dlp fallback and
  // video-only InnerTube responses have no album/artist lists at all). Never
  // trust the response shape: normalise every section to an array here so a
  // `null` section can't crash the render (which would blank the whole app).
  const songs = results?.songs ?? []
  const videos = results?.videos ?? []
  const artists = results?.artists ?? []
  const albums = results?.albums ?? []
  const all = [...songs, ...videos]

  return (
    <div className="page">
      <div className="page-header">
        <h1>{submitted ? `Results for “${submitted}”` : 'Search'}</h1>
      </div>

      {submitted && (
        <div className="tabs">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              className="chip"
              aria-selected={filter === f.id}
              onClick={() => search.setFilter(f.id)}
              type="button"
            >
              {f.label}
            </button>
          ))}
        </div>
      )}

      {status === 'idle' && (
        <>
          {history.length > 0 ? (
            <section className="section">
              <div className="section-head">
                <h2>Recent searches</h2>
                <button className="link" onClick={() => void library.clearSearchHistory()} type="button">
                  Clear all
                </button>
              </div>
              <div className="tabs">
                {history.map((term) => (
                  <span key={term} className="chip removable">
                    <button type="button" onClick={() => void search.run(term)} style={{ color: 'inherit' }}>
                      {term}
                    </button>
                    <button
                      type="button"
                      className="icon-btn sm"
                      aria-label={`Remove ${term} from recent searches`}
                      onClick={() => void library.removeSearchTerm(term)}
                    >
                      <CloseIcon size={12} />
                    </button>
                  </span>
                ))}
              </div>
            </section>
          ) : (
            <EmptyState
              icon={<SearchIcon size={20} />}
              title="Find something to play"
              message="Search YouTube Music for songs, artists and albums. One click plays instantly."
            />
          )}
        </>
      )}

      {status === 'loading' && (
        <>
          <LoadingRows count={6} />
          <div style={{ height: 24 }} />
          <LoadingCards count={5} />
        </>
      )}

      {status === 'error' && (
        <ErrorState
          title="Couldn’t reach YouTube"
          message={error ?? 'The search provider is unavailable right now.'}
          onRetry={() => search.retry()}
          retryLabel="Retry search"
        />
      )}

      {status === 'empty' && (
        <EmptyState
          icon={<SearchIcon size={20} />}
          title="No results"
          message={`Nothing matched “${submitted}”. Try a different spelling or a shorter query.`}
        />
      )}

      {status === 'results' && results && (
        <>
          {songs.length > 0 && (
            <section className="section">
              <div className="section-head">
                <h2>Songs</h2>
                <button className="btn ghost" onClick={() => void playback.playAll(all, `Search: ${submitted}`)} type="button">
                  Play all
                </button>
              </div>
              <div className="track-list">
                {songs.map((track, i) => (
                  <TrackRow
                    key={track.id}
                    track={track}
                    index={i}
                    onPlay={() => void playback.play(track)}
                  />
                ))}
              </div>
            </section>
          )}

          {videos.length > 0 && (
            <section className="section">
              <div className="section-head">
                <h2>Videos</h2>
              </div>
              <div className="track-list">
                {videos.map((track, i) => (
                  <TrackRow
                    key={track.id}
                    track={track}
                    index={i}
                    onPlay={() => void playback.play(track)}
                  />
                ))}
              </div>
            </section>
          )}

          {artists.length > 0 && (
            <section className="section">
              <div className="section-head">
                <h2>Artists</h2>
              </div>
              <div className="card-grid">
                {artists.map((artist) => (
                  <MediaCard
                    key={artist.id}
                    title={artist.name}
                    subtitle="Artist"
                    artwork={artist.artwork}
                    round
                    onOpen={() => ui.navigate({ name: 'artist', artist: artist.name })}
                  />
                ))}
              </div>
            </section>
          )}

          {albums.length > 0 && (
            <section className="section">
              <div className="section-head">
                <h2>Albums</h2>
              </div>
              <div className="card-grid">
                {albums.map((album) => (
                  <MediaCard
                    key={album.id}
                    title={album.title}
                    subtitle={[album.artist, album.year].filter(Boolean).join(' · ')}
                    artwork={album.artwork}
                    // Navigate with the SAME key the library-derived album
                    // pages use, so a provider album card opens the real
                    // album page when the library knows it (and the honest
                    // empty state when it does not) — never a dead id.
                    onOpen={() =>
                      ui.navigate({
                        name: 'album',
                        key: albumKey({ album: album.title, artist: album.artist }),
                      })
                    }
                  />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}
