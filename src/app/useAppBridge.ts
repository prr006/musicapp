/**
 * Wires backend events → stores. Mounted once in <App/>.
 */

import { useEffect } from "react";

import * as api from "@/app/api";
import { Events } from "@/app/ipc";
import { getBridge, tauriAvailable } from "@/app/ipc";
import { onPlaybackState, onPosition, onQueueView } from "@/app/stores/playback";
import { applySettings, pushToast, uiStore } from "@/app/stores/ui";

export function useAppBridge(): void {
  useEffect(() => {
    const bridge = getBridge();

    // Initial sync (events cover everything after this point).
    void api.getPlaybackState().then(onPlaybackState).catch(noop);
    void api.getQueue().then(onQueueView).catch(noop);
    void api.getSettings().then(applySettings).catch(noop);

    const offs = [
      bridge.on(Events.playbackState, onPlaybackState),
      bridge.on(Events.playbackPosition, onPosition),
      bridge.on(Events.queueView, onQueueView),
      bridge.on(Events.engineStatus, (status) => {
        if (status.message) pushToast(status.message, status.health === "dead" ? "error" : "info");
      }),
    ];

    if (!tauriAvailable()) {
      pushToast("Browser preview — running against the mock backend", "info");
    }

    // Online/offline awareness (spec §30).
    const goOnline = () => {
      uiStore.set({ online: true });
      pushToast("Back online", "success");
    };
    const goOffline = () => {
      uiStore.set({ online: false });
      pushToast("You're offline. Local and downloaded music keeps playing.", "info");
    };
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);

    return () => {
      offs.forEach((off) => off());
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);
}

function noop(): void {}
