import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { initBackend, setBackend } from './bridge/backend'
import { ACCENTS } from './lib/defaults'
import { library, useLibraryStore } from './state/libraryStore'
import { playback } from './state/playback'
import { ui } from './state/uiStore'
import './styles/global.css'

/** Applies theme + accent to the document. */
function applyTheme(): void {
  const { theme, accent } = useLibraryStore.getState().settings
  const resolved =
    theme === 'system'
      ? window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark'
      : theme
  document.documentElement.dataset.theme = resolved
  const palette = ACCENTS[accent] ?? ACCENTS.ember
  document.documentElement.style.setProperty('--accent', palette.value)
  document.documentElement.style.setProperty('--accent-contrast', palette.contrast)
}

async function boot(): Promise<void> {
  const be = await initBackend()
  setBackend(be)

  try {
    const state = await be.getState()
    library.hydrate(state)
    applyTheme()

    const settings = state.settings
    playback.engine.setVolume(settings.volume)
    playback.engine.setMuted(settings.muted)
    playback.engine.setRate(settings.defaultSpeed)

    if (settings.restoreSession && state.session) {
      await playback.restoreSession(state.session, settings.resumeOnStartup)
    }
  } catch (err) {
    library.setLoadError(err instanceof Error ? err.message : 'The MELO backend is unavailable.')
    applyTheme()
  }

  useLibraryStore.subscribe(applyTheme)
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', applyTheme)

  // Native integrations: OS media keys and resolver lifecycle events.
  be.on('melo:mediakey', (...args: unknown[]) => {
    switch (args[0]) {
      case 'playpause':
        void playback.toggle()
        break
      case 'next':
        void playback.next()
        break
      case 'previous':
        void playback.previous()
        break
      case 'stop':
        playback.stop()
        break
      default:
        break
    }
  })
  be.on('melo:resolver-error', (...args: unknown[]) => {
    ui.setResolverError(String(args[0] ?? 'The media resolver could not be installed.'))
    ui.setResolverProgress(null)
  })
  be.on('melo:resolver-ready', () => {
    ui.setResolverError(null)
    ui.setResolverProgress(null)
  })
  be.on('melo:resolver-progress', (...args: unknown[]) => {
    const p = args[0] as { done: number; total: number } | undefined
    if (p) ui.setResolverProgress(p)
  })

  // Persist the session on shutdown so a restart can pick up where we left off.
  window.addEventListener('beforeunload', () => void playback.saveSession())
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

void boot()
