import type { IncomingMessage } from 'node:http'
import { isIP } from 'node:net'
import { isSsrLoopbackHostname } from '../SsrCanonicalOrigin'
import { normalizeSsrHostname } from '../SsrHostnameRuntime'

/** Only the managed Node transport can grant the local production exception. */
export const isSsrTrustedLocalConnection = (request: IncomingMessage): boolean => {
  const peer = request.socket.remoteAddress
  const family = peer ? isIP(peer) : 0
  if (!peer || !family) return false
  // Scoped IPv6 addresses are not loopback and cannot be parsed as URL hosts.
  if (peer.includes('%')) return false
  const peerHostname = family === 6 ? new URL(`http://[${peer}]`).hostname : peer
  if (!isSsrLoopbackHostname(peerHostname)) return false

  // A proxy can itself connect from loopback. Forwarding metadata disqualifies
  // the automatic exception, regardless of the consumer's trustProxy setting.
  if (Object.keys(request.headers).some((name) =>
    /^(?:forwarded|via|x-real-ip|x-forwarded-.*)$/i.test(name)
  )) return false
  const host = request.headers.host
  if (typeof host !== 'string' || /[\u0000-\u0020\u007f,/@?#\\]/.test(host)) return false
  return isSsrLoopbackHostname(normalizeSsrHostname(host))
}
