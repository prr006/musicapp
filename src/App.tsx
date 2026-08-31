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
import { useUi } from "@/app/stores/ui";
import { HomeView } from "@/views/HomeView";
import { SearchView } from "@/views/SearchView";
import { PlaceholderView } from "@/views/PlaceholderView";

export default function App() {
  useAppBridge();
  useShortcuts();

  const ui = useUi();

  // Apply appearance settings to the document root (spec §26).
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
        <main className="main">
          <TopBar />
          <div className="content">
            {ui.view === "home" && <HomeView />}
            {ui.view === "search" && <SearchView query={ui.searchQuery} />}
            {ui.view !== "home" && ui.view !== "search" && <PlaceholderView view={ui.view} />}
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
