/**
 * App shell: sidebar | main content | persistent player, plus overlay panels.
 * Theme/accent/compact attributes are applied from settings here.
 */

import { useEffect } from "react";

import { MiniPlayer } from "@/components/MiniPlayer";
import { NowPlaying } from "@/components/NowPlaying";
import { QueuePanel } from "@/components/QueuePanel";
import { SettingsModal } from "@/components/SettingsModal";
import { Sidebar } from "@/components/Sidebar";
import { Toasts } from "@/components/Toasts";
import { TopBar } from "@/components/TopBar";
import { useAppBridge } from "@/app/useAppBridge";
import { useShortcuts } from "@/app/useShortcuts";
import { useRuntimeStatus, uiStore, useUi } from "@/app/stores/ui";
import { HomeView } from "@/views/HomeView";
import { SearchView } from "@/views/SearchView";
import { LibraryView } from "@/views/LibraryView";

export default function App() {
  useAppBridge();
  useShortcuts();

  const ui = useUi();
  const runtime = useRuntimeStatus();

  // Apply appearance settings to the document root.
  useEffect(() => {
    const root = document.documentElement;
    const resolve = (theme: string): string =>
      theme === "system"
        ? window.matchMedia("(prefers-color-scheme: light)").matches
          ? "light"
          : "dark"
        : theme;
    root.dataset.theme = resolve(ui.settings.theme);
    root.dataset.accent = ui.settings.accent;
    root.dataset.compact = String(ui.settings.compact);
    root.dataset.animations = ui.settings.animations ? "on" : "off";
  }, [ui.settings]);

  return (
    <>
      <div className="app">
        <Sidebar />
        <main className="main" data-route={ui.view}>
          <TopBar />
          {(runtime.phase === "installing" || runtime.phase === "error") && (
            <div
              className={`runtime-banner${runtime.phase === "error" ? " error" : ""}`}
              role="status"
            >
              {runtime.phase === "installing" ? (
                <div className="spinner" />
              ) : null}
              <span className="msg">{runtime.message}</span>
              {runtime.phase === "error" && (
                <button
                  className="button"
                  style={{ padding: "4px 12px", fontSize: 12 }}
                  onClick={() => uiStore.set({ settingsOpen: true })}
                >
                  Repair runtime
                </button>
              )}
            </div>
          )}
          <div className="content">
            {ui.view === "home" && <HomeView />}
            {ui.view === "search" && <SearchView query={ui.searchQuery} />}
            {(ui.view === "liked" ||
              ui.view === "songs" ||
              ui.view === "albums" ||
              ui.view === "artists" ||
              ui.view === "playlists" ||
              ui.view === "recently-played") && <LibraryView view={ui.view} />}
          </div>
        </main>
        <MiniPlayer />
      </div>

      {ui.queueOpen && <QueuePanel />}
      {ui.nowPlayingOpen && <NowPlaying />}
      {ui.settingsOpen && <SettingsModal />}
      <Toasts />
    </>
  );
}
