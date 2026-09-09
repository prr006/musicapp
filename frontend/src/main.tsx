import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { initBackend, setBackend } from './bridge/backend'
import { ClockAdapter } from './audio/clockAdapter'
import { selectAdapter } from './audio/select'
import { ACCENTS } from './lib/defaults'
import { library, useLibraryStore } from './state/libraryStore'
import { playback } from './state/playback'
import { usePlayerStore } from './state/playerStore'
import { useSearchStore } from './state/searchStore'
import { recommenderTuning } from './state/recommender'
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
  // 1+2. Pick the playback provider and connect the data backend in parallel:
  // the catalogue and search must never depend on the player (or vice versa),
  // and a provider failure falls back to the offline transport rather than
  // taking the whole app down.
  const [adapterChoice, be] = await Promise.all([
    selectAdapter().catch(() => ({ adapter: new ClockAdapter(), degraded: true })),
    initBackend(),
  ])
  const { adapter, degraded } = adapterChoice
  playback.attachAdapter(adapter)
  if (degraded) {
    // Only reachable when the YouTube IFrame API cannot be reached; the
    // packaged app always selects the YouTube player.
    ui.toast('YouTube player unreachable — offline demo mode (no audio)', 'info')
  }

  setBackend(be)
  if (!be.isNative) {
    // Dev/preview mode searches the instant, local fixture backend; the
    // cooldown that protects a real provider from hammering would only slow
    // the demo down.
    recommenderTuning.fetchCooldownMs = 800
  }

  try {
    const state = await be.getState()
    library.hydrate(state)
    applyTheme()

    const settings = state.settings
    adapter.setVolume(settings.volume)
    adapter.setMuted(settings.muted)
    adapter.setRate(settings.defaultSpeed)

    if (settings.restoreSession && state.session) {
      await playback.restoreSession(state.session, settings.resumeOnStartup)
    }
  } catch (err) {
    library.setLoadError(err instanceof Error ? err.message : 'The MELO backend is unavailable.')
    applyTheme()
  }

  useLibraryStore.subscribe(applyTheme)
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', applyTheme)

  // Native integration: OS media keys.
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

  // Persist the session on shutdown so a restart can pick up where we left off.
  window.addEventListener('beforeunload', () => void playback.saveSession())

  // Dev-only, read-only introspection used by the end-to-end test drive.
  if (import.meta.env.DEV) {
    ;(window as unknown as Record<string, unknown>).__meloApp = {
      player: () => usePlayerStore.getState(),
      library: () => useLibraryStore.getState(),
      search: () => useSearchStore.getState(),
      adapter: () => playback.adapter.kind,
    }
  }
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

void boot()
