#!/usr/bin/env node
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  resolveSsrConfigPath,
  SSR_RUNTIME_VIRTUAL_ID,
} from '../SsrConfigCompileRuntime'
import { createSsrManagedServer } from '../server/SsrServerRuntime'
import { createSsrProductionViteBuildOptions } from './SsrCliBuildOptions'
import { resolveSsrCliHmrPort } from './SsrCliHmrPort'

interface SsrCliOptions {
  command: 'dev' | 'build' | 'start'
  root: string
  config: string
  serverOutput: string
  hmrPort?: string
}

const readFlag = (args: string[], name: string): string | undefined => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

const parseArguments = async (args: string[]): Promise<SsrCliOptions> => {
  const command = args[0]
  if (!['dev', 'build', 'start'].includes(command)) {
    throw new Error(
      'Usage: vue-ssr-lite <dev|build|start> [--root .] [--config ssr.config.ts] [--hmr-port 31001]'
    )
  }
  const root = resolve(readFlag(args, '--root') || process.cwd())
  const config = await resolveSsrConfigPath(root, readFlag(args, '--config'))
  return {
    command: command as SsrCliOptions['command'],
    root,
    config,
    serverOutput: resolve(
      root,
      readFlag(args, '--server-output') || 'dist/server/SsrRuntime.js'
    ),
    hmrPort: readFlag(args, '--hmr-port') || process.env.VUE_SSR_LITE_HMR_PORT,
  }
}

const runServer = async (options: SsrCliOptions, production: boolean) => {
  const hmrPort = production
    ? undefined
    : await resolveSsrCliHmrPort(options.hmrPort)
  const createViteServer = production
    ? undefined
    : (await import('vite')).createServer
  const vite = production
    ? undefined
    : await createViteServer!({
        root: options.root,
        server: {
          middlewareMode: true,
          hmr: { port: hmrPort, clientPort: hmrPort },
        },
        appType: 'custom',
      })
  const managed = await createSsrManagedServer({
    production,
    root: options.root,
    vite,
    loadRuntime: production
      ? () => import(pathToFileURL(options.serverOutput).href)
      : () => vite!.ssrLoadModule(SSR_RUNTIME_VIRTUAL_ID),
  })
  await managed.listen()

  let closing = false
  const close = async (signal: string) => {
    if (closing) return
    closing = true
    try {
      await managed.close()
      console.log(`stopped after ${signal}`)
      process.exitCode = 0
    } catch (error) {
      console.error('graceful shutdown failed', error)
      process.exitCode = 1
    }
  }
  process.once('SIGINT', () => void close('SIGINT'))
  process.once('SIGTERM', () => void close('SIGTERM'))
}

const runBuild = async (options: SsrCliOptions) => {
  const { build: viteBuild } = await import('vite')
  await viteBuild({ root: options.root })
  await viteBuild(createSsrProductionViteBuildOptions(options.root))
}

const main = async () => {
  const options = await parseArguments(process.argv.slice(2))
  if (options.command === 'build') return runBuild(options)
  return runServer(options, options.command === 'start')
}

main().catch((error) => {
  console.error('fatal error', error)
  process.exitCode = 1
})
