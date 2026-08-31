/**
 * Wires backend events → stores + initial sync. Mounted once in <App/>.
 */

import { useEffect } from "react";

import * as api from "@/app/api";
import { getBridge, tauriAvailable } from "@/app/ipc";
import { wireEvents } from "@/app/wiring";
import { applySettings, pushToast, uiStore } from "@/app/stores/ui";
import { onLibraryUpdated } from "@/app/stores/library";
import { onPlaybackState, onQueueView } from "@/app/stores/playback";

export function useAppBridge(): void {
  useEffect(() => {
    const wiring = wireEvents();

    // Initial sync — read-only commands; restart must NOT auto-play (§8).
    void api.getPlaybackState().then(onPlaybackState).catch(noop);
    void api.getQueue().then(onQueueView).catch(noop);
    void api.getSettings().then(applySettings).catch(noop);
    void api.getLibrary().then(onLibraryUpdated).catch(noop);

    if (!tauriAvailable()) {
      pushToast("Browser preview — mock backend (no real playback)", "info");
    }

    // Online/offline awareness (spec §30).
    const goOnline = () => {
      uiStore.set({ online: true });
      pushToast("Back online", "success");
    };
    const goOffline = () => {
      uiStore.set({ online: false });
      pushToast("You're offline — playback of local files continues", "info");
    };
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);

    // Re-read library when the window regains focus (external changes are
    // not expected, but this keeps the mirror honest for cheap).
    return () => {
      wiring.dispose();
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
      void getBridge();
    };
  }, []);
}

function noop(): void {}
