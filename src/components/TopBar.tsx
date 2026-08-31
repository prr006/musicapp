import { Icon } from "@/components/Icon";
import { setSearchQuery, uiStore, useUi } from "@/app/stores/ui";

export function TopBar() {
  const ui = useUi();

  return (
    <header className="topbar">
      <div className="search-box">
        <Icon name="search" size={16} />
        <input
          data-global-search
          type="text"
          placeholder="Search songs, artists, albums…"
          value={ui.searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onFocus={() => uiStore.get().searchQuery.trim() || uiStore.set({ view: "search" })}
          onKeyDown={(e) => {
            if (e.key === "Escape") (e.target as HTMLInputElement).blur();
          }}
        />
        <kbd>Ctrl K</kbd>
      </div>

      <div className="topbar-spacer" />

      <div className={`status-dot${ui.online ? "" : " offline"}`} title={ui.online ? "Online" : "Offline"}>
        <span className="dot" />
        {ui.online ? "Online" : "Offline"}
      </div>

      <button
        className="icon-button"
        title="Settings"
        onClick={() => uiStore.set({ settingsOpen: true })}
      >
        <Icon name="settings" size={18} />
      </button>
    </header>
  );
}
