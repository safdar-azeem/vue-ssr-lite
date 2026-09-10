import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import { isSsrTrustedLocalConnection } from './SsrLocalConnectionRuntime'

const connection = (remoteAddress: string | undefined, host = 'localhost:4173', extraHeaders = {}) => ({
  socket: { remoteAddress }, headers: { host, ...extraHeaders },
}) as IncomingMessage

describe('managed Node local connection provenance', () => {
  it.each(['127.0.0.1', '127.22.33.44', '::1', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '::ffff:7f00:1'])(
    'accepts the actual loopback peer %s with a normalized local Host', (peer) => {
      for (const host of ['localhost:4173', 'LOCALHOST.:4173', '127.0.0.1:4173', '[::1]:4173']) {
        expect(isSsrTrustedLocalConnection(connection(peer, host))).toBe(true)
      }
    }
  )

  it.each([undefined, '', 'localhost', '198.51.100.2', '192.168.1.2', '::ffff:198.51.100.2', '2001:db8::1', 'fe80::1%lo0', '0.0.0.0', '::'])(
    'does not trust Host localhost from peer %s', (peer) => {
      expect(isSsrTrustedLocalConnection(connection(peer))).toBe(false)
      expect(isSsrTrustedLocalConnection(connection(peer, 'localhost', {
        'x-forwarded-for': '127.0.0.1', 'x-forwarded-host': 'localhost', 'x-forwarded-proto': 'http',
      }))).toBe(false)
    }
  )

  it.each(['example.com', 'localhost.example.com', '0.0.0.0', '[::]', 'localhost,example.com', 'http://localhost', 'localhost/path', 'localhost@evil.test', 'localhost\\evil.test'])(
    'rejects non-loopback or malformed Host %s even with a local peer', (host) => {
      expect(isSsrTrustedLocalConnection(connection('127.0.0.1', host))).toBe(false)
    }
  )

  it.each(['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'via'])(
    'does not classify requests carrying %s as direct local smoke traffic', (header) => {
      expect(isSsrTrustedLocalConnection(connection('127.0.0.1', 'localhost', { [header]: 'localhost' }))).toBe(false)
    }
  )
})
