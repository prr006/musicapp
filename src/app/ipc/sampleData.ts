/**
 * Fictional sample catalog for the browser dev preview (mock adapter only).
 * No real artists, no network. Colors drive generated artwork gradients.
 */

import type { AlbumLite, ArtistLite, Track } from "@/types/domain";

function track(
  n: number,
  title: string,
  artist: { id: string; name: string },
  album: { id: string; title: string },
  durationSecs: number,
  colors: [string, string],
): Track {
  return {
    id: `sample:${n}`,
    source: "youtube",
    sourceId: `sample${n}`,
    title,
    artists: [{ id: artist.id, name: artist.name }],
    album: { id: album.id, title: album.title },
    durationSecs,
    artwork: null,
    isLocal: false,
    metadata: { extra: { colors } },
  };
}

export const SAMPLE_ARTISTS: ArtistLite[] = [
  { id: "sampleart:1", name: "Aster Vale", artwork: null, description: "Dream-pop from the northern coast.", followerCount: 128_400, isFollowed: false },
  { id: "sampleart:2", name: "Nova Piper", artwork: null, description: "Synthwave, tape hiss, neon.", followerCount: 96_100, isFollowed: false },
  { id: "sampleart:3", name: "Edien", artwork: null, description: "Ambient ballads.", followerCount: 210_500, isFollowed: false },
  { id: "sampleart:4", name: "Juno Waves", artwork: null, description: "Analog hearts, digital oceans.", followerCount: 54_800, isFollowed: false },
];

export const SAMPLE_ALBUMS: AlbumLite[] = [
  { id: "samplealb:1", title: "Afterglow", artists: [{ id: "sampleart:1", name: "Aster Vale" }], year: 2024, artwork: null, trackCount: 2, isSaved: false },
  { id: "samplealb:2", title: "Static Bloom", artists: [{ id: "sampleart:2", name: "Nova Piper" }], year: 2023, artwork: null, trackCount: 2, isSaved: false },
  { id: "samplealb:3", title: "Slow Light", artists: [{ id: "sampleart:3", name: "Edien" }], year: 2025, artwork: null, trackCount: 2, isSaved: false },
  { id: "samplealb:4", title: "Analog Heart", artists: [{ id: "sampleart:4", name: "Juno Waves" }], year: 2022, artwork: null, trackCount: 2, isSaved: false },
];

export const SAMPLE_TRACKS: Track[] = [
  track(1, "Neon River", { id: "sampleart:1", name: "Aster Vale" }, { id: "samplealb:1", title: "Afterglow" }, 222, ["#7c5cff", "#2bd9ff"]),
  track(2, "Glass Horizon", { id: "sampleart:1", name: "Aster Vale" }, { id: "samplealb:1", title: "Afterglow" }, 245, ["#5cffd2", "#5c7cff"]),
  track(3, "Midnight Cartography", { id: "sampleart:2", name: "Nova Piper" }, { id: "samplealb:2", title: "Static Bloom" }, 198, ["#ff6b9d", "#ffb86c"]),
  track(4, "Static Bloom", { id: "sampleart:2", name: "Nova Piper" }, { id: "samplealb:2", title: "Static Bloom" }, 301, ["#ff9d6b", "#ff6b9d"]),
  track(5, "Paper Satellites", { id: "sampleart:3", name: "Edien" }, { id: "samplealb:3", title: "Slow Light" }, 284, ["#2bffb3", "#0ea5e9"]),
  track(6, "Slow Light", { id: "sampleart:3", name: "Edien" }, { id: "samplealb:3", title: "Slow Light" }, 237, ["#0ea5e9", "#2bffb3"]),
  track(7, "Cassette Sunrise", { id: "sampleart:4", name: "Juno Waves" }, { id: "samplealb:4", title: "Analog Heart" }, 213, ["#ffb020", "#ff5e5e"]),
  track(8, "Analog Heart", { id: "sampleart:4", name: "Juno Waves" }, { id: "samplealb:4", title: "Analog Heart" }, 252, ["#ff5e5e", "#ffb020"]),
];

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

/** Synced lyrics for two demo tracks (fictional). */
export const SAMPLE_LYRICS: Record<string, string> = {
  "sample:1": [
    "[00:00.00](instrumental)",
    "[00:12.50]Streetlight halos on the water",
    "[00:18.20]A neon river running colder",
    "[00:23.90]I followed echoes down the boulevard",
    "[00:29.60]Every window held a dying star",
    "[00:35.42]And the city sang in violet",
    "[00:41.10]Every siren sounded silent",
    "[00:46.80]We were ghosts inside the glow",
    "[00:52.40]Drifting where the undertows go",
    "[01:00.00](instrumental)",
    "[01:23.42]Neon river, carry me out",
    "[01:29.10]Past the bridges, past the doubt",
    "[01:34.80]If the morning never comes",
    "[01:40.50]I will float where you become",
    "[01:46.20]The only light I know",
    "[02:10.00]Neon river, carry me home",
    "[02:20.00]Carry me home",
    "[02:40.00](outro)",
  ].join("\n"),
  "sample:5": [
    "[00:00.00](instrumental)",
    "[00:15.00]We folded dreams into paper planes",
    "[00:21.00]Launched them off the fire escape",
    "[00:27.00]Every one became a satellite",
    "[00:33.00]Circling the kitchen light",
    "[00:45.00]Paper satellites, burning bright",
    "[00:51.00]Little signals in the night",
    "[01:10.00]If one comes down, let it be mine",
    "[01:20.00]I'll be there on the landing line",
    "[01:45.00](outro)",
  ].join("\n"),
};
