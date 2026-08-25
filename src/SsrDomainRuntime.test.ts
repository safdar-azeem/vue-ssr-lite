import { describe, expect, it } from 'vitest'
import {
  createDomainUrl,
  resolveSsrDomainContext,
} from './SsrDomainRuntime'

const application = {
  id: 'workspace',
  domain: {
    development: 'localhost',
    production: 'example.com',
    mode: 'root-and-subdomains' as const,
    localAliases: true,
    customDomains: true,
  },
}

describe('SSR domain URL authority', () => {
  it('preserves protocol and development port in the serializable context', () => {
    const domain = resolveSsrDomainContext(
      'acme.localhost:4317',
      application,
      true,
      'http'
    )

    expect(domain).toMatchObject({
      authority: 'acme.localhost:4317',
      protocol: 'http',
      port: '4317',
      hostname: 'acme.localhost',
      baseDomain: 'localhost',
      subdomain: 'acme',
    })
  })

  it('honours explicit protocol and port overrides for any environment', () => {
    expect(
      createDomainUrl({
        baseDomain: 'example.com',
        subdomain: 'billing',
        path: '/invoices',
        protocol: 'http',
        port: 8080,
        development: false,
      })
    ).toBe('http://billing.example.com:8080/invoices')
  })
})
