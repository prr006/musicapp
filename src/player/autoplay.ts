/**
 * Autoplay — a SEPARATE service from the queue (they are different
 * concepts). When the explicit queue is exhausted, autoplay may propose
 * related music so playback can continue. Default: OFF, configurable.
 *
 * The engine and queue know nothing about this module; the controller asks
 * only when the queue is actually exhausted.
 */

import type { Track } from "@/types/domain";

export interface AutoplayService {
  enabled: boolean;
  /** Pick the next track to continue playback, or null to stop. */
  pickNext(recent: Track[]): Promise<Track | null>;
}

/**
 * Phase 1 implementation: disabled. The recommendation source (YouTube
 * mixes / related searches via the search provider) lands with the
 * discovery phase — the hook point is already here and tested.
 */
class DisabledAutoplayService implements AutoplayService {
  enabled = false;

  async pickNext(_recent: Track[]): Promise<Track | null> {
    return null;
  }
}

export const autoplayService: AutoplayService = new DisabledAutoplayService();
