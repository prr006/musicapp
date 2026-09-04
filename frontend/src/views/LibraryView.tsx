import { useMemo, useState } from 'react'
import { AlbumIcon, ArtistIcon, ClockIcon, HeartIcon, MusicIcon, PlusIcon, SearchIcon, TrendingIcon } from '../components/Icons'
import { MediaCard } from '../components/MediaCard'
import { EmptyState } from '../components/States'
import { TrackRow } from '../components/TrackRow'
import { deriveAlbums, deriveArtists, mostPlayedTracks, primaryArtist } from '../lib/derive'
import { relativeTime } from '../lib/format'
import { library, useLibraryStore } from '../state/libraryStore'
import { playback } from '../state/playback'
import { ui, type Route } from '../state/uiStore'

type Tab = Extract<Route, { name: 'library' }>['tab']

const TABS: { id: Tab; label: string }[] = [
  { id: 'songs', label: 'Songs' },
  { id: 'liked', label: 'Liked' },
  { id: 'recent', label: 'Recently played' },
  { id: 'most-played', label: 'Most played' },
  { id: 'artists', label: 'Artists' },
  { id: 'albums', label: 'Albums' },
  { id: 'playlists', label: 'Playlists' },
]

/** Local, in-memory library filtering — the remote provider is never called. */
function useLocalFilter<T>(items: T[], query: string, textOf: (item: T) => string): T[] {
  return useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter((item) => textOf(item).toLowerCase().includes(q))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, query])
}

