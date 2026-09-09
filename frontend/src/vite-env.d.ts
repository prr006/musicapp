/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MELO_MOCK?: string
  readonly VITE_MELO_YOUTUBE_IFRAME_SPIKE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
