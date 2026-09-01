import type { Settings } from '../bridge/types'

export function defaultSettings(): Settings {
  return {
    theme: 'dark',
    accent: 'ember',
    autoplay: true,
    defaultSpeed: 1,
    audioQuality: 'high',
    restoreSession: true,
    resumeOnStartup: false,
    mediaKeys: true,
    minimizeToTray: true,
    notifications: true,
    showLyrics: true,
    volume: 0.9,
    muted: false,
    shortcuts: {
      playPause: 'Space',
      next: 'Ctrl+Right',
      previous: 'Ctrl+Left',
      seekFwd: 'Right',
      seekBack: 'Left',
      volumeUp: 'Up',
      volumeDown: 'Down',
      mute: 'M',
      shuffle: 'S',
      repeat: 'R',
      like: 'L',
      search: 'Ctrl+K',
      queue: 'Q',
      lyrics: 'Y',
    },
  }
}

export const ACCENTS: Record<string, { label: string; value: string; contrast: string }> = {
  ember: { label: 'Ember', value: '#ff6a3d', contrast: '#1a0b05' },
  iris: { label: 'Iris', value: '#7c6cff', contrast: '#0b0919' },
  mint: { label: 'Mint', value: '#31c48d', contrast: '#04150e' },
  sky: { label: 'Sky', value: '#38a3f1', contrast: '#04121d' },
  rose: { label: 'Rose', value: '#f0568b', contrast: '#1c060f' },
}

export const SPEEDS = [0.75, 0.9, 1, 1.1, 1.25, 1.5, 2]