export function LibraryView({ tab }: { tab: Tab }) {
  const liked = useLibraryStore((s) => s.liked)
  const playlists = useLibraryStore((s) => s.playlists)
  const history = useLibraryStore((s) => s.history)
  const stats = useLibraryStore((s) => s.stats)
  const [query, setQuery] = useState('')

  const allTracks = useMemo(() => {
    const seen = new Set<string>()
    const out = []
    for (const t of [...liked, ...playlists.flatMap((p) => p.tracks), ...history.map((h) => h.track)]) {
      if (seen.has(t.id)) continue
      seen.add(t.id)
      out.push(t)
    }
    return out.sort((a, b) => a.title.localeCompare(b.title))
  }, [liked, playlists, history])

  const albums = useMemo(() => deriveAlbums(allTracks), [allTracks])
  const artists = useMemo(() => deriveArtists(allTracks), [allTracks])

  const recent = useMemo(() => {
    const seen = new Set<string>()
    return history.filter((h) => (seen.has(h.track.id) ? false : (seen.add(h.track.id), true)))
  }, [history])

  const mostPlayed = useMemo(() => mostPlayedTracks(history, stats), [history, stats])

  // Local filtering per tab (never a remote call).
  const visibleTracks = useLocalFilter(allTracks, query, (t) => `${t.title} ${t.artist}`)
  const visibleLiked = useLocalFilter(liked, query, (t) => `${t.title} ${t.artist}`)
  const visibleAlbums = useLocalFilter(albums, query, (a) => `${a.title} ${a.artist}`)
  const visibleArtists = useLocalFilter(artists, query, (a) => a.name)
  const visiblePlaylists = useLocalFilter(playlists, query, (p) => p.name)
  const visibleRecent = useLocalFilter(recent, query, (r) => `${r.track.title} ${r.track.artist}`)
  const visibleMostPlayed = useLocalFilter(mostPlayed, query, (m) => `${m.track.title} ${m.track.artist}`)

  return (
    <div className="page">
      <div className="page-header">
        <h1>Your Library</h1>
      </div>

      <div className="tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className="chip"
            aria-selected={tab === t.id}
            onClick={() => ui.navigate({ name: 'library', tab: t.id })}
            type="button"
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="search-field library-filter">
        <SearchIcon size={15} />
        <input
          type="search"
          aria-label="Search your library"
          placeholder="Search your library"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {tab === 'songs' && (
        allTracks.length === 0 ? (
          <EmptyState icon={<MusicIcon size={20} />} title="No songs yet" message="Songs you play, like or add to a playlist collect here." />
        ) : (
          <>
            <div className="detail-actions">
              <button className="btn primary" onClick={() => void playback.playAll(allTracks, 'Songs')} type="button">
                Play
              </button>
              <button className="btn ghost" onClick={() => void playback.playAll(allTracks, 'Songs', true)} type="button">
                Shuffle
              </button>
            </div>
            <div className="track-list">
              {visibleTracks.map((track, i) => (
                <TrackRow
                  key={track.id}
                  track={track}
                  index={i}
                  onPlay={() => void playback.play(track, { tracks: visibleTracks, index: i, label: 'Songs' })}
                />
              ))}
              {visibleTracks.length === 0 && (
                <EmptyState icon={<MusicIcon size={20} />} title="No matches" message={`No songs in your library match “${query}”.`} />
              )}
            </div>
          </>
        )
      )}

      {tab === 'liked' && (
        liked.length === 0 ? (
          <EmptyState icon={<HeartIcon size={20} />} title="No liked songs yet" message="Songs you like will appear here." />
        ) : (
          <>
            <div className="detail-actions">
              <button className="btn primary" onClick={() => void playback.playAll(liked, 'Liked Songs')} type="button">
                Play
              </button>
              <button className="btn ghost" onClick={() => void playback.playAll(liked, 'Liked Songs', true)} type="button">
                Shuffle
              </button>
              <button
                className="btn ghost"
                onClick={() => void library.createPlaylist('Liked Songs', liked).then(() => ui.toast('Playlist created'))}
                type="button"
              >
                <PlusIcon size={15} /> Save as playlist
              </button>
            </div>
            <div className="track-list">
              {visibleLiked.map((track, i) => (
                <TrackRow
                  key={track.id}
                  track={track}
                  index={i}
                  onPlay={() => void playback.play(track, { tracks: visibleLiked, index: i, label: 'Liked Songs' })}
                />
              ))}
              {visibleLiked.length === 0 && query && (
                <EmptyState icon={<HeartIcon size={20} />} title="No matches" message={`No liked songs match “${query}”.`} />
              )}
            </div>
          </>
        )
      )}

      {tab === 'albums' && (
        albums.length === 0 ? (
          <EmptyState icon={<AlbumIcon size={20} />} title="No albums yet" message="Albums from your library will appear here — songs need album metadata to group." />
        ) : (
          <div className="card-grid">
            {visibleAlbums.map((album) => (
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
        )
      )}

      {tab === 'artists' && (
        artists.length === 0 ? (
          <EmptyState icon={<ArtistIcon size={20} />} title="No artists yet" message="Artists from your library will appear here." />
        ) : (
          <div className="card-grid">
            {visibleArtists.map((artist) => {
              const likedCount = liked.filter(
                (t) => primaryArtist(t.artist).toLowerCase() === artist.id && t.artist,
              ).length
              const songs = artist.tracks?.length ?? 0
              const subtitle =
                likedCount > 0
                  ? `${songs} song${songs === 1 ? '' : 's'} · ${likedCount} liked`
                  : `${songs} song${songs === 1 ? '' : 's'}`
              return (
                <MediaCard
                  key={artist.id}
                  title={artist.name}
                  subtitle={subtitle}
                  artwork={artist.artwork}
                  round
                  onOpen={() => ui.navigate({ name: 'artist', artist: artist.name })}
                  onPlay={() => void playback.playAll(artist.tracks ?? [], artist.name)}
                />
              )
            })}
          </div>
        )
      )}

      {tab === 'playlists' && (
        playlists.length === 0 ? (
          <EmptyState
            icon={<MusicIcon size={20} />}
            title="No playlists yet"
            message="Create a playlist from the sidebar, a song menu, or straight from the queue."
            action={
              <button className="btn primary" onClick={() => void library.createPlaylist('New Playlist')} type="button">
                <PlusIcon size={16} /> New playlist
              </button>
            }
          />
        ) : (
          <div className="card-grid">
            {visiblePlaylists.map((pl) => (
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
        )
      )}

      {tab === 'recent' && (
        recent.length === 0 ? (
          <EmptyState icon={<ClockIcon size={20} />} title="Nothing played yet" message="Your listening history will appear here." />
        ) : (
          <>
            <div className="detail-actions">
              <button
                className="btn primary"
                onClick={() => void playback.playAll(recent.map((r) => r.track), 'Recently played')}
                type="button"
              >
                Play
              </button>
              <button className="btn ghost danger" onClick={() => void library.clearHistory()} type="button">
                Clear history
              </button>
            </div>
            <div className="track-list">
              {visibleRecent.map((record, i) => (
                <TrackRow
                  key={`${record.track.id}-${record.playedAt}`}
                  track={record.track}
                  index={i}
                  onPlay={() =>
                    void playback.play(record.track, {
                      tracks: visibleRecent.map((r) => r.track),
                      index: i,
                      label: 'Recently played',
                    })
                  }
                  trailing={<span className="muted">{relativeTime(record.playedAt)}</span>}
                />
              ))}
            </div>
          </>
        )
      )}

      {tab === 'most-played' && (
        mostPlayed.length === 0 ? (
          <EmptyState
            icon={<TrendingIcon size={20} />}
            title="Nothing played yet"
            message="Keep listening and MELO will build your most-played list."
          />
        ) : (
          <>
            <div className="detail-actions">
              <button
                className="btn primary"
                onClick={() => void playback.playAll(mostPlayed.map((m) => m.track), 'Most played')}
                type="button"
              >
                Play
              </button>
            </div>
            <div className="track-list">
              {visibleMostPlayed.map(({ track, plays }, i) => (
                <TrackRow
                  key={track.id}
                  track={track}
                  index={i}
                  onPlay={() =>
                    void playback.play(track, {
                      tracks: visibleMostPlayed.map((m) => m.track),
                      index: i,
                      label: 'Most played',
                    })
                  }
                  trailing={<span className="muted">{plays} play{plays === 1 ? '' : 's'}</span>}
                />
              ))}
              {visibleMostPlayed.length === 0 && query && (
                <EmptyState icon={<TrendingIcon size={20} />} title="No matches" message={`Nothing in your most-played matches “${query}”.`} />
              )}
            </div>
          </>
        )
      )}
    </div>
  )
}
