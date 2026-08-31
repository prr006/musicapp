/**
 * Sidebar navigation. Queue is a drawer toggle, not a route.
 */

import { Icon, type IconName } from "@/components/Icon";
import { queueStore } from "@/app/stores/playback";
import { navigate, openPlaylist, toggleQueue, useUi, type ViewKey } from "@/app/stores/ui";
import { useStore } from "@/app/store";

interface NavEntry {
  view: ViewKey;
  label: string;
  icon: IconName;
}

const MAIN: NavEntry[] = [
  { view: "home", label: "Home", icon: "home" },
  { view: "search", label: "Search", icon: "search" },
];

const LIBRARY: NavEntry[] = [
  { view: "playlists", label: "Playlists", icon: "playlist" },
  { view: "liked", label: "Liked Songs", icon: "heart" },
  { view: "recently-played", label: "Recently Played", icon: "clock" },
  { view: "songs", label: "Songs", icon: "note" },
  { view: "albums", label: "Albums", icon: "album" },
  { view: "artists", label: "Artists", icon: "artist" },
];

function NavButton({ entry }: { entry: NavEntry }) {
  const active = useUi().view === entry.view;
  return (
    <button
      className={`nav-item${active ? " active" : ""}`}
      onClick={() => {
        if (entry.view === "playlists") openPlaylist(null);
        navigate(entry.view);
      }}
      title={entry.label}
    >
      <Icon name={entry.icon} size={19} />
      <span className="nav-label">{entry.label}</span>
    </button>
  );
}

export function Sidebar() {
  const queueOpen = useUi().queueOpen;
  const upcoming = useStore(queueStore, (s) => s.upcoming.length);

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">
          <Icon name="note" size={16} filled />
        </div>
        <span className="brand-name">MELO</span>
      </div>

      {MAIN.map((e) => (
        <NavButton key={e.view} entry={e} />
      ))}

      <div className="nav-section">Library</div>
      {LIBRARY.map((e) => (
        <NavButton key={e.view} entry={e} />
      ))}

      <button
        className={`nav-item${queueOpen ? " active" : ""}`}
        onClick={toggleQueue}
        title="Queue"
      >
        <Icon name="queue" size={19} />
        <span className="nav-label">Queue</span>
        {upcoming > 0 && <span className="nav-badge">{upcoming}</span>}
      </button>

      <div className="sidebar-footer">
        <span>v0.1</span>
      </div>
    </aside>
  );
}
