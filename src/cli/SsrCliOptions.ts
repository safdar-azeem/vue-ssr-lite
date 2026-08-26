import { access, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { resolveSsrConfigPath } from '../SsrConfigCompileRuntime'

export type SsrCliCommand = 'dev' | 'build' | 'start'

export interface SsrCliOptions {
  command: SsrCliCommand
  root: string
  /**
   * Absolute path to optional `ssr.config.*` overrides. Production `start`
   * loads the baked runtime and never reads source config.
   */
  config?: string
  serverOutput: string
  hmrPort?: string
}

const DEFAULT_SERVER_OUTPUT = 'dist/server/SsrRuntime.js'

const readFlag = (args: string[], name: string): string | undefined => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

const assertProductionRuntimeExists = async (serverOutput: string) => {
  try {
    await access(serverOutput)
  } catch {
    throw new Error(
      `vue-ssr-lite start could not find the production SSR runtime at ${serverOutput}. ` +
        'Run `vue-ssr-lite build` first. Production start loads the baked runtime ' +
        'and does not require ssr.config.* in the working directory.'
    )
  }
}

/**
 * Parse CLI argv for `vue-ssr-lite <dev|build|start>`.
 *
 * - `dev` / `build` use conventions plus optional `ssr.config.*` overrides.
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
      'Usage: vue-ssr-lite <dev|build|start> [--root .] [--config ssr.config.ts] [--hmr-port 31001]'
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

  if (command === 'start') {
    await assertProductionRuntimeExists(serverOutput)
    return {
      command: 'start',
      root,
      serverOutput,
      hmrPort,
    }
  }

  const config = await resolveSsrConfigPath(root, readFlag(args, '--config'))
  return {
    command: command as Exclude<SsrCliCommand, 'start'>,
    root,
    config,
    serverOutput,
    hmrPort,
  }
}
