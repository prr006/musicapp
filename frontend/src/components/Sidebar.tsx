import { useState } from 'react'
import { library, useLibraryStore } from '../state/libraryStore'
import { ui, useUIStore } from '../state/uiStore'
import { HomeIcon, LibraryIcon, MusicIcon, PlusIcon, SearchIcon, SettingsIcon } from './Icons'

export function Sidebar() {
  const route = useUIStore((s) => s.route)
  const playlists = useLibraryStore((s) => s.playlists)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')

  const item = (key: string, label: string, icon: React.ReactNode, onClick: () => void, current: boolean) => (
    <button className="nav-item" aria-current={current} onClick={onClick} key={key} type="button">
      {icon}
      <span>{label}</span>
    </button>
  )

  return (
    <nav className="sidebar" aria-label="Main">
      <div className="brand">
        <div className="brand-mark">M</div>
        <div className="brand-name">MELO</div>
      </div>

      <div className="nav">
        {item('home', 'Home', <HomeIcon size={19} />, () => ui.navigate({ name: 'home' }), route.name === 'home')}
        {item('search', 'Search', <SearchIcon size={19} />, () => ui.navigate({ name: 'search' }), route.name === 'search')}
        {item(
          'library',
          'Your Library',
          <LibraryIcon size={19} />,
          () => ui.navigate({ name: 'library', tab: 'songs' }),
          route.name === 'library' || route.name === 'album' || route.name === 'artist',
        )}
        {item('settings', 'Settings', <SettingsIcon size={19} />, () => ui.navigate({ name: 'settings' }), route.name === 'settings')}
      </div>

      <div className="sidebar-section">
        <span>Playlists</span>
        <button className="icon-btn sm" onClick={() => setCreating(true)} aria-label="New playlist" title="New playlist" type="button">
          <PlusIcon size={16} />
        </button>
      </div>

      <div className="playlist-list">
        {creating && (
          <form
            style={{ padding: '4px 8px 8px' }}
            onSubmit={(e) => {
              e.preventDefault()
              const value = name.trim()
              setCreating(false)
              setName('')
              void library.createPlaylist(value || 'New Playlist').then((pl) => ui.navigate({ name: 'playlist', id: pl.id }))
            }}
          >
            <input
              className="input"
              autoFocus
              value={name}
              placeholder="Playlist name"
              aria-label="New playlist name"
              onChange={(e) => setName(e.target.value)}
              onBlur={() => {
                if (!name.trim()) setCreating(false)
              }}
            />
          </form>
        )}
        {playlists.length === 0 && !creating && (
          <p className="muted" style={{ padding: '8px 12px', fontSize: 12.5 }}>
            Your playlists will show up here.
          </p>
        )}
        {playlists.map((pl) => (
          <button
            key={pl.id}
            className="playlist-link"
            aria-current={route.name === 'playlist' && route.id === pl.id}
            onClick={() => ui.navigate({ name: 'playlist', id: pl.id })}
            type="button"
          >
            <MusicIcon size={15} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pl.name}</span>
            <span className="count">{pl.tracks.length}</span>
          </button>
        ))}
      </div>
    </nav>
  )
}
