/**
 * IPC entry point. In the Tauri app the real bridge talks to Rust; in the
 * browser (tests, `npm run dev` preview) the mock bridge simulates the
 * engine. `setBridge` exists for tests that inject a scripted bridge.
 */

import { createMockBridge } from "./mock";
import { createTauriBridge } from "./tauri";
import type { IpcBridge } from "./contract";

let bridge: IpcBridge | null = null;

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

/** True when running inside the Tauri webview (real Rust backend). */
export function tauriAvailable(): boolean {
  return (
    typeof window !== "undefined" &&
    window.__TAURI_INTERNALS__ != null &&
    Object.keys(window.__TAURI_INTERNALS__ as object).length > 0
  );
}

export function getBridge(): IpcBridge {
  if (bridge) return bridge;
  bridge = tauriAvailable() ? createTauriBridge() : createMockBridge();
  return bridge;
}

export function setBridge(b: IpcBridge): void {
  bridge = b;
}

// Re-exports: one import site for the whole contract.
export { Commands, Events } from "./contract";
export type {
  CommandName,
  CommandArgs,
  CommandResult,
  EventName,
  EventPayloads,
  IpcBridge,
} from "./contract";
export { MockLibrary } from "./mock";
