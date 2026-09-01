import { useEffect, useRef, useState } from 'react'
import { MiniPlayer } from './components/MiniPlayer'
import { NowPlaying } from './components/NowPlaying'
import { QueuePanel } from './components/QueuePanel'
import { Sidebar } from './components/Sidebar'
import { TopBar } from './components/TopBar'
import { ErrorState } from './components/States'
import { useKeyboardShortcuts } from './lib/shortcuts'
import { useLibraryStore } from './state/libraryStore'
import { ui, useUIStore } from './state/uiStore'
import { AlbumView, ArtistView, PlaylistView } from './views/DetailViews'
import { HomeView } from './views/HomeView'
import { LibraryView } from './views/LibraryView'
import { SearchView } from './views/SearchView'
import { SettingsView } from './views/SettingsView'

function Routes() {
  const route = useUIStore((s) => s.route)
  switch (route.name) {
    case 'home':
      return <HomeView />
    case 'search':
      return <SearchView />
    case 'library':
      return <LibraryView tab={route.tab} />
    case 'playlist':
      return <PlaylistView id={route.id} />
    case 'album':
      return <AlbumView albumKey={route.key} />
    case 'artist':
      return <ArtistView name={route.artist} />
    case 'settings':
      return <SettingsView />
    default:
      return <HomeView />
  }
}

function Toasts() {
  const toasts = useUIStore((s) => s.toasts)
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`}>
          <span className="dot" />
          <span>{t.message}</span>
          <button className="icon-btn sm" onClick={() => ui.dismissToast(t.id)} aria-label="Dismiss" type="button">
            ×
          </button>
        </div>
      ))}
    </div>
  )
}

function ResolverBanner() {
  const error = useUIStore((s) => s.resolverError)
  const progress = useUIStore((s) => s.resolverProgress)
  if (progress && progress.total > 0 && progress.done < progress.total) {
    const pct = Math.round((progress.done / progress.total) * 100)
    return (
      <div className="banner">
        <span className="spinner" />
        <span>Preparing the media resolver… {pct}%</span>
      </div>
    )
  }
  if (!error) return null
  return (
    <div className="banner warn" role="alert">
      <span>{error}</span>
      <button className="btn ghost" style={{ marginLeft: 'auto', height: 30 }} onClick={() => ui.navigate({ name: 'settings' })} type="button">
        Open settings
      </button>
    </div>
  )
}

export function App() {
  const queueOpen = useUIStore((s) => s.queueOpen)
  const nowPlayingOpen = useUIStore((s) => s.nowPlayingOpen)
  const loadError = useLibraryStore((s) => s.loadError)
  const [scrolled, setScrolled] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)
  const route = useUIStore((s) => s.route)

  useKeyboardShortcuts()

  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 })
    setScrolled(false)
  }, [route])

  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        <TopBar scrolled={scrolled} />
        <ResolverBanner />
        <div className="content" ref={contentRef} onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 8)}>
          {loadError ? (
            <ErrorState
              title="MELO couldn’t load your library"
              message={loadError}
              onRetry={() => window.location.reload()}
              retryLabel="Reload"
            />
          ) : (
            <Routes />
          )}
        </div>
        {queueOpen && <QueuePanel />}
        {nowPlayingOpen && <NowPlaying />}
      </main>
      <MiniPlayer />
      <Toasts />
    </div>
  )
}
