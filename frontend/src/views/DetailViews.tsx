import { useMemo, useState } from 'react'
import { Artwork } from '../components/Artwork'
import { AlbumIcon, ArtistIcon, MusicIcon } from '../components/Icons'
import { MediaCard } from '../components/MediaCard'
import { EmptyState } from '../components/States'
import { TrackRow } from '../components/TrackRow'
import { findAlbum, findArtist } from '../lib/derive'
import { formatCount, formatLongDuration, totalDuration } from '../lib/format'
import { library, useLibraryStore } from '../state/libraryStore'
import { playback } from '../state/playback'
import { ui } from '../state/uiStore'
import type { Track } from '../bridge/types'

function useLibraryTracks(): Track[] {
  const liked = useLibraryStore((s) => s.liked)
  const playlists = useLibraryStore((s) => s.playlists)
  const history = useLibraryStore((s) => s.history)
  return useMemo(() => {
    const seen = new Set<string>()
    const out: Track[] = []
    for (const t of [...liked, ...playlists.flatMap((p) => p.tracks), ...history.map((h) => h.track)]) {
      if (seen.has(t.id)) continue
      seen.add(t.id)
      out.push(t)
    }
    return out
  }, [liked, playlists, history])
}

export function AlbumView({ albumKey }: { albumKey: string }) {
  const tracks = useLibraryTracks()
  const album = useMemo(() => findAlbum(tracks, albumKey), [tracks, albumKey])

  if (!album) {
    return (
      <div className="page">
        <EmptyState
          icon={<AlbumIcon size={20} />}
          title="Album not in your library"
          message="Album pages are built from the songs you have played, liked or saved."
        />
      </div>
    )
  }

  const list = album.tracks ?? []

  return (
    <div className="page">
      <header className="detail-head">
        <Artwork src={album.artwork} alt={album.title} style={{ width: 208, height: 208 }} />
        <div className="detail-meta">
          <div className="kind">Album</div>
          <h1>{album.title}</h1>
          <div className="facts">
            <button type="button" onClick={() => ui.navigate({ name: 'artist', artist: album.artist })}>
              <strong>{album.artist}</strong>
            </button>
            <span className="dot-sep" />
            <span>{formatCount(list.length, 'song')}</span>
            {totalDuration(list) > 0 && (
              <>
                <span className="dot-sep" />
                <span>{formatLongDuration(totalDuration(list))}</span>
              </>
            )}
          </div>
        </div>
      </header>

      <div className="detail-actions">
        <button className="btn primary lg" onClick={() => void playback.playAll(list, album.title)} type="button">
          Play
        </button>
        <button className="btn ghost" onClick={() => void playback.playAll(list, album.title, true)} type="button">
          Shuffle
        </button>
        <button className="btn ghost" onClick={() => playback.addToQueue(list)} type="button">
          Add to queue
        </button>
      </div>

      <div className="track-list">
        {list.map((track, i) => (
          <TrackRow
            key={track.id}
            track={track}
            index={i}
            showAlbum={false}
            onPlay={() => void playback.play(track, { tracks: list, index: i, label: album.title })}
          />
        ))}
      </div>
    </div>
  )
}

