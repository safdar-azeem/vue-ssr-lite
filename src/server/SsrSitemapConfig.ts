import type { SitemapProvider } from '../extensions/seo/sitemap'

export const defineSitemap = (provider: SitemapProvider): SitemapProvider =>
  provider

export const loadSitemapProvider = async (
  loaded: unknown
): Promise<SitemapProvider | undefined> => {
  if (typeof loaded === 'function') return loaded as SitemapProvider
  const moduleValue = loaded as { default?: SitemapProvider }
  const exported = moduleValue?.default ?? (loaded as SitemapProvider)
  return typeof exported === 'function' ? exported : undefined
}
