import type { Plugin } from 'vite'
import { resolve } from 'node:path'
import {
  assertSupportedDeploymentEnvironment,
  resolveDeploymentTarget,
  type ExplicitDeploymentTarget,
} from './DeploymentEnvironment'

export const DEPLOYMENT_OUTPUT_PLUGIN = 'vue-ssr-lite:deployment-output'
/** Carries an explicit `--target` into both client and server Vite builds. */
export const DEPLOYMENT_TARGET_PLUGIN = 'vue-ssr-lite:deployment-target'

type PluginList = readonly unknown[] | undefined
/** The explicit target recorded by the CLI, read from (possibly nested) Vite plugin options. */
export const readExplicitDeploymentTarget = (plugins: PluginList): ExplicitDeploymentTarget | undefined => {
  for (const plugin of (plugins ?? []).flat(Infinity) as Array<Plugin | null | false | undefined>) {
    if (plugin && typeof plugin === 'object' && plugin.name === DEPLOYMENT_TARGET_PLUGIN) {
      return (plugin.api as { target?: ExplicitDeploymentTarget } | undefined)?.target
    }
  }
  return undefined
}

/** Build orchestration only. The application runtime never reads provider markers. */
export const createDeploymentBuild = (
  root: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  explicitTarget?: ExplicitDeploymentTarget
) => {
  const target = resolveDeploymentTarget(explicitTarget, environment)
  assertSupportedDeploymentEnvironment(target)
  let clientRoot: string | undefined
  const plugins: Plugin[] = target === 'node' ? [] : [{
    name: DEPLOYMENT_OUTPUT_PLUGIN,
    configResolved(config) { clientRoot = resolve(config.root, config.build.outDir) },
  }]
  // Ordinary builds stay plugin-free; only an explicit target is recorded.
  const targetPlugins: Plugin[] = explicitTarget
    ? [{ name: DEPLOYMENT_TARGET_PLUGIN, api: { target: explicitTarget } }]
    : []
  return {
    target,
    plugins: [...targetPlugins, ...plugins],
    serverPlugins: targetPlugins,
    async complete(serverOutput: string): Promise<void> {
      if (target === 'node') return
      if (!clientRoot) throw new Error('[vue-ssr-lite] The client build did not report its output directory.')
      if (target === 'vercel') {
        const { buildVercelDeployment } = await import('./vercel/VercelBuild')
        await buildVercelDeployment({ root, clientRoot, serverOutput })
      } else if (target === 'cloudflare') {
        const { buildCloudflareDeployment } = await import('./cloudflare/CloudflareBuild')
        await buildCloudflareDeployment({ root, clientRoot, serverOutput })
      }
    },
  }
}
