#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { SSR_RUNTIME_VIRTUAL_ID } from '../SsrConfigCompileRuntime'
import { createSsrManagedServer, type SsrManagedServerOptions } from '../server/SsrServerRuntime'
import { attachSsrPhaseTimings, createSsrPhaseTimings } from '../SsrDiagnosticsRuntime'
import { importSsrViteModule } from '../vite/SsrViteModuleRuntime'
import { createSsrProductionViteBuildOptions } from './SsrCliBuildOptions'
import { resolveSsrCliHmrPort } from './SsrCliHmrPort'
import { parseSsrCliArguments, type SsrCliOptions } from './SsrCliOptions'
import { createSsrCliDevelopmentViteConfig } from './SsrCliVite'
import {
  createSsrViteCliConfigMarker,
  createSsrViteCliInlineConfig,
} from '../vite/SsrViteCliConfig'
import { createDeploymentBuild } from '../deployment/DeploymentRuntime'
import { reportSsrCliFatal } from './SsrCliFatal'

const runServer = async (options: SsrCliOptions, production: boolean) => {
  const startupTimings = production ? undefined : createSsrPhaseTimings()
  const hmrPort = production
    ? undefined
    : await resolveSsrCliHmrPort(options.hmrPort)
  const createViteServer = production
    ? undefined
    : (await import('vite')).createServer
  let vite: Awaited<ReturnType<NonNullable<typeof createViteServer>>> | undefined
  let managed: Awaited<ReturnType<typeof createSsrManagedServer>> | undefined
  try {
    vite = production
      ? undefined
      : await createViteServer!(createSsrCliDevelopmentViteConfig(options, hmrPort))
    startupTimings?.mark('Vite initialization')
    const managedOptions: SsrManagedServerOptions = {
      production,
      root: options.root,
      config: options.config,
      vite,
      loadRuntime: production
        ? () => import(pathToFileURL(options.serverOutput).href)
        : () => importSsrViteModule(vite!, SSR_RUNTIME_VIRTUAL_ID),
    }
    if (startupTimings) attachSsrPhaseTimings(managedOptions, startupTimings)
    managed = await createSsrManagedServer(managedOptions)
    await managed.listen()
  } catch (error) {
    if (managed) await managed.close().catch(() => undefined)
    else if (vite) await vite.close().catch(() => undefined)
    throw error
  }
  if (!managed) throw new Error('SSR managed server was not created.')
  const listening = managed

  let closing = false
  const close = async (signal: string) => {
    if (closing) return
    closing = true
    try {
      await listening.close()
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
  const deployment = createDeploymentBuild(options.root)
  const { build: viteBuild } = await import('vite')
  const cliInline = createSsrViteCliInlineConfig(options.cliConfig)
  const cliMarker = options.cliConfig
    ? [createSsrViteCliConfigMarker(options.cliConfig)]
    : []
  await viteBuild({
    root: options.root,
    plugins: [...deployment.plugins, ...cliMarker],
    ...cliInline,
  })
  await viteBuild({
    ...createSsrProductionViteBuildOptions(options.root),
    plugins: cliMarker.length ? cliMarker : undefined,
    ...cliInline,
  })
  await deployment.complete(options.serverOutput)
}

const main = async () => {
  const options = await parseSsrCliArguments(process.argv.slice(2))
  if (options.command === 'build') return runBuild(options)
  return runServer(options, options.command === 'start')
}

main().catch((error) => {
  reportSsrCliFatal(process.argv[2], error)
  process.exitCode = 1
})
