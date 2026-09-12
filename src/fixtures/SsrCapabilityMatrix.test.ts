import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildSsrCapabilityMatrix } from './SsrCapabilityMatrix'
import { CAPABILITY_PROFILES, PERFORMANCE_BUDGETS } from './SsrPerformanceContracts'

const frameworkRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')

describe('automatic browser capability attribution', () => {
  it('records complete source, route and activated-capability closures with isolated-peer controls', async () => {
    const reportRoot = process.env.SSR_AUDIT_DIR ?? join(frameworkRoot, 'node_modules/.cache/vue-ssr-lite/task-010')
    await mkdir(reportRoot, { recursive: true })
    const rows = await buildSsrCapabilityMatrix({
      frameworkRoot, consumerRoot: frameworkRoot,
      fixtureRoot: join(frameworkRoot, 'fixtures/capability-consumer'), mode: 'source',
      reportPath: join(reportRoot, 'source-client-capabilities.json'),
    })
    expect(rows).toHaveLength(Object.keys(CAPABILITY_PROFILES).length * 2)
    for (const externalPeers of [false, true]) {
      const watcher = rows.find(row => row.profile === 'reactivity' && row.externalPeers === externalPeers)!
      expect(watcher.delta.page.gzip).toBeLessThanOrEqual(PERFORMANCE_BUDGETS.watcherAddedGzip)
      expect(watcher.delta.page.bytes).toBeLessThanOrEqual(PERFORMANCE_BUDGETS.watcherAddedBytes)
    }
    console.info('[vue-ssr-lite] capability deltas:', JSON.stringify(rows.map(({ profile, externalPeers, baseline, delta }) =>
      ({ profile, externalPeers, baseline, delta }))))
  }, 240_000)
})
