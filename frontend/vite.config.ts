import { defineConfig, type ResolvedConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * `main.go` embeds `frontend/dist`, so the directory must exist even in a fresh
 * clone where the build output is gitignored. Vite wipes the folder on every
 * build, so the placeholder is rewritten afterwards.
 */
function requireVercelAPI() {
  return {
    name: 'melo-require-vercel-api',
    configResolved(config: ResolvedConfig) {
      if (config.mode !== 'production' || !process.env.VERCEL) return
      const value = process.env.VITE_MELO_API_URL?.trim()
      let valid = false
      try {
        const url = new URL(value ?? '')
        valid = url.protocol === 'https:' && url.pathname.replace(/\/$/, '').endsWith('/api/v1')
      } catch {
        valid = false
      }
      if (!valid) {
        throw new Error('VITE_MELO_API_URL must be an HTTPS /api/v1 URL for Vercel production builds')
      }
    },
  }
}

function keepDistTracked() {
  return {
    name: 'melo-keep-dist-tracked',
    closeBundle() {
      writeFileSync(resolve(__dirname, 'dist/.gitkeep'), '')
    },
  }
}

export default defineConfig({
  plugins: [react(), requireVercelAPI(), keepDistTracked()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    // The Wails dev server and the sandbox preview proxy both need to be allowed.
    allowedHosts: true,
    // Browser code always uses a relative URL in development. This also works
    // through Arena/Vercel-style preview hosts where localhost is the user's
    // machine rather than the sandbox/container.
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: false,
      },
      '/health': { target: 'http://127.0.0.1:8080', changeOrigin: false },
      '/ready': { target: 'http://127.0.0.1:8080', changeOrigin: false },
    },
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
