#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { SSR_RUNTIME_VIRTUAL_ID } from '../SsrConfigCompileRuntime'
import { createSsrManagedServer } from '../server/SsrServerRuntime'
import { createSsrProductionViteBuildOptions } from './SsrCliBuildOptions'
import { resolveSsrCliHmrPort } from './SsrCliHmrPort'
import { parseSsrCliArguments, type SsrCliOptions } from './SsrCliOptions'

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
  const options = await parseSsrCliArguments(process.argv.slice(2))
  if (options.command === 'build') return runBuild(options)
  return runServer(options, options.command === 'start')
}

main().catch((error) => {
  console.error('fatal error', error)
  process.exitCode = 1
})
