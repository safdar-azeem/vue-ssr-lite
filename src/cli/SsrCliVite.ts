import type { InlineConfig } from 'vite'
import {
  createSsrViteCliConfigMarker,
  createSsrViteCliInlineConfig,
} from '../vite/SsrViteCliConfig'
import type { SsrCliOptions } from './SsrCliOptions'

export const createSsrCliDevelopmentViteConfig = (
  options: Pick<SsrCliOptions, 'root' | 'cliConfig'>,
  hmrPort?: number
): InlineConfig => ({
  root: options.root,
  server: {
    middlewareMode: true,
    hmr: { port: hmrPort, clientPort: hmrPort },
  },
  appType: 'custom',
  ...createSsrViteCliInlineConfig(options.cliConfig),
  plugins: options.cliConfig
    ? [createSsrViteCliConfigMarker(options.cliConfig)]
    : undefined,
})
