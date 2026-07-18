import { createServer } from 'node:net'

const MIN_TCP_PORT = 1
const MAX_TCP_PORT = 65_535

export const parseSsrCliHmrPort = (value?: string): number | undefined => {
  const normalized = value?.trim()
  if (!normalized) return undefined

  if (!/^\d+$/.test(normalized)) {
    throw new Error(`HMR port must be an integer between ${MIN_TCP_PORT} and ${MAX_TCP_PORT}.`)
  }
  const port = Number(normalized)
  if (!Number.isInteger(port) || port < MIN_TCP_PORT || port > MAX_TCP_PORT) {
    throw new Error(`HMR port must be an integer between ${MIN_TCP_PORT} and ${MAX_TCP_PORT}.`)
  }
  return port
}

export const findAvailableSsrCliHmrPort = () => new Promise<number>((resolve, reject) => {
  const probe = createServer()
  probe.once('error', reject)
  probe.listen({ port: 0, exclusive: true }, () => {
    const address = probe.address()
    if (!address || typeof address === 'string') {
      probe.close()
      reject(new Error('Unable to allocate an HMR WebSocket port.'))
      return
    }
    probe.close((error) => {
      if (error) reject(error)
      else resolve(address.port)
    })
  })
})

export const resolveSsrCliHmrPort = async (value?: string): Promise<number> =>
  parseSsrCliHmrPort(value) ?? findAvailableSsrCliHmrPort()
