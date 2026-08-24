import { access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { SitemapProvider } from '../extensions/seo/sitemap'

export const SITEMAP_CONFIG_CANDIDATES = [
  'sitemap.config.ts',
  'sitemap.config.mts',
  'sitemap.config.js',
  'sitemap.config.mjs',
] as const

export const defineSitemap = (provider: SitemapProvider): SitemapProvider =>
  provider

export const resolveSitemapConfigPath = async (
  root: string
): Promise<string | undefined> => {
  for (const candidate of SITEMAP_CONFIG_CANDIDATES) {
    const fullPath = resolve(root, candidate)
    try {
      await access(fullPath)
      return fullPath
    } catch {
      // Optional server-only module.
    }
  }
  return undefined
}

export const loadSitemapProvider = async (
  loaded: unknown
): Promise<SitemapProvider | undefined> => {
  const moduleValue = loaded as { default?: SitemapProvider }
  const exported = moduleValue?.default ?? (loaded as SitemapProvider)
  return typeof exported === 'function' ? exported : undefined
}

export const importSitemapProvider = async (
  filePath: string,
  importModule?: (specifier: string) => Promise<Record<string, unknown>>
): Promise<SitemapProvider | undefined> => {
  const loaded = importModule
    ? await importModule(filePath)
    : ((await import(pathToFileURL(filePath).href)) as Record<string, unknown>)
  return loadSitemapProvider(loaded)
}
