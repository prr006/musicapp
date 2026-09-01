/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MELO_MOCK?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
