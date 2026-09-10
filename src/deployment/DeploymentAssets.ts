import { copyFile, lstat, mkdir, readdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { parseSsrProductionAssetMetadata, SSR_PRODUCTION_ASSET_METADATA_PATH } from '../SsrAssetMetadata'
import {
  effectiveViteBasePath,
  parseSsrClientAssetManifest,
  resolveSsrImmutableAssetPaths,
  resolveSsrProductionAsset,
} from '../server/SsrAssetRuntime'
import type { DeploymentMetadata } from './DeploymentMetadata'

/** Do not follow public-directory symlinks into source, secrets or server output. */
export const deploymentFiles = async (directory: string, prefix = ''): Promise<string[]> => {
  const files: string[] = []
  for (const name of (await readdir(resolve(directory, prefix))).sort()) {
    const file = prefix ? `${prefix}/${name}` : name
    const information = await lstat(resolve(directory, file))
    if (information.isSymbolicLink()) {
      throw new Error('[vue-ssr-lite] Deployment client artifacts must not contain symbolic links.')
    }
    if (information.isDirectory()) files.push(...await deploymentFiles(directory, file))
    else if (information.isFile()) files.push(file)
  }
  return files
}

export interface DeploymentStaticAsset {
  file: string
  pathname: string
  cacheControl: string
  contentType: string
}

export const collectDeploymentStaticAssets = async (
  clientRoot: string,
  metadata: DeploymentMetadata
): Promise<DeploymentStaticAsset[]> => {
  if (metadata.dynamicAssets) return []
  const immutable = resolveSsrImmutableAssetPaths(
    parseSsrClientAssetManifest(await readFile(resolve(clientRoot, '.vite/manifest.json'), 'utf8')),
    parseSsrProductionAssetMetadata(await readFile(resolve(clientRoot, SSR_PRODUCTION_ASSET_METADATA_PATH), 'utf8'))
  )
  const matchers = metadata.serverRouteMatchers.map((source) => new RegExp(source))
  const base = effectiveViteBasePath(metadata.viteBase)
  const assets: DeploymentStaticAsset[] = []
  for (const file of await deploymentFiles(clientRoot)) {
    // HTML stays runtime-owned, including SPA templates and multi-app shells.
    // Reject control files and source artifacts even if copied from public/.
    if (file.split('/').some((part) => part.startsWith('.') || /^(?:server|node_modules)$/i.test(part)) ||
        /\.(?:html?|map|vue|[cm]?tsx?)$/i.test(file) ||
        /(?:^|\/)(?:package(?:-lock)?\.json|yarn\.lock|_redirects|_headers|vercel\.json|netlify\.toml)$/i.test(file) ||
        /[?#%\\\u0000-\u0020\u007f]/.test(file)) continue
    const pathname = `${base}${file}`
    if (/\/(?:robots\.txt|sitemap(?:-[1-9]\d*)?\.xml)$/.test(pathname) ||
        metadata.controlPaths.includes(pathname) || matchers.some((matcher) => matcher.test(pathname))) continue
    const asset = await resolveSsrProductionAsset({
      clientRoot, pathname, viteBase: metadata.viteBase,
      protectedTemplates: metadata.templates, immutableAssetPaths: immutable,
    })
    if (asset) assets.push({ file, pathname, cacheControl: asset.cacheControl, contentType: asset.contentType })
  }
  return assets
}

export const copyDeploymentFile = async (source: string, destination: string): Promise<void> => {
  await mkdir(dirname(destination), { recursive: true })
  await copyFile(source, destination)
}
