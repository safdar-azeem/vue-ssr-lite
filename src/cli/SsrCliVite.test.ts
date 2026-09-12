import { describe, expect, it } from 'vitest'
import {
  createSsrViteCliConfigMarker,
  readSsrViteCliConfig,
  SSR_VITE_CLI_CONFIG_KEY,
  SSR_VITE_CLI_CONFIG_PLUGIN,
} from '../vite/SsrViteCliConfig'
import { createSsrCliDevelopmentViteConfig } from './SsrCliVite'

describe('createSsrCliDevelopmentViteConfig', () => {
  it('forwards an explicit CLI config into the Vite inline config', () => {
    const config = createSsrCliDevelopmentViteConfig(
      { root: '/app', cliConfig: '/app/config/platform.ts' },
      31001
    )
    expect(config).toMatchObject({
      root: '/app',
      appType: 'custom',
      [SSR_VITE_CLI_CONFIG_KEY]: '/app/config/platform.ts',
      server: {
        middlewareMode: true,
        hmr: { port: 31001, clientPort: 31001 },
      },
    })
    expect(config.plugins).toEqual([
      expect.objectContaining({
        name: SSR_VITE_CLI_CONFIG_PLUGIN,
        [SSR_VITE_CLI_CONFIG_KEY]: '/app/config/platform.ts',
      }),
    ])
  })

  it('does not inject a CLI config when the flag was omitted', () => {
    const config = createSsrCliDevelopmentViteConfig({ root: '/app' })
    expect(config).not.toHaveProperty(SSR_VITE_CLI_CONFIG_KEY)
    expect(config.plugins).toBeUndefined()
  })

  it('reads the CLI config from the marker plugin when the inline key is absent', () => {
    expect(
      readSsrViteCliConfig({
        plugins: [createSsrViteCliConfigMarker('/app/config/platform.ts')],
      })
    ).toBe('/app/config/platform.ts')
  })
})
