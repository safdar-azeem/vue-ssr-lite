import { mkdir, symlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Server } from 'node:http'
import type { Component } from 'vue'
import type { SsrDomainContext } from './SsrConfigTypes'
import type { SsrMainModule } from './SsrConfigTypes'
import type {
  SsrResolvedApplicationDefinition,
  SsrRenderRequest,
} from './SsrRuntimeTypes'

/** Shared domain snapshot for unit tests that construct render requests. */
export const createTestDomain = (
  host: string,
  overrides: Partial<SsrDomainContext> = {}
): SsrDomainContext => ({
  entry: 'test',
  authority: host,
  protocol: 'https',
  port: '',
  hostname: host,
  baseDomain: host,
  subdomain: null,
  isCustomDomain: false,
  development: true,
  params: {},
  ...overrides,
})

export const createTestRenderRequest = <TPublicConfig = unknown>(
  host: string,
  overrides: Partial<SsrRenderRequest<TPublicConfig>> & {
    publicConfig?: TPublicConfig
  } = {}
): SsrRenderRequest<TPublicConfig> => {
  const { publicConfig, domain, ...rest } = overrides
  return {
    requestId: host,
    url: `https://${host}/`,
    host,
    protocol: 'https',
    method: 'GET',
    headers: {},
    publicConfig: (publicConfig ?? {}) as TPublicConfig,
    signal: new AbortController().signal,
    domain: domain ?? createTestDomain(host),
    ...rest,
  }
}

/** Internal Vue application definition for renderer unit tests. */
export const createTestApplication = <
  TApplicationState extends Record<string, any> = Record<string, unknown>,
  TPublicConfig = unknown,
>(
  definition: SsrResolvedApplicationDefinition<TApplicationState, TPublicConfig>
): SsrResolvedApplicationDefinition<TApplicationState, TPublicConfig> => definition

/** Attach Core-owned Vue shells for programmatic managed-server tests. */
export const withSsrShells = <T extends object>(
  config: T,
  shells: Record<string, { root: Component; main?: SsrMainModule }>
): T & {
  __vueSsrLiteShells: Record<string, { root: Component; main: SsrMainModule }>
} =>
  Object.assign(config, {
    __vueSsrLiteShells: Object.fromEntries(
      Object.entries(shells).map(([id, shell]) => [
        id,
        { root: shell.root, main: shell.main ?? { default: () => undefined } },
      ])
    ),
  })

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Give a temporary consumer the host-owned Vue/Vue Router package contract. */
export const provisionHostVuePeers = async (root: string): Promise<void> => {
  const modules = join(root, 'node_modules')
  await mkdir(modules, { recursive: true })
  await Promise.all(
    (
      [
        ['vue', join(PACKAGE_ROOT, 'node_modules/vue')],
        ['vue-router', join(PACKAGE_ROOT, 'node_modules/vue-router')],
      ] as const
    ).map(async ([name, target]) => {
      try {
        await symlink(target, join(modules, name))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    })
  )
}

/** Close Vite without waiting for a hung optimizer/HMR socket. */
export const closeViteDevServer = async (
  server?: { close: () => Promise<unknown> },
  hmrServer?: Server
): Promise<void> => {
  const shutdown = (async () => {
    hmrServer?.close()
    await server?.close()
  })().catch(() => undefined)
  await Promise.race([
    shutdown,
    new Promise<void>((resolve) => setTimeout(resolve, 3000)),
  ])
}
