import { createLogger, type InlineConfig, type Logger, type LogErrorOptions } from 'vite'
import {
  createSsrViteCliConfigMarker,
  createSsrViteCliInlineConfig,
} from '../vite/SsrViteCliConfig'
import { isSsrStructuredViteError } from '../SsrDevelopmentErrorDiagnostic'
import {
  createSsrDevelopmentConsole,
  type SsrDevelopmentConsole,
} from './SsrCliDevelopmentConsole'
import type { SsrCliOptions } from './SsrCliOptions'

export const createSsrCliDevelopmentViteLogger = (
  developmentConsole: SsrDevelopmentConsole,
  base: Logger = createLogger()
): Logger => {
  const logged = new WeakSet<object>()
  return {
    ...base,
    info: (msg, options) => base.info(msg, options),
    warn: (msg, options) => base.warn(msg, options),
    warnOnce: (msg, options) => base.warnOnce(msg, options),
    clearScreen: (type) => base.clearScreen(type),
    get hasWarned() {
      return base.hasWarned
    },
    set hasWarned(value) {
      base.hasWarned = value
    },
    error(msg: string, options?: LogErrorOptions) {
      const error = options?.error
      if (error && typeof error === 'object') {
        logged.add(error)
        if (isSsrStructuredViteError(error)) {
          developmentConsole.reportFailure(error)
          return
        }
        developmentConsole.acknowledgeFailure(error)
      }
      base.error(msg, options)
    },
    hasErrorLogged(error: Error) {
      return logged.has(error) || base.hasErrorLogged(error)
    },
  }
}

export const createSsrCliDevelopmentViteConfig = (
  options: Pick<SsrCliOptions, 'root' | 'cliConfig'>,
  hmrPort?: number,
  developmentConsole?: SsrDevelopmentConsole
): InlineConfig => {
  const presenter = developmentConsole ?? createSsrDevelopmentConsole({ root: options.root })
  return {
    root: options.root,
    customLogger: createSsrCliDevelopmentViteLogger(presenter),
    clearScreen: false,
    server: {
      middlewareMode: true,
      hmr: { port: hmrPort, clientPort: hmrPort },
    },
    appType: 'custom',
    ...createSsrViteCliInlineConfig(options.cliConfig),
    plugins: options.cliConfig
      ? [createSsrViteCliConfigMarker(options.cliConfig)]
      : undefined,
  }
}
