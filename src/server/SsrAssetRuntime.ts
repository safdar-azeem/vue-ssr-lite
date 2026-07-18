import { readFile, stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import type { SsrHttpResponse } from '../SsrRuntimeTypes'

const mimeTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml; charset=utf-8',
}

export const resolveSsrProductionAsset = async (
  clientRoot: string,
  pathname: string,
  protectedTemplates: readonly string[]
): Promise<SsrHttpResponse | null> => {
  try {
    const relativePath = decodeURIComponent(pathname).replace(/^\/+/, '')
    if (!relativePath || protectedTemplates.includes(relativePath)) return null
    const filePath = resolve(clientRoot, relativePath)
    const rootPrefix = clientRoot.endsWith(sep) ? clientRoot : `${clientRoot}${sep}`
    if (!filePath.startsWith(rootPrefix)) return null
    const information = await stat(filePath)
    if (!information.isFile()) return null
    return {
      statusCode: 200,
      body: await readFile(filePath),
      headers: {
        'content-type': mimeTypes[extname(filePath)] || 'application/octet-stream',
        'cache-control': pathname.startsWith('/assets/')
          ? 'public, max-age=31536000, immutable'
          : 'public, max-age=3600',
      },
    }
  } catch {
    return null
  }
}
