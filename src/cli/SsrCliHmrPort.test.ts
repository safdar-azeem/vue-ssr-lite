import { describe, expect, it } from 'vitest'
import {
  findAvailableSsrCliHmrPort,
  parseSsrCliHmrPort,
  resolveSsrCliHmrPort,
} from './SsrCliHmrPort'

describe('SSR CLI HMR port isolation', () => {
  it('accepts explicit TCP ports for proxy and container environments', async () => {
    expect(parseSsrCliHmrPort(' 31001 ')).toBe(31_001)
    await expect(resolveSsrCliHmrPort('32001')).resolves.toBe(32_001)
  })

  it.each(['0', '65536', '1.5', '1e4', 'not-a-port'])(
    'rejects invalid configured port %s',
    (value) => {
      expect(() => parseSsrCliHmrPort(value)).toThrow(/HMR port/)
    }
  )

  it('asks the operating system for an isolated development port', async () => {
    const port = await findAvailableSsrCliHmrPort()
    expect(port).toBeGreaterThan(0)
    expect(port).toBeLessThanOrEqual(65_535)
  })
})
