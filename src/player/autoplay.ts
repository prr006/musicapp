/**
 * Autoplay — a SEPARATE service from the queue (they are different
 * concepts). When the explicit queue is exhausted, autoplay may continue
 * with music the library already knows (most-played artists first). The
 * engine and queue know nothing about this module; the controller asks
 * only when the queue is actually exhausted.
 *
 * Default: OFF (the user's "Autoplay similar music" setting enables it).
 */

import type { Track } from "@/types/domain";

export interface AutoplayService {
  enabled: boolean;
  /** Update the track pool the service may pick from. */
  setPool(tracks: Track[]): void;
  /** Artist-id → play-count weights (drives "most-played first"). */
  setPlayCounts(counts: Record<string, number>): void;
  /** Reflect the user setting (Settings → Playback). */
  setEnabled(enabled: boolean): void;
  /** Pick the next track to continue playback, or null to stop. */
  pickNext(recent: Track[]): Promise<Track | null>;
}

/**
 * Local recommender: prefers the user's most-played artists (from history
 * play counts, supplied as `weights`), avoids whatever just played.
 */
class LocalAutoplayService implements AutoplayService {
  enabled = false;
  private pool: Track[] = [];
  private playCounts = new Map<string, number>();

  setPool(tracks: Track[]): void {
    this.pool = tracks.filter((t) => t && typeof t.id === "string");
  }

  setPlayCounts(counts: Record<string, number>): void {
    this.playCounts = new Map(Object.entries(counts));
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  async pickNext(recent: Track[]): Promise<Track | null> {
    if (!this.enabled || this.pool.length === 0) return null;
    const recentIds = new Set(recent.slice(0, 8).map((t) => t.id));
    const candidates = this.pool.filter((t) => !recentIds.has(t.id));
    if (candidates.length === 0) return null;
    // Most-played artist first, stable order inside an artist.
    const weight = (t: Track): number => {
      const artistId = t.artists[0]?.id ?? t.id;
      return this.playCounts.get(artistId) ?? 0;
    };
    let best = candidates[0]!;
    let bestWeight = -1;
    for (const t of candidates) {
      const w = weight(t);
      if (w > bestWeight) {
        best = t;
        bestWeight = w;
      }
    }
    return best;
  }
}

export const autoplayService: AutoplayService = new LocalAutoplayService();
