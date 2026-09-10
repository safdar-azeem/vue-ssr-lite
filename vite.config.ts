import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'

const repositoryRoot = fileURLToPath(new URL('.', import.meta.url))
const rootDeclarationEntry = resolve(repositoryRoot, 'dist/index.d.ts')
const VUE_ROUTER_AUGMENTATION =
  /\n*declare module ['"]vue-router['"] \{[\s\S]*?\n\}\n*/g

export default defineConfig({
  // Public declarations are rolled up per package entry. This keeps the npm
  // artifact from publishing the repository's complete internal type tree or
  // declaration maps that point back to unpublished src/ files.
  plugins: [
    dts({
      rollupTypes: true,
      // vite-plugin-dts collects ambient module augmentations globally and
      // appends them to every rolled entry. Their referenced public types are
      // rooted in index.d.ts, so keep the augmentations on that entry only.
      beforeWriteFile(filePath, content) {
        if (resolve(filePath) === rootDeclarationEntry) return
        return { content: content.replace(VUE_ROUTER_AUGMENTATION, '\n') }
      },
    }),
  ],
  build: {
    lib: {
      entry: {
        index: resolve(repositoryRoot, 'src/index.ts'),
        client: resolve(repositoryRoot, 'src/client.ts'),
        'internal-ssr-renderer': resolve(
          repositoryRoot,
          'src/SsrRenderRuntime.ts'
        ),
        'internal-vercel': resolve(repositoryRoot, 'src/deployment/vercel/VercelRuntime.ts'),
        server: resolve(repositoryRoot, 'src/server.ts'),
        vite: resolve(repositoryRoot, 'src/vite.ts'),
        cli: resolve(repositoryRoot, 'src/cli/SsrCli.ts'),
      },
      formats: ['es'],
      fileName: (_format, entryName) => `${entryName}.mjs`,
    },
    rollupOptions: {
      external: [
        /^node:/,
        'esbuild',
        '@vercel/nft',
        'es-module-lexer',
        'vite',
        'rollup',
        /^rollup(?:\/|$)/,
        /^vue(?:\/|$)/,
        /^vue-router(?:\/|$)/,
      ],
      output: {
        entryFileNames: '[name].mjs',
        chunkFileNames: 'chunks/[name]-[hash].mjs',
      },
    },
  },
})
