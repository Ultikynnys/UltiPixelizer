/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BUILD_NUMBER?: string;
  readonly VITE_COMMIT_SHA?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
