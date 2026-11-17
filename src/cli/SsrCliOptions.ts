import { access, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { resolveSsrConfigPath } from '../config/compile/SsrConfigCompileRuntime'
import { EXPLICIT_DEPLOYMENT_TARGETS, type ExplicitDeploymentTarget } from '../deployment/DeploymentEnvironment'

export type SsrCliCommand = 'dev' | 'build' | 'start'

export interface SsrCliOptions {
  command: SsrCliCommand
  root: string
  /**
   * Absolute path to the resolved server config. For `dev` / `build` this is
   * either an explicit `--config` path or a convention-discovered `server.ts`.
   * Production `start` never reads source config.
   */
  config?: string
  /**
   * Absolute path from an explicit `--config` flag. Distinct from `config`,
   * which may be convention-discovered. Only this value is authoritative for
   * the Vite runtime graph.
   */
  cliConfig?: string
  serverOutput: string
  hmrPort?: string
  /** `build --target cloudflare`; absent for ordinary builds. */
  target?: ExplicitDeploymentTarget
}

const DEFAULT_SERVER_OUTPUT = 'dist/server/SsrRuntime.js'

const readFlag = (args: string[], name: string): string | undefined => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

const readTarget = (args: string[], command: string): ExplicitDeploymentTarget | undefined => {
  const values = args.flatMap((arg, index) =>
    arg === '--target' ? [args[index + 1] ?? ''] : arg.startsWith('--target=') ? [arg.slice(9)] : []
  )
  if (!values.length) return undefined
  if (command !== 'build') throw new Error('`--target` is only supported by `vue-ssr-lite build`.')
  const unique = [...new Set(values)]
  if (unique.length > 1) {
    throw new Error(`Conflicting deployment targets: ${unique.map((value) => JSON.stringify(value)).join(', ')}. Pass one --target.`)
  }
  const target = unique[0]!
  if (!(EXPLICIT_DEPLOYMENT_TARGETS as readonly string[]).includes(target)) {
    throw new Error(`Unsupported deployment target ${JSON.stringify(target)}. Supported targets: ${EXPLICIT_DEPLOYMENT_TARGETS.join(', ')}.`)
  }
  return target as ExplicitDeploymentTarget
}

const assertProductionRuntimeExists = async (serverOutput: string) => {
  try {
    await access(serverOutput)
  } catch {
    throw new Error(
      `vue-ssr-lite start could not find the production SSR runtime at ${serverOutput}. ` +
        'Run `vue-ssr-lite build` first. Production start loads the baked runtime ' +
        'and does not require server.ts in the working directory.'
    )
  }
}

/**
 * Parse CLI argv for `vue-ssr-lite <dev|build|start>`.
 *
 * - `dev` / `build` use conventions plus optional `server.ts`.
 * - `start` only requires the baked server bundle (`--server-output` or
 *   `dist/server/SsrRuntime.js`) so slim production images need not COPY
 *   source config.
 */
export const parseSsrCliArguments = async (
  args: string[]
): Promise<SsrCliOptions> => {
  const command = args[0]
  if (!['dev', 'build', 'start'].includes(command)) {
    throw new Error(
      'Usage: vue-ssr-lite <dev|build|start> [--root .] [--config server.ts] [--hmr-port 31001] [--target cloudflare]'
    )
  }
  // Vite's watcher and custom-base module URLs resolve filesystem paths to
  // their canonical form. Use that same root throughout the CLI so a symlink
  // such as macOS's /tmp -> /private/tmp cannot split lifecycle ownership.
  const root = await realpath(resolve(readFlag(args, '--root') || process.cwd()))
  const serverOutput = resolve(
    root,
    readFlag(args, '--server-output') || DEFAULT_SERVER_OUTPUT
  )
  const hmrPort = readFlag(args, '--hmr-port') || process.env.VUE_SSR_LITE_HMR_PORT
  const target = readTarget(args, command)

  if (command === 'start') {
    await assertProductionRuntimeExists(serverOutput)
    return {
      command: 'start',
      root,
      serverOutput,
      hmrPort,
    }
  }

  const configFlag = readFlag(args, '--config')
  const config = await resolveSsrConfigPath(root, configFlag)
  return {
    command: command as Exclude<SsrCliCommand, 'start'>,
    root,
    config,
    cliConfig: configFlag ? config : undefined,
    serverOutput,
    hmrPort,
    ...(target ? { target } : {}),
  }
}
