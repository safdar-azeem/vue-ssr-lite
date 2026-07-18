#!/usr/bin/env node
import { resolve, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createSsrManagedServer } from '../server/SsrServerRuntime'

interface SsrCliOptions {
  command: 'dev' | 'build' | 'start'
  root: string
  runtime: string
  serverOutput: string
}

const readFlag = (args: string[], name: string): string | undefined => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

const parseArguments = (args: string[]): SsrCliOptions => {
  const command = args[0]
  if (!['dev', 'build', 'start'].includes(command)) {
    throw new Error(
      'Usage: vue-ssr-lite <dev|build|start> [--root .] [--runtime src/SsrRuntime.ts]'
    )
  }
  const root = resolve(readFlag(args, '--root') || process.cwd())
  return {
    command: command as SsrCliOptions['command'],
    root,
    runtime: resolve(root, readFlag(args, '--runtime') || 'src/SsrRuntime.ts'),
    serverOutput: resolve(
      root,
      readFlag(args, '--server-output') || 'dist/server/SsrRuntime.js'
    ),
  }
}

const runServer = async (options: SsrCliOptions, production: boolean) => {
  const createViteServer = production
    ? undefined
    : (await import('vite')).createServer
  const vite = production
    ? undefined
    : await createViteServer!({
        root: options.root,
        server: { middlewareMode: true },
        appType: 'custom',
      })
  const runtimeId = `/${relative(options.root, options.runtime).replaceAll('\\', '/')}`
  const managed = await createSsrManagedServer({
    production,
    root: options.root,
    vite,
    loadRuntime: production
      ? () => import(pathToFileURL(options.serverOutput).href)
      : () => vite!.ssrLoadModule(runtimeId),
  })
  await managed.listen()
  const { host, port } = managed.address()
  console.log(`[vue-ssr-lite] listening on ${host}:${port}`)

  let closing = false
  const close = async (signal: string) => {
    if (closing) return
    closing = true
    try {
      await managed.close()
      console.log(`[vue-ssr-lite] stopped after ${signal}`)
      process.exitCode = 0
    } catch (error) {
      console.error('[vue-ssr-lite] graceful shutdown failed', error)
      process.exitCode = 1
    }
  }
  process.once('SIGINT', () => void close('SIGINT'))
  process.once('SIGTERM', () => void close('SIGTERM'))
}

const runBuild = async (options: SsrCliOptions) => {
  const { build: viteBuild } = await import('vite')
  await viteBuild({ root: options.root })
  await viteBuild({
    root: options.root,
    build: {
      ssr: options.runtime,
      outDir: resolve(options.root, 'dist/server'),
      emptyOutDir: true,
      rollupOptions: {
        output: { entryFileNames: 'SsrRuntime.js' },
      },
    },
  })
}

const main = async () => {
  const options = parseArguments(process.argv.slice(2))
  if (options.command === 'build') return runBuild(options)
  return runServer(options, options.command === 'start')
}

main().catch((error) => {
  console.error('[vue-ssr-lite] fatal error', error)
  process.exitCode = 1
})
