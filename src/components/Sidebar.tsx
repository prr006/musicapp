import { Icon, type IconName } from "@/components/Icon";
import { navigate, useUi, type ViewKey } from "@/app/stores/ui";

interface NavEntry {
  view: ViewKey;
  label: string;
  icon: IconName;
  phase?: string;
}

const MAIN: NavEntry[] = [
  { view: "home", label: "Home", icon: "home" },
  { view: "search", label: "Search", icon: "search" },
];

const LIBRARY: NavEntry[] = [
  { view: "liked", label: "Liked Songs", icon: "heart" },
  { view: "songs", label: "Songs", icon: "note", phase: "6" },
  { view: "albums", label: "Albums", icon: "album" },
  { view: "artists", label: "Artists", icon: "artist" },
  { view: "playlists", label: "Playlists", icon: "playlist", phase: "6" },
  { view: "downloads", label: "Downloads", icon: "download", phase: "10" },
  { view: "recently-played", label: "Recently Played", icon: "clock", phase: "9" },
];

function NavButton({ entry }: { entry: NavEntry }) {
  const active = useUi().view === entry.view;
  return (
    <button
      className={`nav-item${active ? " active" : ""}`}
      onClick={() => navigate(entry.view)}
      title={entry.label}
    >
      <Icon name={entry.icon} size={19} />
      <span className="nav-label">{entry.label}</span>
      {entry.phase && <span className="phase-tag">P{entry.phase}</span>}
    </button>
  );
}

export function Sidebar() {
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

      <div className="sidebar-footer">
        <span>v0.1 · Phase 1</span>
      </div>
    </aside>
  );
}
