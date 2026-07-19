import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'

export default defineConfig({
  plugins: [dts({ insertTypesEntry: true })],
  build: {
    lib: {
      entry: {
        index: resolve(fileURLToPath(new URL('.', import.meta.url)), 'src/index.ts'),
        client: resolve(fileURLToPath(new URL('.', import.meta.url)), 'src/client.ts'),
        server: resolve(fileURLToPath(new URL('.', import.meta.url)), 'src/server.ts'),
        vite: resolve(fileURLToPath(new URL('.', import.meta.url)), 'src/vite.ts'),
        cli: resolve(fileURLToPath(new URL('.', import.meta.url)), 'src/cli/SsrCli.ts'),
      },
      formats: ['es'],
      fileName: (_format, entryName) => `${entryName}.mjs`,
    },
    rollupOptions: {
      external: [
        /^node:/,
        'esbuild',
        '@vue/server-renderer',
        'vite',
        'vue',
        'vue-router',
      ],
      output: {
        entryFileNames: '[name].mjs',
        chunkFileNames: 'chunks/[name]-[hash].mjs',
      },
    },
  },
})
