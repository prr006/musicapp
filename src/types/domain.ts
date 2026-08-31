/**
 * TypeScript mirrors of the Rust domain model (crates/melo-core/src/domain.rs).
 *
 * These types are the single source of truth for the IPC boundary. Field
 * names match the Rust `#[serde(rename_all = "camelCase")]` output exactly.
 * When you change a Rust type, change it here in the same commit.
 */

export type TrackSource = "youtube" | "local";

export interface ArtistRef {
  id: string;
  name: string;
}

export interface AlbumRef {
  id: string;
  title: string;
}

export interface TrackMetadata {
  year?: number;
  codec?: string;
  bitrateKbps?: number;
  genre?: string;
  isrc?: string;
  streamUrl?: string;
  extra?: Record<string, unknown>;
}

export interface Track {
  id: string;
  source: TrackSource;
  sourceId: string;
  title: string;
  artists: ArtistRef[];
  album: AlbumRef | null;
  durationSecs: number | null;
  artwork: string | null;
  isLocal: boolean;
  metadata: TrackMetadata;
}

export interface QueueItem {
  id: string;
  track: Track;
}

export type RepeatMode = "off" | "all" | "one";

export interface QueueView {
  current: QueueItem | null;
  upcoming: QueueItem[];
  /** Most-recent-first. */
  history: QueueItem[];
  shuffle: boolean;
  repeat: RepeatMode;
  rev: number;
}

export type PlaybackStatus =
  | "idle"
  | "loading"
  | "playing"
  | "paused"
  | "buffering"
  | "error";

export interface PlaybackSnapshot {
  status: PlaybackStatus;
  currentItemId: string | null;
  currentTrack: Track | null;
  positionSecs: number;
  durationSecs: number | null;
  volume: number;
  muted: boolean;
  speed: number;
  shuffle: boolean;
  repeat: RepeatMode;
  bufferingPct: number | null;
  error: string | null;
  queueRev: number;
}

export interface PositionUpdate {
  positionSecs: number;
  durationSecs: number | null;
  speed: number;
}

export type Theme = "dark" | "light" | "system";
export type AudioQuality = "low" | "standard" | "high" | "highest";
export type CloseAction = "quit" | "minimize-to-tray";

export interface Settings {
  theme: Theme;
  accent: string;
  animations: boolean;
  reducedMotion: boolean;
  compact: boolean;
  showLyricsTranslation: boolean;
  audioQuality: AudioQuality;
  volumeNormalization: boolean;
  crossfadeSecs: number;
  gapless: boolean;
  autoplaySimilar: boolean;
  resumeLastSession: boolean;
  closeAction: CloseAction;
  notificationsTrackChange: boolean;
  historyEnabled: boolean;
  downloadDir: string | null;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "dark",
  accent: "violet",
  animations: true,
  reducedMotion: false,
  compact: false,
  showLyricsTranslation: false,
  audioQuality: "standard",
  volumeNormalization: false,
  crossfadeSecs: 0,
  gapless: true,
  autoplaySimilar: true,
  resumeLastSession: false,
  closeAction: "quit",
  notificationsTrackChange: false,
  historyEnabled: true,
  downloadDir: null,
};

export interface LyricLine {
  timeMs: number | null;
  text: string;
  translation?: string;
  pronunciation?: string;
}

export interface Lyrics {
  synced: boolean;
  provider: string;
  lines: LyricLine[];
  durationMs?: number;
}

export interface SearchResults {
  tracks: Track[];
  artists: ArtistLite[];
  albums: AlbumLite[];
  playlists: PlaylistLite[];
  query: string;
}

export interface ArtistLite {
  id: string;
  name: string;
  artwork: string | null;
  description: string | null;
  followerCount: number | null;
  isFollowed: boolean;
}

export interface AlbumLite {
  id: string;
  title: string;
  artists: ArtistRef[];
  year: number | null;
  artwork: string | null;
  trackCount: number;
  isSaved: boolean;
}

export interface PlaylistLite {
  id: string;
  title: string;
  description: string | null;
  artwork: string | null;
  trackCount: number;
}

export interface EngineStatusEvent {
  health: "starting" | "running" | "restarting" | "dead";
  message: string;
}

/** Small helper used across list UIs. */
export function artistLine(track: Track): string {
  return track.artists.length
    ? track.artists.map((a) => a.name).join(", ")
    : "Unknown artist";
}
