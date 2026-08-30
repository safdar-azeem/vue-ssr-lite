import { describe, expect, it } from 'vitest'
import { serializeRobotsTxt } from './robots'

describe('robots.txt', () => {
  it('emits the public default with a sitemap line', () => {
    expect(serializeRobotsTxt('https://ex.com/sitemap.xml')).toBe(
      [
        'User-agent: *',
        'Allow: /',
        '',
        'Sitemap: https://ex.com/sitemap.xml',
        '',
      ].join('\n')
    )
  })

  it('includes application disallow rules', () => {
    const body = serializeRobotsTxt('https://ex.com/sitemap.xml', {
      disallow: ['/user/'],
    })
    expect(body).toContain('Disallow: /user/')
    expect(body).toContain('Allow: /')
  })

  it('keeps an explicit empty sitemap list as an opt-out', () => {
    expect(serializeRobotsTxt('https://ex.com/sitemap.xml', { sitemaps: [] }))
      .not.toContain('Sitemap:')
  })
})
