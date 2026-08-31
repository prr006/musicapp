/** Honest phase placeholders for library sections not yet implemented. */

import { Icon, type IconName } from "@/components/Icon";

const INFO: Record<string, { icon: IconName; title: string; phase: string; blurb: string }> = {
  liked: {
    icon: "heart",
    title: "Liked Songs",
    phase: "6",
    blurb:
      "Instant, persistent like/unlike that works offline. The data model is ready; the UI ships with the library phase.",
  },
  songs: {
    icon: "note",
    title: "Songs",
    phase: "6",
    blurb: "Every track you've played or added, in one list.",
  },
  albums: {
    icon: "album",
    title: "Albums",
    phase: "5",
    blurb: "Saved albums with full track lists and artwork. Arrives with YouTube metadata.",
  },
  artists: {
    icon: "artist",
    title: "Artists",
    phase: "5",
    blurb: "Followed artists with popular songs, albums and singles.",
  },
  playlists: {
    icon: "playlist",
    title: "Playlists",
    phase: "6",
    blurb:
      "Create, edit, reorder, duplicate — folders and smart playlists are already part of the data model.",
  },
  downloads: {
    icon: "download",
    title: "Downloads",
    phase: "10",
    blurb:
      "Offline playback with real progress, pause/resume and storage usage — not just saved URLs.",
  },
  "recently-played": {
    icon: "clock",
    title: "Recently Played",
    phase: "9",
    blurb: "A structured listening history that also powers recommendations.",
  },
};

export function PlaceholderView({ view }: { view: string }) {
  const info = INFO[view] ?? {
    icon: "note" as IconName,
    title: "Coming soon",
    phase: "?",
    blurb: "",
  };
  return (
    <div>
      <div className="hero">
        <h1>{info.title}</h1>
        <p>Ships in Phase {info.phase}</p>
      </div>
      <div className="state-block">
        <div className="big">
          <Icon name={info.icon} size={34} />
        </div>
        <p>{info.blurb}</p>
      </div>
    </div>
  );
}
