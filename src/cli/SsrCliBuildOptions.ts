import { resolve } from 'node:path'
import { SSR_RUNTIME_VIRTUAL_ID } from '../SsrConfigCompileRuntime'

/**
 * Vite 7 `resolveRollupOptions` path-resolves a string `build.ssr` entry against
 * the project root. Virtual ids such as `virtual:vue-ssr-lite/runtime` become
 * filesystem paths like `<root>/virtual:vue-ssr-lite/runtime`, so plugin
 * `resolveId` never matches and Rollup reports `UNRESOLVED_ENTRY`.
 *
 * Pass the virtual module through `rollupOptions.input` with `build.ssr: true`
 * instead — that path is not filesystem-resolved.
 */
export const createSsrProductionViteBuildOptions = (root: string) => ({
  root,
  build: {
    ssr: true as const,
    outDir: resolve(root, 'dist/server'),
    emptyOutDir: true,
    rollupOptions: {
      input: SSR_RUNTIME_VIRTUAL_ID,
      output: { entryFileNames: 'SsrRuntime.js' },
    },
  },
})
