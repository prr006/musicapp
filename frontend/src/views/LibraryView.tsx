import { useMemo } from 'react'
import { AlbumIcon, ArtistIcon, ClockIcon, HeartIcon, MusicIcon, PlusIcon } from '../components/Icons'
import { MediaCard } from '../components/MediaCard'
import { EmptyState } from '../components/States'
import { TrackRow } from '../components/TrackRow'
import { deriveAlbums, deriveArtists } from '../lib/derive'
import { relativeTime } from '../lib/format'
import { library, useLibraryStore } from '../state/libraryStore'
import { playback } from '../state/playback'
import { ui, type Route } from '../state/uiStore'

type Tab = Extract<Route, { name: 'library' }>['tab']

const TABS: { id: Tab; label: string }[] = [
  { id: 'songs', label: 'Songs' },
  { id: 'liked', label: 'Liked' },
  { id: 'albums', label: 'Albums' },
  { id: 'artists', label: 'Artists' },
  { id: 'playlists', label: 'Playlists' },
  { id: 'recent', label: 'Recently played' },
]

export function LibraryView({ tab }: { tab: Tab }) {
  const liked = useLibraryStore((s) => s.liked)
  const playlists = useLibraryStore((s) => s.playlists)
  const history = useLibraryStore((s) => s.history)

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
              {allTracks.map((track, i) => (
                <TrackRow
                  key={track.id}
                  track={track}
                  index={i}
                  onPlay={() => void playback.play(track, { tracks: allTracks, index: i, label: 'Songs' })}
                />
              ))}
            </div>
          </>
        )
      )}

      {tab === 'liked' && (
        liked.length === 0 ? (
          <EmptyState icon={<HeartIcon size={20} />} title="No liked songs" message="Tap the heart on any song to save it here." />
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
              {liked.map((track, i) => (
                <TrackRow
                  key={track.id}
                  track={track}
                  index={i}
                  onPlay={() => void playback.play(track, { tracks: liked, index: i, label: 'Liked Songs' })}
                />
              ))}
            </div>
          </>
        )
      )}

      {tab === 'albums' && (
        albums.length === 0 ? (
          <EmptyState icon={<AlbumIcon size={20} />} title="No albums yet" message="Albums appear when the songs in your library carry album metadata." />
        ) : (
          <div className="card-grid">
            {albums.map((album) => (
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
          <EmptyState icon={<ArtistIcon size={20} />} title="No artists yet" message="Artists are derived from the songs in your library." />
        ) : (
          <div className="card-grid">
            {artists.map((artist) => (
              <MediaCard
                key={artist.id}
                title={artist.name}
                subtitle={`${artist.tracks?.length ?? 0} song${artist.tracks?.length === 1 ? '' : 's'}`}
                artwork={artist.artwork}
                round
                onOpen={() => ui.navigate({ name: 'artist', artist: artist.name })}
                onPlay={() => void playback.playAll(artist.tracks ?? [], artist.name)}
              />
            ))}
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
            {playlists.map((pl) => (
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
          <EmptyState icon={<ClockIcon size={20} />} title="Nothing played yet" message="Your listening history is recorded as you play." />
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
              {recent.map((record, i) => (
                <TrackRow
                  key={`${record.track.id}-${record.playedAt}`}
                  track={record.track}
                  index={i}
                  onPlay={() =>
                    void playback.play(record.track, {
                      tracks: recent.map((r) => r.track),
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
    </div>
  )
}
