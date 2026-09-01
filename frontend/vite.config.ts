import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * `main.go` embeds `frontend/dist`, so the directory must exist even in a fresh
 * clone where the build output is gitignored. Vite wipes the folder on every
 * build, so the placeholder is rewritten afterwards.
 */
function keepDistTracked() {
  return {
    name: 'melo-keep-dist-tracked',
    closeBundle() {
      writeFileSync(resolve(__dirname, 'dist/.gitkeep'), '')
    },
  }
}

export default defineConfig({
  plugins: [react(), keepDistTracked()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    // The Wails dev server and the sandbox preview proxy both need to be allowed.
    allowedHosts: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 700,
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
})
