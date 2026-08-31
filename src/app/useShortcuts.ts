/**
 * Global keyboard shortcuts (spec §21).
 * Never hijacks keys while typing in inputs/contentEditable.
 * Modifiers map Ctrl (Win/Linux) / Cmd (macOS).
 */

import { useEffect } from "react";

import * as api from "@/app/api";
import { playbackStore } from "@/app/stores/playback";
import { openNowPlaying, toggleQueue, uiStore } from "@/app/stores/ui";

const MOD =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
    ? "Meta"
    : "Control";

export function useShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        !!target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);
      const mod = e.ctrlKey || e.metaKey;
      void MOD; // (platform note only; we accept both ctrl & cmd above)

      // Ctrl/Cmd+K works even while typing (it *is* a search shortcut).
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        const input = document.querySelector<HTMLInputElement>("[data-global-search]");
        input?.focus();
        input?.select();
        return;
      }
      if (typing) return;

      if (mod && e.key === "ArrowRight") {
        e.preventDefault();
        void api.next();
        return;
      }
      if (mod && e.key === "ArrowLeft") {
        e.preventDefault();
        void api.previous();
        return;
      }
      if (mod) return; // don't swallow other app/browser shortcuts

      switch (e.key) {
        case " ":
          e.preventDefault();
          void api.togglePlay();
          break;
        case "ArrowRight":
          e.preventDefault();
          void api.seekBy(5);
          break;
        case "ArrowLeft":
          e.preventDefault();
          void api.seekBy(-5);
          break;
        case "ArrowUp":
          e.preventDefault();
          volumeNudge(+5);
          break;
        case "ArrowDown":
          e.preventDefault();
          volumeNudge(-5);
          break;
        case "m":
        case "M":
          void api.toggleMute();
          break;
        case "s":
        case "S":
          void api.setShuffle(!playbackStore.get().shuffle);
          break;
        case "r":
        case "R":
          cycleRepeat();
          break;
        case "l":
        case "L":
          openNowPlaying(true);
          break;
        case "q":
        case "Q":
          toggleQueue();
          break;
        case "Escape":
          if (uiStore.get().nowPlayingOpen) openNowPlaying(false);
          break;
        default:
          break;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

function volumeNudge(delta: number): void {
  const current = playbackStore.get().volume;
  void api.setVolume(Math.min(100, Math.max(0, current + delta)));
}

function cycleRepeat(): void {
  const order = ["off", "all", "one"] as const;
  const current = playbackStore.get().repeat;
  const nextMode = order[(order.indexOf(current) + 1) % order.length];
  void api.setRepeat(nextMode);
}
