import { createLogger, type InlineConfig, type Logger } from 'vite'
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
    info: (...args: Parameters<Logger['info']>) => base.info(...args),
    warn: (...args: Parameters<Logger['warn']>) => base.warn(...args),
    warnOnce: (...args: Parameters<Logger['warnOnce']>) => base.warnOnce(...args),
    clearScreen: (...args: Parameters<Logger['clearScreen']>) => base.clearScreen(...args),
    get hasWarned() {
      return base.hasWarned
    },
    set hasWarned(value) {
      base.hasWarned = value
    },
    error(...args: Parameters<Logger['error']>) {
      const error = args[1]?.error
      if (error && typeof error === 'object') {
        logged.add(error)
        if (isSsrStructuredViteError(error)) {
          developmentConsole.reportFailure(error)
          return
        }
        developmentConsole.acknowledgeFailure(error)
      }
      base.error(...args)
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
