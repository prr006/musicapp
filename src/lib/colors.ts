/**
 * Deterministic artwork colors: real per-track palette when the provider
 * supplied one (mock/sample catalog), otherwise a stable hash-derived
 * gradient. Used for generated fallback tiles and the Now Playing backdrop.
 */

import type { Track } from "@/types/domain";

export function trackColors(t: Track): [string, string] {
  const fromExtra = t.metadata?.extra?.["colors"] as [string, string] | undefined;
  if (fromExtra && Array.isArray(fromExtra) && fromExtra.length === 2) {
    return fromExtra;
  }
  // Deterministic fallback palette from the id hash.
  let h = 0;
  for (const ch of t.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = h % 360;
  return [`hsl(${hue} 80% 55%)`, `hsl(${(hue + 60) % 360} 80% 45%)`];
}
