/**
 * Bridge selection: real Tauri IPC inside the desktop app, mock backend for
 * plain-browser development (`npm run dev` outside Tauri).
 *
 * The mock is statically imported for simplicity; inside the packaged app
 * `tauriAvailable()` is always true so the mock path is dead code.
 */

import type { IpcBridge } from "./contract";
import { createMockBridge } from "./mock";
import { tauriAvailable, tauriBridge } from "./tauri";

export * from "./contract";
export { tauriAvailable };

let bridge: IpcBridge | null = null;

export function getBridge(): IpcBridge {
  if (!bridge) {
    bridge = tauriAvailable() ? tauriBridge : createMockBridge();
  }
  return bridge;
}

export type { IpcBridge };
