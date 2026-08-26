# SEO 1.0 Architecture Audit

Task: task-020  
Revision: task-020/revision-001  
Review: task-020/review/001  
Audit date: 2026-08-26

## Executive verdict

The current SEO implementation is **not ready for a 1.0 public API freeze**.

This revision resolves review findings M-1 through M-9 and defines an
implementation-ready contract for task-021. The contract is ready for
implementation; the existing implementation remains not ready until the
contract is implemented and hardened.

No production code was modified during this audit.

## Tested baseline

- Commit: 151d31ce6adf474dfae1c39506cbb47f1a28d759
- Package: vue-ssr-lite@0.2.18
- Working tree: clean at audit start
- npm test: 41 test files passed, 288 tests passed

## Standards checked

The following primary sources were checked on 2026-08-26:

- [Google canonical documentation](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls)
- [Google robots meta and X-Robots-Tag documentation](https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag)
- [Google localized-versions documentation](https://developers.google.com/search/docs/specialty/international/localized-versions)
- [Google sitemap guidance](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap)
- [Google sitemap extension-combination guidance](https://developers.google.com/search/docs/crawling-indexing/sitemaps/combine-sitemap-extensions)
- [Sitemaps.org protocol](https://www.sitemaps.org/protocol.html)
- [Open Graph protocol](https://ogp.me/)
- [Schema.org developer documentation](https://schema.org/docs/developers.html)
- [RFC 9309 Robots Exclusion Protocol](https://www.rfc-editor.org/rfc/rfc9309.html)

## 1. Current architecture

The current SEO surface has three layers:

~~~text
defineApplication({ seo })
  ↓
route.meta.seo
  ↓
useSeo({ ... })
~~~

Server-only endpoint APIs are:

- defineSitemap();
- automatic /sitemap.xml;
- automatic /robots.txt.

Relevant implementation files:

- [src/extensions/seo/types.ts](../src/extensions/seo/types.ts)
- [src/extensions/seo/state.ts](../src/extensions/seo/state.ts)
- [src/extensions/seo/normalize.ts](../src/extensions/seo/normalize.ts)
- [src/extensions/seo/useSeo.ts](../src/extensions/seo/useSeo.ts)
- [src/extensions/seo/SeoEndpoints.ts](../src/extensions/seo/SeoEndpoints.ts)
- [src/SsrManagedHead.ts](../src/SsrManagedHead.ts)
- [src/SsrResponseStatus.ts](../src/SsrResponseStatus.ts)
- [src/server/SsrSiteOriginRuntime.ts](../src/server/SsrSiteOriginRuntime.ts)
- [src/server/SsrResponseCacheRuntime.ts](../src/server/SsrResponseCacheRuntime.ts)

Current behavior:

- Scalar fields are overwritten by later defined values.
- openGraph, twitter, and robots shallow-merge.
- meta, links, and structuredData replace the complete previous value.
- route.meta.seo is read from shallowly merged Vue Router metadata; parent and
  child SEO are not recursively composed.
- Active component layers are registered in setup order.
- KeepAlive deactivation disables a layer; unmount removes it.
- Route status is resolved from the deepest matched route.
- setResponseStatus() is a separate imperative runtime override.
- useSeo({ status }) does not currently exist.

## 2. What works well

Retain these foundations:

- isolated per-request SEO state;
- refs, computed values, and getters for individual reactive fields;
- KeepAlive activation/deactivation and unmount cleanup;
- managed-head SSR/client reconciliation;
- keyed replacement for title, description, robots, canonical, meta, and links;
- JSON-LD script-breakout protection;
- production origin validation and HTTPS enforcement;
- trusted-proxy protocol and host handling;
- request domain context with subdomain/custom-domain information;
- response-cache keys containing application, protocol, host, route, search,
  public configuration, and consumer variation;
- XML escaping for current sitemap values;
- automatic noindex behavior for error statuses;
- Core status behavior when SEO is disabled.

## 3. Current precedence

Current SEO precedence is:

~~~text
static application SEO
  ↓
route.meta.seo
  ↓
active useSeo() layers in registration order
  ↓
later custom managed-head extensions
~~~

Current status precedence is:

~~~text
deepest matched route meta.seo.status
  ↓
setResponseStatus()
~~~

The final contract changes composition to:

~~~text
framework safe defaults
  ↓
static application/site defaults
  ↓
request-resolved tenant/site defaults
  ↓
matched route SEO, parent → child
  ↓
active useSeo() layers, registration order
  ↓
intentional custom managed-head override
~~~

HTTP status is resolved alongside SEO but remains Core response state.

## 4. SEO-A1 through SEO-A21

| Finding | Status | Decision |
|---|---|---|
| SEO-A1: request-aware global/site SEO is missing | CONFIRMED | Add server-only siteSeo. |
| SEO-A2: useSeo() cannot own status | CONFIRMED | Add scoped reactive status. |
| SEO-A3: sitemap context is too small | CONFIRMED | Add safe domain/request context. |
| SEO-A4: sitemap only supports loc and lastmod | CONFIRMED | Add standard fields and extensions. |
| SEO-A5: no sitemap index or sharding | CONFIRMED | Add explicit replayable shard contract. |
| SEO-A6: no sitemap extensions | CONFIRMED | Add hreflang, image, video, and news models. |
| SEO-A7: robots has one wildcard group | CONFIRMED | Add multiple validated user-agent groups. |
| SEO-A8: dynamic robots provider is missing | CONFIRMED | Add server-only tenant-aware provider. |
| SEO-A9: metadata/link/JSON-LD replacement is too coarse | CONFIRMED | Add identity-based composition. |
| SEO-A10: global and page JSON-LD do not compose | CONFIRMED | Compose blocks; same @id overrides. |
| SEO-A11: robots directives are incomplete | CONFIRMED | Add modern directives and generic validated additions. |
| SEO-A12: OG/Twitter models are minimal | CONFIRMED | Add common stable fields and retain generic meta. |
| SEO-A13: hreflang abstraction is missing | CONFIRMED | Add alternates.languages. |
| SEO-A14: SEO does not expose lang/dir | CONFIRMED | Add a safe SEO subset of managed HTML attributes. |
| SEO-A15: global config accepts page canonical | CONFIRMED | Remove global canonical; retain global index/follow. |
| SEO-A16: PUBLIC_URL can outrank request origin | CONFIRMED | Correct Core origin precedence. |
| SEO-A17: endpoint cache policy is fixed | CONFIRMED | Add configurable validators and provider revisions. |
| SEO-A18: dynamic SEO needs automatic cache variation | CONFIRMED | Hash resolved site SEO in the framework-owned cache key. |
| SEO-A19: arbitrary absolute sitemap URLs are accepted | CONFIRMED | Enforce same-origin page URLs by default. |
| SEO-A20: robots values lack line validation | CONFIRMED | Reject CR, LF, NUL, and control characters. |
| SEO-A21: public redirect helper is absent | PARTIAL | Internal redirect state exists; add an ergonomic Core helper. |

## 5. M-1 resolution: global index/follow remain valid

Global indexability defaults are legitimate site configuration.

Allowed globally:

- title;
- titleTemplate;
- siteName;
- description;
- image;
- index;
- follow;
- supplementary robots directives;
- Open Graph defaults;
- Twitter/X defaults;
- structured data;
- global meta and links;
- siteUrl;
- trailingSlash;
- mode.

Invalid globally:

- canonical;
- status;
- sitemap.

Thus this remains valid:

~~~ts
seo: {
  index: false,
  follow: false,
}
~~~

This supports staging, private, and pre-launch sites.

## 6. M-2 resolution: one Core site-origin authority

SEO does not resolve origins independently.

Core resolves exactly one siteOrigin before siteSeo resolution:

~~~text
resolveSiteUrl(request), when configured
  ↓
static seo.siteUrl
  ↓
PUBLIC_URL
  ↓
validated request origin only in supported development/fallback mode
~~~

If resolveSiteUrl() is configured, its validated result is authoritative.
PUBLIC_URL must never override it. A missing or invalid result in a public
production multi-tenant application fails closed.

The same Core-owned value drives:

- canonical;
- og:url;
- hreflang URLs;
- sitemap loc;
- robots sitemap URLs;
- absolute structured-data IDs generated by the application.

## 7. M-3 resolution: index/follow have one owner

index and follow belong to the page/application SEO model only. They must not
be duplicated inside SeoRobotsInput.

~~~ts
interface SeoRobotsInput {
  nosnippet?: boolean
  noimageindex?: boolean
  maxSnippet?: number
  maxImagePreview?: 'none' | 'standard' | 'large'
  maxVideoPreview?: number
  notranslate?: boolean
  indexifembedded?: boolean
  unavailableAfter?: string | Date
  noarchive?: boolean
  additional?: Record<string, string | number | boolean>
}
~~~

The existing noarchive field remains supported for compatibility.

## 8. M-4 resolution: sitemap membership is not component SEO

SeoPageInput used by useSeo() must not contain sitemap.

Ownership is:

~~~text
route.meta.seo.sitemap
  → static route discovery

SitemapProvider records
  → dynamic CMS/database membership

useSeo()
  → current rendered document only
~~~

The sitemap endpoint does not render every component to discover runtime SEO.

## 9. M-5 resolution: error SEO policy

For 404 and 410:

- preserve the actual HTTP status;
- emit noindex by default;
- do not automatically impose nofollow;
- omit canonical by default;
- omit rich-result/page structured data by default;
- exclude from static sitemap discovery;
- do not cache as normal indexable content.

For 5xx:

- preserve the actual HTTP 5xx status;
- suppress normal indexable SEO output;
- do not manufacture nofollow;
- never cache as normal page content.

Explicit application crawler directives may still be honored where safe, but an
error status always prevents indexability.

## 10. M-6 resolution: dynamic sitemap records are provider-owned

Static routes are excluded when they are:

- redirect routes;
- declared 4xx routes;
- index:false;
- sitemap:false;
- dynamic parameter templates.

Dynamic providers supply published/indexable canonical URL records. The
framework validates:

- absolute canonicalization;
- same-origin page URL policy;
- duplicates;
- XML encoding;
- extension data;
- URL and byte limits.

The framework does not render every dynamic page to discover its SEO state.

## 11. M-7 resolution: explicit scalable sitemap contract

Sitemaps.org limits a sitemap file to 50,000 URLs and 50 MB uncompressed.

Small legacy providers remain supported:

~~~ts
defineSitemap(async () => [
  { loc: '/about', lastmod: '2026-08-24' },
])
~~~

Large sites must return an explicit replayable shard collection:

~~~ts
interface SitemapShardCollection {
  kind: 'sharded'
  revision: string | number
  shardCount: number
  getShard: (
    context: SitemapContext,
    shardIndex: number,
  ) => SitemapSource | Promise<SitemapSource>
}

type SitemapSource =
  | Iterable<SitemapEntry>
  | AsyncIterable<SitemapEntry>

type SitemapProviderResult =
  | SitemapSource
  | SitemapShardCollection
~~~

Required behavior:

- shardCount is known before index serialization;
- /sitemap.xml is the index for kind: sharded;
- shard paths are /sitemap-1.xml, /sitemap-2.xml, etc.;
- a provider must produce deterministic content for a revision;
- every shard is independently bounded to 50,000 URLs and 50 MB;
- the framework holds at most one shard's entries/XML in memory;
- the framework does not replay the entire site to discover shard count;
- revision is mandatory for sharded output;
- index and shard responses include revision-based cache identity/ETag;
- a provider changing data without changing revision violates the provider
  contract;
- cancellation is passed through SitemapContext.signal;
- concurrent tenants have independent context and cache identity;
- invalid or oversized shards fail rather than emit partial XML.

The implementation may use an internal bounded response cache, but must not
materialize the entire site in one in-memory XML document.

## 12. M-8 resolution: server-only siteSeo

Do not overload application seo with a second meaning. Static application SEO
remains defineApplication({ seo }). Dynamic server resolution is named siteSeo.

Single-application shorthand:

~~~ts
export default defineSsrConfig({
  siteSeo: {
    resolve: async ({
      applicationId,
      siteOrigin,
      domain,
      pathname,
      publicConfig,
      signal,
    }) => ({
      defaults: {
        siteName: 'Acme',
        titleTemplate: '%s | Acme',
        description: 'Acme description',
        image: 'https://cdn.example/acme.png',
        index: true,
        follow: true,
        structuredData: [],
      },
      revision: 'site-seo-revision-42',
      cacheTags: ['site:acme'],
    }),
  },
})
~~~

Multi-application configuration:

~~~ts
export default defineSsrConfig({
  applications: {
    website: {
      siteSeo: {
        resolve: async (context) => resolveTenantSeo(context),
      },
    },
  },
})
~~~

siteSeo.resolve() receives the already-resolved Core siteOrigin. It does not
return or replace it.

The resolver is server-only, request-scoped, abort-aware, and may return only
public serializable SEO data.

## 13. M-9 resolution: automatic SEO cache hashing

Consumers must not add SEO to responseCache.vary for correctness.

Before cache lookup, Core resolves:

~~~text
domain
  ↓
siteOrigin
  ↓
publicConfig
  ↓
siteSeo defaults
  ↓
framework serialization + deterministic hash
  ↓
response-cache identity
~~~

The framework-owned cache identity includes:

- application ID;
- protocol;
- host;
- pathname;
- search;
- public-config hash;
- resolved siteOrigin;
- resolved site SEO snapshot hash;
- optional consumer variation.

revision and cacheTags remain optional provider hints for invalidation,
publish events, sitemap ETags, and observability. SEO correctness does not
depend on a manually configured variation.

## 14. Final public SEO type model

~~~ts
export interface SeoPageInput {
  title?: string | null
  description?: string | null
  image?: string | null
  canonical?: string | false | null
  index?: boolean
  follow?: boolean
  status?: number

  openGraph?: SeoOpenGraphInput | null
  twitter?: SeoTwitterInput | null
  robots?: SeoRobotsInput | null

  alternates?: {
    languages?: Record<string, string>
  }

  structuredData?: JsonObject | readonly JsonObject[]
  structuredDataMode?: 'merge' | 'replace'

  meta?: readonly SeoMetaEntry[]
  links?: readonly SeoLinkEntry[]

  htmlAttributes?: {
    lang?: string | null
    dir?: 'ltr' | 'rtl' | 'auto' | null
  }
}

export interface SeoApplicationConfig {
  enabled?: boolean
  siteName?: string
  titleTemplate?: string
  description?: string
  image?: string
  index?: boolean
  follow?: boolean
  openGraph?: SeoOpenGraphInput
  twitter?: SeoTwitterInput
  robots?: SeoRobotsInput
  structuredData?: JsonObject | readonly JsonObject[]
  meta?: readonly SeoMetaEntry[]
  links?: readonly SeoLinkEntry[]
  htmlAttributes?: SeoPageInput['htmlAttributes']
  siteUrl?: string
  trailingSlash?: boolean
  mode?: 'public' | 'private'
  allowHttpOrigin?: boolean
  robotsTxt?: RobotsConfig

  canonical?: never
  status?: never
  sitemap?: never
}
~~~

SeoRouteInput extends SeoPageInput with route-only sitemap?: boolean.

UseSeoInput supports field-level and whole-object reactivity:

~~~ts
export type SeoResolvable<T> =
  | T
  | Ref<T>
  | ComputedRef<T>
  | (() => T)

export type UseSeoInput = {
  [K in keyof SeoPageInput]?: SeoResolvable<SeoPageInput[K]>
}

export type UseSeoSource =
  | UseSeoInput
  | SeoResolvable<SeoPageInput | null | undefined>

export function useSeo(input: UseSeoSource): void
~~~

## 15. SEO layer composition

Field rules:

| Field | Composition rule |
|---|---|
| title | Later defined value wins; title template applies once. |
| description | Later defined value wins; null clears. |
| image | Later defined value wins; site image is fallback. |
| index/follow | Later defined value wins; global values are valid defaults. |
| canonical | Page/route only; false or null removes inherited canonical. |
| status | Deepest route, active component layers, then Core imperative status. |
| OG/Twitter scalars | Merge by stable meta identity; later same identity wins. |
| OG arrays | Compose in stable order; same explicit identity replaces. |
| Robots supplementary directives | Merge by directive identity; page index/follow remain separate. |
| alternates.languages | Merge by language key; later same language wins. |
| structuredData | Append by default; same @id replaces; explicit replace is available. |
| meta | Compose by semantic/key identity; singleton values replace. |
| links | Compose by semantic/key identity; canonical and hreflang are keyed singletons. |
| htmlAttributes | Merge by name; null removes. |
| sitemap | Route metadata and provider records only; never component SEO. |

Reserved identities prevent duplicate description, robots, canonical, and other
singleton tags even when user-supplied keys differ.

## 16. Status lifecycle and redirects

Approved status precedence:

~~~text
normal route/framework default
  ↓
deepest matched route meta.seo.status
  ↓
active useSeo({ status }) layers
  ↓
explicit setResponseStatus()
  ↓
actual redirect response
~~~

useSeo({ status }) is a scoped layer. It must not call setResponseStatus() once
during setup.

It must handle reactive changes, KeepAlive, unmount, navigation, Back,
Forward, SSR, hydration, and multiple active layers.

setResponseStatus() remains available for SEO-disabled applications, non-SEO
HTTP logic, imperative framework control, and advanced integrations.

Add a Core helper, separate from SEO:

~~~ts
setResponseRedirect('/new-location', { status: 308 })
~~~

Redirect responses suppress normal indexable head output and are excluded from
sitemaps. 301/308 are permanent; 302/307 are temporary. Redirects require a
location and use the existing same-origin/external redirect policy.

## 17. Dynamic page example

~~~ts
const page = shallowRef<Page | null>(null)
const loaded = ref(false)

const pageSeo = computed(() => {
  if (!loaded.value) return {}

  if (!page.value) {
    return {
      title: 'Page not found',
      status: 404,
    }
  }

  return page.value.seo
})

useSeo(pageSeo)
~~~

The application/data layer fetches the page. SEO only consumes resolved
reactive data.

## 18. Website-builder flow

ssr.config.ts:

~~~ts
import { defineSsrConfig } from 'vue-ssr-lite/server'

export default defineSsrConfig({
  siteSeo: {
    resolve: async ({ domain, siteOrigin, signal }) => {
      const site = await database.sites.byDomain(domain.hostname, { signal })

      if (!site) return { defaults: { index: false, follow: false } }

      return {
        defaults: {
          siteName: site.name,
          titleTemplate: site.titleTemplate,
          description: site.description,
          image: site.socialImage,
          index: site.published,
          follow: site.published,
          structuredData: site.structuredData,
        },
        revision: site.seoRevision,
        cacheTags: ['site:' + site.id],
      }
    },
  },
})
~~~

The application configures Core resolveSiteUrl(request) for custom domains. It
returns the validated current origin for the selected tenant.

Dynamic page component:

~~~ts
const ProductPage = defineComponent({
  setup() {
    const route = useRoute()
    const product = shallowRef<Product | null>(null)
    const loaded = ref(false)

    onServerPrefetch(async () => {
      product.value = await api.products.bySlug(route.params.slug as string)
      loaded.value = true
    })

    const seo = computed(() => {
      if (!loaded.value) return {}
      if (!product.value) return { title: 'Product not found', status: 404 }
      return product.value.seo
    })

    useSeo(seo)

    return () => h(ProductView, { product: product.value })
  },
})
~~~

## 19. Sitemap contract

~~~ts
export interface SitemapEntry {
  loc: string
  lastmod?: string | Date
  changefreq?: 'always' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'never'
  priority?: number
  alternates?: Record<string, string>
  images?: SitemapImageEntry[]
  videos?: SitemapVideoEntry[]
  news?: SitemapNewsEntry
}

export interface SitemapContext<TPublicConfig = unknown> {
  applicationId: string
  siteOrigin: string
  domain: Readonly<SsrDomainContext>
  hostname: string
  subdomain: string | null
  isCustomDomain: boolean
  params: Readonly<Record<string, string>>
  pathname: string
  search: string
  publicConfig: TPublicConfig
  signal: AbortSignal
}
~~~

Small dynamic provider:

~~~ts
export default defineSitemap(async ({ siteOrigin, domain, signal }) => {
  const pages = await database.pages.published(domain.hostname, { signal })

  return pages.map((page) => ({
    loc: siteOrigin + '/blog/' + encodeURIComponent(page.slug),
    lastmod: page.updatedAt,
    alternates: page.localizedUrls,
  }))
})
~~~

Large sites use the explicit replayable shard collection in section 11.
Dynamic records are provider-declared canonical/indexable records; the
framework does not render each URL.

## 20. Robots contract

~~~ts
export interface RobotsGroup {
  userAgents: string | readonly string[]
  allow?: readonly string[]
  disallow?: readonly string[]
  directives?: Record<string, string | number | boolean>
}

export interface RobotsConfig {
  groups: readonly RobotsGroup[]
  sitemaps?: readonly string[]
}
~~~

Dynamic robots resolution is server-only and receives the same tenant/domain,
origin, public configuration, and abort signal as sitemap resolution.

Preview/private mode requires authentication/access control in addition to a
conservative noindex/disallow policy. Robots.txt is not privacy or authorization.

## 21. Structured data and future extensions

Structured data remains arbitrary JSON-LD. Do not create a closed schema-type
enum. Blocks with @id are identity-addressable; blocks without @id compose as
independent blocks. structuredDataMode: 'replace' explicitly clears lower
blocks.

Future standards are handled through:

- typed common stable fields;
- keyed meta entries;
- keyed link entries;
- validated additional robots directives;
- arbitrary JSON-LD;
- generic response headers.

Raw unsanitized HTML is not an SEO escape hatch.

## 22. Security contract

Task-021 must validate:

- HTML and attribute escaping;
- JSON-LD script breakout and control characters;
- HTTP(S)-only canonical/SEO URLs;
- no URL credentials;
- same-origin canonical and page sitemap URLs by default;
- approved cross-origin media only;
- CRLF/NUL/control-character rejection in robots and headers;
- XML entity escaping;
- trusted host/proxy handling;
- tenant lookup isolation;
- maximum value sizes;
- duplicate singleton head identities.

X-Robots-Tag should use the generic response-header API for non-HTML resources,
rather than adding a redundant SEO-specific helper. Google documents it for PDFs,
images, videos, and other non-HTML resources.

## 23. Response-cache contract

Before cache lookup, the framework resolves and validates request siteOrigin and
siteSeo, then hashes the public serializable snapshot.

The framework-owned cache identity includes:

- application ID;
- protocol;
- host;
- pathname;
- search;
- public-config hash;
- resolved siteOrigin;
- resolved site SEO snapshot hash;
- optional consumer variation.

Provider revision and cacheTags are optional invalidation hints. SEO correctness
does not depend on manually configured responseCache.vary.

Failed, aborted, redirected, private, error, and tenant-missing responses are
not normal page-cache entries.

## 24. Failure behavior

| Failure | Behavior |
|---|---|
| Site SEO timeout | Abort-aware 503/504 policy; never another tenant's defaults. |
| Tenant not found | 404/421 policy; no tenant canonical or sitemap membership. |
| Malformed SEO field | Reject or omit the field according to validation severity; log details. |
| Sitemap failure | 503 or configured stale-cache policy; never partial XML. |
| Robots failure | Safe configured failure policy; no false public policy. |
| Aborted request | Stop work and prevent cache writes. |
| Invalid origin | Fail closed when a request resolver is active. |

## 25. Backward compatibility

Preserve:

~~~ts
defineApplication({ seo: { ... } })
route.meta.seo
useSeo({ ... })
defineSitemap(...)
setResponseStatus(...)
~~~

Required pre-1.0 correction:

- remove global canonical, status, and sitemap;
- keep global index and follow;
- keep existing common global SEO fields;
- keep array sitemap providers for small sites;
- keep robots allow/disallow shorthand;
- keep noarchive compatibility.

## 26. Exact files task-021 should modify

Core types/runtime:

- src/extensions/seo/types.ts
- src/extensions/seo/state.ts
- src/extensions/seo/normalize.ts
- src/extensions/seo/useSeo.ts
- src/extensions/seo/client.ts
- src/extensions/seo/server.ts
- src/extensions/seo/sitemap.ts
- src/extensions/seo/robots.ts
- src/extensions/seo/SeoEndpoints.ts
- src/extensions/seo/index.ts
- src/SsrManagedHead.ts
- src/SsrResponseStatus.ts
- src/SsrRuntimeTypes.ts
- src/SsrConfigTypes.ts
- src/SsrConfigCompileRuntime.ts
- src/SsrApplicationRuntime.ts
- src/SsrRenderRuntime.ts
- src/SsrRequestContext.ts
- src/server/SsrSiteOriginRuntime.ts
- src/server/SsrSitemapConfig.ts
- src/server/SsrResponseCacheRuntime.ts
- src/server/SsrServerRuntime.ts
- src/server/SsrHtmlRuntime.ts
- src/index.ts
- src/server.ts

Tests and documentation:

- existing SEO/head/status tests;
- new dynamic resolver tests;
- sitemap shard/extension tests;
- robots provider/security tests;
- multi-tenant cache tests;
- src/fixtures/SsrAdvancedConsumer.test.ts;
- scripts/SsrPackageSmoke.mjs;
- README.md.

## 27. Implementation sequence

1. Freeze types and migration validation.
2. Add Core-first origin resolution and request siteOrigin propagation.
3. Add server-only siteSeo resolver.
4. Add hydration-safe resolved site SEO snapshot.
5. Implement parent-to-child route composition.
6. Implement deterministic field-specific SEO composition.
7. Add whole-object reactive useSeo().
8. Add scoped declarative status lifecycle.
9. Add Core redirect/header helpers.
10. Implement error and redirect SEO rules.
11. Implement keyed meta/link composition.
12. Implement JSON-LD composition and explicit replacement.
13. Add hreflang and safe lang/dir attributes.
14. Add dynamic robots provider and validation.
15. Add sitemap extensions and same-origin validation.
16. Add explicit large-site shard/index contract.
17. Add automatic site SEO snapshot hashing to SSR cache identity.
18. Add endpoint cache validators and revision/tag support.
19. Add security, cancellation, and failure tests.
20. Update README and package smoke coverage.

## 28. Required validation matrix

### Global and dynamic resolution

- static global defaults;
- global index/follow defaults;
- request-resolved tenant defaults;
- same-path concurrent tenants;
- resolver timeout, error, and abort;
- tenant-not-found isolation;
- hydration and browser navigation consistency;
- no server secrets in the browser.

### Layering and reactivity

- parent route plus child route;
- route override;
- scalar and nested object merge;
- single, nested, and multiple useSeo() layers;
- refs, computed values, getters, and whole-object getters;
- async SSR data;
- browser API changes;
- KeepAlive activation/deactivation;
- unmount;
- navigation, Back, and Forward.

### Status and errors

- route 404/410;
- component 404/410;
- reactive component status;
- imperative Core override;
- explicit status 200 override;
- navigation reset;
- SEO disabled;
- 3xx rejection without redirect;
- 301/302/307/308 redirect behavior;
- 4xx/5xx noindex without manufactured nofollow;
- error canonical/structured-data/sitemap suppression.

### Origin and cache isolation

- static seo.siteUrl;
- request resolveSiteUrl();
- PUBLIC_URL fallback;
- development request-origin fallback;
- platform subdomains;
- custom domains;
- trusted proxy;
- spoofed forwarded host;
- invalid/missing resolver result;
- concurrent tenants;
- changed site SEO under response caching;
- automatic site SEO snapshot hashing.

### Head

- title/template;
- description;
- canonical;
- robots;
- Open Graph and image arrays;
- Twitter/X fields;
- hreflang and x-default;
- lang and dir;
- global Organization/WebSite plus page Product/Article;
- JSON-LD @id replacement;
- custom meta/link composition;
- duplicate singleton rejection;
- stale tag removal.

### Sitemap

- static routes;
- dynamic provider records;
- noindex/404/410/redirect/sitemap-false exclusion;
- canonical deduplication;
- custom-domain origin;
- hreflang/image/video/news extensions;
- XML escaping;
- cross-origin attack;
- 50,000 URL and 50 MB boundaries;
- shard index and deterministic shard names;
- revision mismatch;
- provider cancellation;
- concurrent tenants;
- ETag and conditional GET;
- provider failure.

### Robots and security

- default wildcard group;
- multiple user-agent groups;
- dynamic tenant policy;
- preview/private policy;
- custom-domain sitemap URL;
- newline/control-character injection;
- invalid URL scheme;
- HTML/attribute breakout;
- JSON-LD breakout;
- CRLF response-header injection;
- untrusted host;
- cross-tenant leakage.

## 29. Documentation contract

The README must document:

- application versus route versus component SEO;
- exact field and status precedence;
- whole-object reactive SEO;
- server-only siteSeo resolution;
- Core-owned canonical origin;
- custom domains and subdomains;
- hreflang and x-default;
- structured-data composition;
- dynamic sitemap records and sharded sitemaps;
- dynamic robots;
- preview/private limitations;
- robots.txt not being access control;
- automatic response-cache SEO variation;
- failure and cancellation semantics.

## 30. Explicitly deferred

- SEO copy generation;
- ranking guarantees;
- Search Console integration;
- authentication/password protection;
- database/tenant storage abstractions;
- automatic validation of every schema.org type;
- search-engine-specific helper packages;
- automatic domain migration mapping;
- CDN/object-storage implementation;
- raw HTML injection.

## Final recommendation

The current implementation remains **SEO API NOT READY FOR 1.0** until task-021
implements this contract.

The revised architecture is now precise enough to authorize task-021:

**SEO 1.0 IMPLEMENTATION CONTRACT READY**

