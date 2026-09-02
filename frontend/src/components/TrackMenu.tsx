import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Track } from '../bridge/types'
import { library, useLibraryStore } from '../state/libraryStore'
import { playback } from '../state/playback'
import { ui } from '../state/uiStore'
import { AlbumIcon, ArtistIcon, HeartIcon, NextIcon, PlusIcon, QueueIcon, RadioIcon, ThumbDownIcon } from './Icons'

interface Props {
  track: Track
  anchor: { x: number; y: number }
  onClose: () => void
  extra?: { label: string; onSelect: () => void; danger?: boolean }[]
}

export function TrackMenu({ track, anchor, onClose, extra = [] }: Props) {
  const playlists = useLibraryStore((s) => s.playlists)
  const liked = useLibraryStore((s) => s.liked.some((t) => t.id === track.id))
  const disliked = useLibraryStore((s) => s.disliked.some((t) => t.id === track.id))
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState(anchor)
  const [showPlaylists, setShowPlaylists] = useState(false)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    setPos({
      x: Math.min(anchor.x, window.innerWidth - rect.width - 12),
      y: Math.min(anchor.y, window.innerHeight - rect.height - 12),
    })
  }, [anchor, showPlaylists])

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const act = (fn: () => void) => () => {
    fn()
    onClose()
  }

  return createPortal(
    <div className="menu" ref={ref} style={{ left: pos.x, top: pos.y }} role="menu">
      {!showPlaylists ? (
        <>
          <button className="menu-item" role="menuitem" onClick={act(() => void playback.startRadio(track))}>
            <RadioIcon size={16} /> Start radio
          </button>
          <button className="menu-item" role="menuitem" onClick={act(() => playback.playNext([track]))}>
            <NextIcon size={16} /> Play next
          </button>
          <button className="menu-item" role="menuitem" onClick={act(() => playback.addToQueue([track]))}>
            <QueueIcon size={16} /> Add to queue
          </button>
          <button className="menu-item" role="menuitem" onClick={act(() => void library.toggleLike(track))}>
            <HeartIcon size={16} filled={liked} /> {liked ? 'Remove from Liked Songs' : 'Add to Liked Songs'}
          </button>
          <button
            className="menu-item"
            role="menuitem"
            onClick={act(() => void library.setDisliked(track, !disliked))}
          >
            <ThumbDownIcon size={16} filled={disliked} />
            {disliked ? 'Allow recommendations again' : 'Don’t recommend this song'}
          </button>
          <div className="menu-sep" />
          <button className="menu-item" role="menuitem" onClick={() => setShowPlaylists(true)}>
            <PlusIcon size={16} /> Add to playlist…
          </button>
          {track.album && (
            <button
              className="menu-item"
              role="menuitem"
              onClick={act(() =>
                ui.navigate({ name: 'album', key: `${track.album.toLowerCase()}|${track.artist.split(',')[0].trim().toLowerCase()}` }),
              )}
            >
              <AlbumIcon size={16} /> Go to album
            </button>
          )}
          {track.artist && (
            <button
              className="menu-item"
              role="menuitem"
              onClick={act(() => ui.navigate({ name: 'artist', artist: track.artist.split(',')[0].trim() }))}
            >
              <ArtistIcon size={16} /> Go to artist
            </button>
          )}
          {extra.length > 0 && <div className="menu-sep" />}
          {extra.map((item) => (
            <button
              key={item.label}
              className={`menu-item ${item.danger ? 'danger' : ''}`}
              role="menuitem"
              onClick={act(item.onSelect)}
            >
              {item.label}
            </button>
          ))}
        </>
      ) : (
        <>
          <div className="menu-label">Add to playlist</div>
          <button
            className="menu-item"
            role="menuitem"
            onClick={act(() => {
              void library.createPlaylist(track.title, [track]).then(() => ui.toast('Playlist created'))
            })}
          >
            <PlusIcon size={16} /> New playlist
          </button>
          {playlists.length > 0 && <div className="menu-sep" />}
          {playlists.map((pl) => (
            <button
              key={pl.id}
              className="menu-item"
              role="menuitem"
              onClick={act(() => {
                void library.addToPlaylist(pl.id, [track]).then(() => ui.toast(`Added to ${pl.name}`))
              })}
            >
              {pl.name}
            </button>
          ))}
        </>
      )}
    </div>,
    document.body,
  )
}
