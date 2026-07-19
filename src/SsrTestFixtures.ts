import type { SsrDomainContext } from './SsrConfigTypes'
import type { SsrRenderRequest } from './SsrRuntimeTypes'

/** Shared domain snapshot for unit tests that construct render requests. */
export const createTestDomain = (
  host: string,
  overrides: Partial<SsrDomainContext> = {}
): SsrDomainContext => ({
  entry: 'test',
  hostname: host,
  baseDomain: host,
  subdomain: null,
  isCustomDomain: false,
  development: true,
  params: {},
  ...overrides,
})

export const createTestRenderRequest = <TPublicConfig = unknown>(
  host: string,
  overrides: Partial<SsrRenderRequest<TPublicConfig>> & {
    publicConfig?: TPublicConfig
  } = {}
): SsrRenderRequest<TPublicConfig> => {
  const { publicConfig, domain, ...rest } = overrides
  return {
    requestId: host,
    url: `https://${host}/`,
    host,
    protocol: 'https',
    method: 'GET',
    headers: {},
    publicConfig: (publicConfig ?? {}) as TPublicConfig,
    signal: new AbortController().signal,
    domain: domain ?? createTestDomain(host),
    ...rest,
  }
}
