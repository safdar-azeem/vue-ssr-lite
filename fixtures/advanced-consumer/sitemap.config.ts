import { defineSitemap } from '../../src/server'

export default defineSitemap(async ({ siteUrl, applicationId }) => [
  {
    loc: `${siteUrl}/generated/${applicationId}`,
    lastmod: '2026-08-24',
  },
])
