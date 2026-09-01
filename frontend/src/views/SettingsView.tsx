import { useEffect, useState } from 'react'
import { backend } from '../bridge/backend'
import type { Diagnostics, Settings } from '../bridge/types'
import { ACCENTS, SPEEDS } from '../lib/defaults'
import { library, useLibraryStore } from '../state/libraryStore'
import { playback } from '../state/playback'
import { ui, useUIStore } from '../state/uiStore'

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      className="switch"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      type="button"
    />
  )
}

function Row({
  name,
  desc,
  children,
}: {
  name: string
  desc?: string
  children: React.ReactNode
}) {
  return (
    <div className="setting-row">
      <div className="setting-info">
        <div className="name">{name}</div>
        {desc && <div className="desc">{desc}</div>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  )
}

export function SettingsView() {
  const settings = useLibraryStore((s) => s.settings)
  const resolverError = useUIStore((s) => s.resolverError)
  const [diag, setDiag] = useState<Diagnostics | null>(null)
  const [diagError, setDiagError] = useState<string | null>(null)
  const [installing, setInstalling] = useState(false)

  const loadDiagnostics = () => {
    backend()
      .getDiagnostics()
      .then((d) => {
        setDiag(d)
        setDiagError(null)
      })
      .catch((err: Error) => setDiagError(err.message))
  }

  useEffect(loadDiagnostics, [])

  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    void library.saveSettings({ [key]: value } as Partial<Settings>)
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1>Settings</h1>
      </div>

      <div className="settings-group">
        <h3>Appearance</h3>
        <Row name="Theme" desc="Switch between MELO’s dark and light surfaces.">
          <select className="input" value={settings.theme} onChange={(e) => update('theme', e.target.value as Settings['theme'])} aria-label="Theme">
            <option value="dark">Dark</option>
            <option value="light">Light</option>
            <option value="system">Match system</option>
          </select>
        </Row>
        <Row name="Accent" desc="Used for highlights, active states and the progress bar.">
          <div className="row">
            {Object.entries(ACCENTS).map(([key, accent]) => (
              <button
                key={key}
                type="button"
                aria-label={accent.label}
                aria-pressed={settings.accent === key}
                onClick={() => update('accent', key)}
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: '50%',
                  background: accent.value,
                  outline: settings.accent === key ? '2px solid var(--text)' : 'none',
                  outlineOffset: 2,
                }}
              />
            ))}
          </div>
        </Row>
        <Row name="Show lyrics" desc="Display the lyrics pane in Now Playing.">
          <Toggle checked={settings.showLyrics} onChange={(v) => update('showLyrics', v)} label="Show lyrics" />
        </Row>
      </div>

      <div className="settings-group">
        <h3>Playback</h3>
        <Row name="Autoplay" desc="Keep playing related songs after your queue ends.">
          <Toggle
            checked={settings.autoplay}
            onChange={(v) => {
              update('autoplay', v)
              playback.setAutoplay(v)
            }}
            label="Autoplay"
          />
        </Row>
        <Row name="Default speed" desc="Applied to every new track.">
          <select
            className="input"
            value={settings.defaultSpeed}
            aria-label="Default playback speed"
            onChange={(e) => {
              const speed = Number(e.target.value)
              update('defaultSpeed', speed)
              playback.setSpeed(speed)
            }}
          >
            {SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s}×
              </option>
            ))}
          </select>
        </Row>
        <Row name="Audio quality" desc="Chooses which audio-only stream the resolver picks.">
          <select
            className="input"
            value={settings.audioQuality}
            aria-label="Audio quality"
            onChange={(e) => update('audioQuality', e.target.value as Settings['audioQuality'])}
          >
            <option value="high">High — best available</option>
            <option value="medium">Medium — balanced</option>
            <option value="low">Low — save bandwidth</option>
          </select>
        </Row>
      </div>

      <div className="settings-group">
        <h3>Startup</h3>
        <Row name="Restore last session" desc="Bring back your queue and position when MELO reopens.">
          <Toggle
            checked={settings.restoreSession}
            onChange={(v) => {
              update('restoreSession', v)
              if (!v) void backend().clearSession()
            }}
            label="Restore last session"
          />
        </Row>
        <Row name="Resume playback on launch" desc="Start playing immediately after the session is restored.">
          <Toggle
            checked={settings.resumeOnStartup}
            onChange={(v) => update('resumeOnStartup', v)}
            label="Resume playback on launch"
          />
        </Row>
        <Row
          name="Tray icon"
          desc={
            diag?.tray === 'windows-shell-notifyicon'
              ? 'Keep MELO in the notification area; closing the window hides it there.'
              : 'Not supported on this platform.'
          }
        >
          <Toggle
            checked={settings.minimizeToTray && diag?.tray === 'windows-shell-notifyicon'}
            onChange={(v) => update('minimizeToTray', v)}
            label="Tray icon"
          />
        </Row>
        <Row
          name="Track notifications"
          desc={
            diag?.tray === 'windows-shell-notifyicon'
              ? 'Show the song title when the track changes. Requires the tray icon.'
              : 'Not supported on this platform.'
          }
        >
          <Toggle
            checked={settings.notifications && settings.minimizeToTray && diag?.tray === 'windows-shell-notifyicon'}
            onChange={(v) => update('notifications', v)}
            label="Track notifications"
          />
        </Row>
        <Row name="Media keys" desc={diag?.mediaKeys === 'windows-hotkeys' ? 'Play/pause, next, previous and stop keys control MELO.' : 'Not supported on this platform.'}>
          <Toggle
            checked={settings.mediaKeys && diag?.mediaKeys === 'windows-hotkeys'}
            onChange={(v) => update('mediaKeys', v)}
            label="Media keys"
          />
        </Row>
      </div>

      <div className="settings-group">
        <h3>Keyboard shortcuts</h3>
        <div className="shortcut-grid">
          {Object.entries(settings.shortcuts).map(([action, keys]) => (
            <div className="shortcut-row" key={action}>
              <span className="muted">{humanise(action)}</span>
              <span className="kbd">{keys}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="settings-group">
        <h3>Diagnostics</h3>
        {diagError ? (
          <div style={{ padding: 20 }}>
            <div className="inline-error">{diagError}</div>
          </div>
        ) : diag ? (
          <>
            <dl className="diag-grid">
              <dt>App version</dt>
              <dd>{diag.appVersion}</dd>
              <dt>Runtime</dt>
              <dd>{diag.goVersion} · {diag.platform}</dd>
              <dt>Data folder</dt>
              <dd>{diag.dataDir}</dd>
              <dt>Stream proxy</dt>
              <dd>{diag.streamProxy}</dd>
              <dt>Media resolver</dt>
              <dd>
                {diag.resolver.installed ? `yt-dlp ${diag.resolver.version}` : `Not installed — ${diag.resolver.message}`}
              </dd>
              <dt>Resolver path</dt>
              <dd>{diag.resolverBinary || '—'}</dd>
              <dt>Media keys</dt>
              <dd>{diag.mediaKeys}</dd>
              <dt>Tray</dt>
              <dd>{diag.tray}</dd>
            </dl>
            {resolverError && (
              <div style={{ padding: '0 20px 16px' }}>
                <div className="inline-error">{resolverError}</div>
              </div>
            )}
            <div className="setting-row">
              <div className="setting-info">
                <div className="name">Media resolver</div>
                <div className="desc">Downloads the pinned, checksum-verified yt-dlp build into the data folder.</div>
              </div>
              <div className="setting-control">
                <button
                  className="btn ghost"
                  disabled={installing}
                  type="button"
                  onClick={() => {
                    setInstalling(true)
                    backend()
                      .installResolver()
                      .then(() => {
                        ui.toast('Media resolver ready')
                        ui.setResolverError(null)
                        loadDiagnostics()
                      })
                      .catch((err: Error) => ui.toast(err.message, 'error'))
                      .finally(() => setInstalling(false))
                  }}
                >
                  {installing ? 'Installing…' : diag.resolver.installed ? 'Reinstall' : 'Install now'}
                </button>
              </div>
            </div>
          </>
        ) : (
          <div style={{ padding: 20 }} className="muted">
            Loading diagnostics…
          </div>
        )}
      </div>

      <div className="settings-group">
        <h3>Data</h3>
        <Row name="Listening history" desc="Recorded locally when a track actually starts playing.">
          <button className="btn ghost danger" onClick={() => void library.clearHistory()} type="button">
            Clear history
          </button>
        </Row>
        <Row name="Search history" desc="Stored on this device only.">
          <button className="btn ghost danger" onClick={() => void library.clearSearchHistory()} type="button">
            Clear searches
          </button>
        </Row>
      </div>
    </div>
  )
}

function humanise(key: string): string {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase())
    .trim()
}
