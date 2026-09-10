import type { Plugin } from 'vite'
import { resolve } from 'node:path'
import { assertSupportedDeploymentEnvironment, resolveDeploymentEnvironment } from './DeploymentEnvironment'

/** Build orchestration only. The application runtime never reads provider markers. */
export const createDeploymentBuild = (root: string, environment = process.env) => {
  const target = resolveDeploymentEnvironment(environment)
  assertSupportedDeploymentEnvironment(target)
  let clientRoot: string | undefined
  const plugins: Plugin[] = target === 'node' ? [] : [{
    name: 'vue-ssr-lite:deployment-output',
    configResolved(config) { clientRoot = resolve(config.root, config.build.outDir) },
  }]
  return {
    plugins,
    async complete(serverOutput: string): Promise<void> {
      if (target === 'node') return
      if (!clientRoot) throw new Error('[vue-ssr-lite] The client build did not report its output directory.')
      if (target === 'vercel') {
        const { buildVercelDeployment } = await import('./vercel/VercelBuild')
        await buildVercelDeployment({ root, clientRoot, serverOutput })
      }
    },
  }
}
