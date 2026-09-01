/// <reference types="vitest" />
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Tauri expects a fixed port; fail if it is taken.
const host = process.env.TAURI_DEV_HOST || "0.0.0.0";
const port = 1420;

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  // Vite options tailored for Tauri development.
  //
  // 1. prevent Vite from obscuring Rust errors
  clearScreen: false,
  // 2. Tauri expects a fixed port, fail if that port is not available
  server: {
    host,
    port,
    strictPort: true,
    // The e2b/browser preview proxies a different origin; allow it.
    allowedHosts: true,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      //    (`**/.melo-runtime/**` is the managed-runtime download cache:
      //    watching it would restart the dev server mid-bootstrap)
      ignored: ["**/src-tauri/**", "**/crates/**", "**/.melo-runtime/**"],
    },
  },
  // 4. Env variables starting with TAURI_ are exposed to the frontend
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "chrome110",
    minify: "esbuild",
    sourcemap: false,
  },
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    environmentOptions: { jsdom: { pretendToBeVisual: true } },
    globals: false,
  },
});