export function ArtistView({ name }: { name: string }) {
  const tracks = useLibraryTracks()
  const artist = useMemo(() => findArtist(tracks, name), [tracks, name])

  if (!artist) {
    return (
      <div className="page">
        <EmptyState
          icon={<ArtistIcon size={20} />}
          title={`Nothing saved for ${name}`}
          message="Artist pages are built from the songs in your library. Search for this artist to add some."
        />
      </div>
    )
  }

  const list = artist.tracks ?? []

  return (
    <div className="page">
      <header className="detail-head">
        <Artwork src={artist.artwork} alt={artist.name} round style={{ width: 208, height: 208 }} />
        <div className="detail-meta">
          <div className="kind">Artist</div>
          <h1>{artist.name}</h1>
          <div className="facts">
            <span>{formatCount(list.length, 'song')}</span>
            {(artist.albums?.length ?? 0) > 0 && (
              <>
                <span className="dot-sep" />
                <span>{formatCount(artist.albums!.length, 'album')}</span>
              </>
            )}
          </div>
        </div>
      </header>

      <div className="detail-actions">
        <button className="btn primary lg" onClick={() => void playback.playAll(list, artist.name)} type="button">
          Play
        </button>
        <button className="btn ghost" onClick={() => void playback.playAll(list, artist.name, true)} type="button">
          Shuffle
        </button>
      </div>

      <section className="section">
        <div className="section-head">
          <h2>Songs</h2>
        </div>
        <div className="track-list">
          {list.map((track, i) => (
            <TrackRow
              key={track.id}
              track={track}
              index={i}
              onPlay={() => void playback.play(track, { tracks: list, index: i, label: artist.name })}
            />
          ))}
        </div>
      </section>

      {(artist.albums?.length ?? 0) > 0 && (
        <section className="section">
          <div className="section-head">
            <h2>Albums</h2>
          </div>
          <div className="card-grid">
            {artist.albums!.map((album) => (
              <MediaCard
                key={album.id}
                title={album.title}
                subtitle={formatCount(album.tracks?.length ?? 0, 'song')}
                artwork={album.artwork}
                onOpen={() => ui.navigate({ name: 'album', key: album.id })}
                onPlay={() => void playback.playAll(album.tracks ?? [], album.title)}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

export function PlaylistView({ id }: { id: string }) {
  const playlist = useLibraryStore((s) => s.playlists.find((p) => p.id === id))
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState('')

  if (!playlist) {
    return (
      <div className="page">
        <EmptyState icon={<MusicIcon size={20} />} title="Playlist not found" message="It may have been deleted." />
      </div>
    )
  }

  const list = playlist.tracks

  return (
    <div className="page">
      <header className="detail-head">
        <Artwork src={list[0]?.artwork} alt={playlist.name} style={{ width: 208, height: 208 }} />
        <div className="detail-meta">
          <div className="kind">Playlist</div>
          {renaming ? (
            <form
              onSubmit={(e) => {
                e.preventDefault()
                void library.renamePlaylist(playlist.id, name.trim() || playlist.name)
                setRenaming(false)
              }}
            >
              <input
                className="input"
                autoFocus
                defaultValue={playlist.name}
                aria-label="Playlist name"
                style={{ fontSize: 28, height: 56, fontWeight: 700 }}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => setRenaming(false)}
              />
            </form>
          ) : (
            <h1
              onDoubleClick={() => {
                setName(playlist.name)
                setRenaming(true)
              }}
              title="Double-click to rename"
            >
              {playlist.name}
            </h1>
          )}
          <div className="facts">
            <span>{formatCount(list.length, 'song')}</span>
            {totalDuration(list) > 0 && (
              <>
                <span className="dot-sep" />
                <span>{formatLongDuration(totalDuration(list))}</span>
              </>
            )}
          </div>
        </div>
      </header>

      <div className="detail-actions">
        <button
          className="btn primary lg"
          onClick={() => void playback.playAll(list, playlist.name)}
          disabled={list.length === 0}
          type="button"
        >
          Play
        </button>
        <button
          className="btn ghost"
          onClick={() => void playback.playAll(list, playlist.name, true)}
          disabled={list.length === 0}
          type="button"
        >
          Shuffle
        </button>
        <button className="btn ghost" onClick={() => playback.addToQueue(list)} disabled={list.length === 0} type="button">
          Add to queue
        </button>
        <button
          className="btn ghost"
          onClick={() => {
            setName(playlist.name)
            setRenaming(true)
          }}
          type="button"
        >
          Rename
        </button>
        <button
          className="btn ghost"
          onClick={() => void library.duplicatePlaylist(playlist.id).then(() => ui.toast('Playlist duplicated'))}
          type="button"
        >
          Duplicate
        </button>
        <button
          className="btn ghost danger"
          onClick={() => {
            void library.deletePlaylist(playlist.id)
            ui.navigate({ name: 'library', tab: 'playlists' })
          }}
          type="button"
        >
          Delete
        </button>
      </div>

      {list.length === 0 ? (
        <EmptyState
          title="This playlist is empty"
          message="Add songs from search results or any song’s menu."
        />
      ) : (
        <div className="track-list">
          {list.map((track, i) => (
            <TrackRow
              key={`${track.id}-${i}`}
              track={track}
              index={i}
              onPlay={() => void playback.play(track, { tracks: list, index: i, label: playlist.name })}
              menuExtra={[
                {
                  label: 'Move up',
                  onSelect: () => void library.reorderPlaylist(playlist.id, i, Math.max(0, i - 1)),
                },
                {
                  label: 'Move down',
                  onSelect: () => void library.reorderPlaylist(playlist.id, i, Math.min(list.length - 1, i + 1)),
                },
                {
                  label: 'Remove from this playlist',
                  danger: true,
                  onSelect: () => void library.removeFromPlaylist(playlist.id, i),
                },
              ]}
            />
          ))}
        </div>
      )}
    </div>
  )
}
