# SEO 1.0 Architecture Audit

Task: task-020  
Revision: task-020/revision-007  
Review: task-020/review/007  
Audit date: 2026-08-26  
Audited baseline: 151d31ce6adf474dfae1c39506cbb47f1a28d759

## Executive verdict

The current SEO implementation is **not ready for a 1.0 public API freeze**.

Revision-007 closes the remaining `og:url` fallback contradiction from
review/007. It does not reopen accepted architecture.

Closed in this revision:

- M-30 `og:url` derivation distinguishes omitted canonical from explicit
  `false` / `null`

The public 1.0 contract is now frozen. The existing implementation remains
not ready until task-021 implements and hardens this contract.

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
- [Google image sitemaps](https://developers.google.com/search/docs/crawling-indexing/sitemaps/image-sitemaps)
- [Google news sitemaps](https://developers.google.com/search/docs/crawling-indexing/sitemaps/news-sitemap)
- [Google video sitemaps](https://developers.google.com/search/docs/crawling-indexing/sitemaps/video-sitemaps)
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
| SEO-A8: dynamic robots provider is missing | CONFIRMED | Add server-only siteRobots.resolve(). |
| SEO-A9: metadata/link/JSON-LD replacement is too coarse | CONFIRMED | Add identity-based composition. |
| SEO-A10: global and page JSON-LD do not compose | CONFIRMED | Compose blocks; same @id overrides. |
| SEO-A11: robots directives are incomplete | CONFIRMED | Add modern directives and generic validated additions. |
| SEO-A12: OG/Twitter models are minimal | CONFIRMED | Add common stable fields and retain generic meta. |
| SEO-A13: hreflang abstraction is missing | CONFIRMED | Add page/route `alternates.languages`; not site-global. |
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
- Open Graph defaults except `url`;
- Twitter/X defaults;
- structured data;
- global meta and links;
- html lang/dir;
- siteUrl;
- trailingSlash;
- mode.

Invalid globally:

- canonical;
- status;
- sitemap;
- first-class `alternates` / hreflang;
- `openGraph.url` / `og:url`.

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

`additional` is only for unknown/future directives. First-class names are
reserved and must be rejected there. The reserved-name and rendering rules
are frozen in section 20.

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

Large sites must return an explicit replayable shard collection. The
canonical public types, including endpoint cache metadata, are in section 19.

~~~ts
interface SitemapShardCollection extends SeoEndpointResultMeta {
  kind: 'sharded'
  revision: string | number
  shardCount: number
  getShard: (
    context: SitemapContext,
    shardNumber: number,
  ) => SitemapSource | Promise<SitemapSource>
}

type SitemapSource =
  | Iterable<SitemapEntry>
  | AsyncIterable<SitemapEntry>

type SitemapNotFoundResult = {
  status: 'not-found'
  responseStatus?: 404 | 421
}

type SitemapProviderResult =
  | SitemapSource
  | SitemapShardCollection
  | SitemapEntriesResult
  | SitemapNotFoundResult
~~~

Required behavior:

- shardCount is known before index serialization;
- /sitemap.xml is the index for kind: sharded;
- shard paths are /sitemap-1.xml, /sitemap-2.xml, etc.;
- `getShard(context, shardNumber)` uses `1 <= shardNumber <= shardCount`;
- `/sitemap-1.xml` calls `getShard(context, 1)` with no index translation;
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

## 12. M-8 / M-10 / M-11 / M-17: server-only siteSeo

Do not overload application seo with a second meaning. Static application SEO
remains defineApplication({ seo }). Dynamic server resolution is named siteSeo.

siteSeo lives on application config: flat on defineSsrConfig() for a single
application, and on applications.<id> for multi-application projects.

Single-application shorthand:

~~~ts
export default defineSsrConfig({
  siteSeo: {
    resolve: async (context: SiteSeoContext): Promise<SiteSeoResolution> => {
      const site = await database.sites.byDomain(context.domain.hostname, {
        signal: context.signal,
      })

      if (!site) {
        return {
          status: 'not-found',
          responseStatus: 404,
        }
      }

      return {
        status: 'resolved',
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
      }
    },
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
public serializable SEO data. The exact public types, tenant-not-found
semantics, and hydration rule are frozen in sections 14, 14.1, and 14.2.

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

These are the frozen 1.0 public TypeScript contracts. Task-021 implements
these shapes; it must not invent additional public types for the surfaces
already named here.

Shared server context family:

~~~ts
export interface SeoServerContext {
  applicationId: string
  siteOrigin: string
  domain: Readonly<SsrDomainContext>
  signal: AbortSignal
}

export type SiteSeoContext = SeoServerContext

export interface SeoEndpointContext extends SeoServerContext {
  pathname: string
  search: string
}

export type SiteRobotsContext = SeoEndpointContext

export interface SeoProviderMeta {
  revision?: string | number
  cacheTags?: readonly string[]
}

export interface SeoEndpointResultMeta extends SeoProviderMeta {
  lastModified?: string | Date
  cacheControl?: string
}
~~~

`SiteSeoContext` is site-stable. It does not include `pathname`, `search`,
or `publicConfig`.

`SeoEndpointContext` is the sitemap/robots request context. It includes the
endpoint URL (`pathname`, `search`) and does not include `publicConfig`.
Providers look up tenant data from `domain` and `siteOrigin`.

HTML page cache identity still includes the public-config hash. Sitemap and
robots endpoint cache identity must not depend on request-variable
`publicConfig`, because those providers cannot observe it.

Tenant identity comes from Core `siteOrigin` and `domain`. Route and page
SEO, including locale from the path and first-class hreflang, belong in
`route.meta.seo` and `useSeo()`. A different origin or tenant is a
full-document navigation.

Site-wide document language uses `htmlAttributes.lang` / `dir`. First-class
`alternates.languages` is page-specific and is forbidden on application and
site defaults. Advanced consumers may still emit `rel="alternate"` through
generic `links`.

`mode` and `robotsTxt` are not request-dynamic through siteSeo.

- `mode` remains static application configuration on `SeoApplicationConfig`.
- `robotsTxt` remains the static fallback. Request-dynamic robots.txt uses
  the separate server-only `siteRobots` contract in section 20.
- `siteUrl`, `canonical`, `status`, `sitemap`, `alternates`,
  `openGraph.url`, `allowHttpOrigin`, `enabled`, and `trailingSlash` must
  never appear on request-resolved site defaults.

### 14.1 SiteSeo public types and tenant-not-found

~~~ts
export interface SeoSiteDefaults {
  title?: string | null
  siteName?: string | null
  titleTemplate?: string | null
  description?: string | null
  image?: string | null
  index?: boolean
  follow?: boolean
  openGraph?: SeoOpenGraphDefaults | null
  twitter?: SeoTwitterInput | null
  robots?: SeoRobotsInput | null
  structuredData?: JsonObject | readonly JsonObject[] | null
  structuredDataMode?: 'merge' | 'replace'
  meta?: readonly SeoMetaEntry[] | null
  links?: readonly SeoLinkEntry[] | null
  htmlAttributes?: SeoPageInput['htmlAttributes']

  alternates?: never
}

export type SiteSeoResolution =
  | ({
      status: 'resolved'
      defaults: SeoSiteDefaults
    } & SeoProviderMeta)
  | {
      status: 'not-found'
      responseStatus?: 404 | 421
    }

export type SiteSeoResolver = (
  context: SiteSeoContext,
) => SiteSeoResolution | Promise<SiteSeoResolution>

export interface SiteSeoConfig {
  resolve: SiteSeoResolver
}
~~~

`siteSeo?: SiteSeoConfig` and `siteRobots?: SiteRobotsConfig` attach to
application config: flat on `defineSsrConfig()` for one app, and on
`applications.<id>` for multi-app. They are not root-only multi-app fields.

Tenant missing is not a non-indexable snapshot. Returning
`{ defaults: { index: false, follow: false } }` for an unknown host is
invalid: that is a resolved snapshot and would allow HTTP 200 with
platform/default content.

Required rule:

~~~text
tenant missing
  → status: 'not-found'
  → fail closed
  → no normal application SEO snapshot
  → no static application SEO used as tenant fallback
  → HTTP 404 or 421 (responseStatus default: 404)
  → no canonical
  → no sitemap/robots tenant output
  → no normal response-cache entry
~~~

Distinctions task-021 must not collapse:

- Missing tenant: `status: 'not-found'`. The host is not a site.
- Existing unpublished tenant: `status: 'resolved'` with `index: false`
  and/or `follow: false`. The host is a real site that should not be indexed.
- Resolver throw, timeout, or abort: request failure (503/504 or abort
  policy). This is not tenant-not-found and must never become another
  tenant's snapshot.

`siteSeo.resolve()` must not throw to mean tenant-not-found. Throw/reject is
a resolver failure.

`responseStatus: 421` is for a host that reached this application but is not
bound to a tenant here (misdirected custom domain). Unknown hosts default to
404.

On `not-found`, Core sets that HTTP status before normal indexable render.
An error view may still render under the M-5 error SEO policy. Sitemap and
robots endpoints short-circuit with the same status and do not call the
sitemap or siteRobots providers (section 19.2).

### 14.2 Request site SEO hydration

`siteSeo.resolve()` runs only on the server.

When resolution is `resolved`, the validated public `SeoSiteDefaults`
snapshot is serialized into the existing framework hydration state. Server
hints (`revision`, `cacheTags`) are not hydrated.

On hydration, the browser restores exactly that snapshot.

On client-side route navigation, the same site-level snapshot remains
active because host/site identity has not changed. `siteSeo` cannot depend
on pathname, search, or `publicConfig`, so SPA navigation and a full reload
of the same origin/tenant must observe the same site defaults.

A full-document navigation is required when moving to another origin/tenant.

The browser must not invoke the server-only resolver, must not ship the
database/tenant lookup, and must not reconstruct site defaults from
request-aware `publicConfig`. Route-varying SEO from `publicConfig` belongs
in `route.meta.seo` and `useSeo()`.

On `not-found`, there is no site snapshot to hydrate. Error SEO follows M-5.

### 14.3 Page, application, and component types

~~~ts
export interface SeoImageInput {
  key?: string
  url: string
  secureUrl?: string
  type?: string
  width?: number
  height?: number
  alt?: string
}

export interface SeoMediaInput {
  key?: string
  url: string
  secureUrl?: string
  type?: string
  width?: number
  height?: number
}

export type SeoImageValue =
  | string
  | SeoImageInput
  | readonly (string | SeoImageInput)[]

export type SeoMediaValue =
  | string
  | SeoMediaInput
  | readonly (string | SeoMediaInput)[]

export interface SeoOpenGraphInput {
  type?: string
  title?: string
  description?: string
  url?: string
  siteName?: string
  locale?: string
  localeAlternate?: readonly string[]
  determiner?: 'a' | 'an' | 'the' | '' | 'auto'
  image?: SeoImageValue
  audio?: SeoMediaValue
  video?: SeoMediaValue
}

export type SeoOpenGraphDefaults = Omit<SeoOpenGraphInput, 'url'>

export interface SeoTwitterInput {
  card?: 'summary' | 'summary_large_image' | 'app' | 'player'
  site?: string
  creator?: string
  title?: string
  description?: string
  image?: string | SeoImageInput
}

export interface SeoRobotsInput {
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
    languages?: Record<string, string | null>
  } | null

  structuredData?: JsonObject | readonly JsonObject[] | null
  structuredDataMode?: 'merge' | 'replace'

  meta?: readonly SeoMetaEntry[] | null
  links?: readonly SeoLinkEntry[] | null

  htmlAttributes?: {
    lang?: string | null
    dir?: 'ltr' | 'rtl' | 'auto' | null
  }
}

export interface SeoApplicationConfig {
  enabled?: boolean
  title?: string | null
  siteName?: string | null
  titleTemplate?: string | null
  description?: string | null
  image?: string | null
  index?: boolean
  follow?: boolean
  openGraph?: SeoOpenGraphDefaults | null
  twitter?: SeoTwitterInput | null
  robots?: SeoRobotsInput | null
  structuredData?: JsonObject | readonly JsonObject[] | null
  structuredDataMode?: 'merge' | 'replace'
  meta?: readonly SeoMetaEntry[] | null
  links?: readonly SeoLinkEntry[] | null
  htmlAttributes?: SeoPageInput['htmlAttributes']
  siteUrl?: string
  trailingSlash?: boolean
  mode?: 'public' | 'private'
  allowHttpOrigin?: boolean
  robotsTxt?: RobotsConfig

  canonical?: never
  status?: never
  sitemap?: never
  alternates?: never
}

export interface SeoRouteInput extends SeoPageInput {
  sitemap?: boolean
}
~~~

`SeoSiteDefaults` is not `SeoApplicationConfig`. Request-resolved defaults
cannot carry `siteUrl`, `mode`, `allowHttpOrigin`, `robotsTxt`, `enabled`,
`trailingSlash`, `canonical`, `status`, `sitemap`, `alternates`, or
`openGraph.url`.

### 14.6 Page-owned URL identities

`og:url` is page-owned exactly like `canonical`.

Default derivation:

1. Explicit `openGraph.url` string → use that URL.
2. Else if an effective canonical string exists → `og:url` is that canonical.
3. Else if `canonical === false` or `canonical === null` → do not derive
   `og:url`.
4. Else if canonical is omitted / `undefined` on a normal successful page →
   derive `og:url` from Core `siteOrigin` + normalized current pathname.
5. Else if the response is 404, 410, 5xx, or a redirect → follow the M-5
   error/redirect SEO suppression policy; do not derive a normal `og:url`.

`undefined` is not equivalent to `false` or `null`.

- `canonical: undefined` / omitted: no override. A normal successful page
  still derives `og:url` from the current page URL when no effective
  canonical exists.
- `canonical: false`: explicit disable. No automatic canonical and no
  derived `og:url`.
- `canonical: null`: explicit clear of an inherited canonical. No automatic
  canonical and no derived `og:url`.

A page may still set `openGraph.url` through `route.meta.seo` or `useSeo()`
in cases 4 and 5 only when that explicit page-level value is allowed by the
error/redirect policy. Application and site defaults use
`SeoOpenGraphDefaults` and cannot set `url`.

### 14.7 Layer-aware generic meta and links

Generic `meta` and `links` remain the future-extension hatch.

On `SeoApplicationConfig` and `SeoSiteDefaults`, reject page-owned
semantic identities:

- `link rel="canonical"`
- `link rel="alternate"` when `hreflang` is present
- `meta property="og:url"`

Compare case-insensitively. Duplicate ownership is a validation error.

`rel="alternate"` without `hreflang` remains allowed globally (RSS/Atom
feeds, icons, and other site-wide link relations).

On `SeoPageInput` / `SeoRouteInput` / `useSeo()`, those identities remain
valid through typed fields. Generic page meta/links may still emit them as
an intentional page-level hatch. Complete raw head control stays on the
existing managed-head extension path, not as a silent bypass of typed SEO
restrictions at the global/site layer.

### 14.5 Inherited clearing

Composition is field-by-field across:

~~~text
static application defaults
  ↓
request tenant defaults
  ↓
route / useSeo layers
~~~

For inheritable singletons (`title`, `titleTemplate`, `siteName`,
`description`, `image`):

- `undefined` / omitted → inherit the previous layer
- `null` → clear; lower layers do not leak through
- `string` → set

A tenant with no default title must set `title: null` when the platform
defines `title: 'Builto Website'`. Omitting `title` inherits the platform
value. That inheritance is intentional.

For nested SEO objects (`openGraph`, `twitter`, `robots`):

- `undefined` / omitted → inherit and merge by existing field rules
- `null` → clear the entire inherited object
- object → merge; omitted nested keys inherit, provided keys replace

For generic collections (`meta`, `links`, `structuredData`):

- `undefined` / omitted → inherit / compose
- `null` → clear the complete inherited collection
- array (or a single JSON-LD object) → compose using identity rules

`structuredDataMode: 'replace'` replaces lower JSON-LD blocks with the
supplied blocks. Default remains `'merge'`. SeoSiteDefaults supports
`structuredDataMode` because tenant defaults sit above platform defaults.

For `alternates.languages` on page/route/`useSeo()` layers only:

- omitted key → inherit that language from a parent route or `useSeo` layer
- `string` → set/replace that language URL
- `null` → remove that inherited language identity

Application and site defaults have no first-class `alternates`. A site-wide
`htmlAttributes.lang` is not a page hreflang set.

`index` and `follow` are booleans: omitted inherits, `true`/`false` sets.
They have no `null` clear.

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

### 14.4 Repeatable OG identity

OG `image`, `audio`, and `video` arrays compose in stable order.

- Explicit `key` is the replacement identity. A later entry with the same
  `key` replaces the earlier one and keeps the later position.
- A string shorthand normalizes to `{ url }` with no key.
- Entries without `key` are repeatable ordered values. They never replace
  another entry, including another entry with the same URL.
- `localeAlternate` identity is the locale string: later same locale
  replaces; unknown locales append in stable order.

Twitter `image` is a scalar. Later defined value wins. `key` on a Twitter
image is ignored.

Page-level `image` remains a scalar fallback for the primary image. Later
defined value wins; the site image is fallback. That scalar does not use OG
array identity.

To replace a specific additional OG image, give it a `key` at the site layer
and reuse that `key` on the page. To add another image, omit `key` or use a
new `key`.

## 15. SEO layer composition

Field rules:

| Field | Composition rule |
|---|---|
| title | Later defined value wins; `null` clears inherited title; title template applies once. |
| description | Later defined value wins; `null` clears. |
| image | Later defined value wins; `null` clears; site image is fallback when a string remains. |
| index/follow | Later defined value wins; global values are valid defaults. |
| canonical | Page/route only. `undefined` / omitted inherits or uses the normal page canonical contract. `false` or `null` suppresses canonical and does not derive `og:url`. |
| og:url | Page/route/`useSeo` only. Explicit `openGraph.url` wins; else effective canonical string; else on a normal successful page with omitted canonical, `siteOrigin` + normalized pathname. `canonical: false` / `null` and error/redirect responses do not derive `og:url`. Not valid on application or site defaults. |
| status | Deepest route, active component layers, then Core imperative status. |
| OG/Twitter scalars | Merge by stable meta identity; later same identity wins. |
| OG arrays | Compose in stable order. Explicit `key` replaces; no `key` appends as a repeatable ordered entry. `localeAlternate` identity is the locale string. |
| OG/Twitter/robots objects | `null` clears the inherited object; omitted merges. |
| Robots supplementary directives | Merge by directive identity; page index/follow remain separate. |
| alternates.languages | Page/route/`useSeo` only. Merge by language key; later same language wins; `null` removes that inherited language. Not valid on application or site defaults. |
| structuredData | Append by default; same @id replaces; `null` clears the collection; `structuredDataMode: 'replace'` replaces lower blocks. |
| meta | Compose by semantic/key identity; singleton values replace; `null` clears the inherited collection. |
| links | Compose by semantic/key identity; canonical and hreflang are keyed singletons; `null` clears the inherited collection. |
| htmlAttributes | Merge by name; null removes. |
| sitemap | Route metadata and provider records only; never component SEO. |

Reserved identities prevent duplicate description, robots, canonical, og:url,
hreflang, and other singleton tags even when user-supplied keys differ.

Application and site generic `meta`/`links` cannot recreate those page-owned
identities. See section 14.7.

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

Add a Core helper, separate from SEO. Task-021 must not add `setResponseHeader`.
Generic response headers stay on the existing request context:
`useSsrRequestContext().response.headers`.

~~~ts
export interface SsrResponseRedirectOptions {
  status?: 301 | 302 | 303 | 307 | 308
  allowExternal?: boolean
}

export function setResponseRedirect(
  location: string,
  options?: SsrResponseRedirectOptions,
): void
~~~

Frozen semantics:

- Default `status` is `302`, matching existing Core redirect state.
- `allowExternal` defaults to `false`. Same-origin is required unless
  `allowExternal: true`.
- Location must be HTTP or HTTPS after resolution against the request URL.
- Relative locations are same-origin. URL credentials are rejected.
- CR, LF, NUL, and other control characters in `location` are rejected.
- 301/308 are permanent; 302/303/307 are temporary.
- Redirect responses suppress normal indexable head output and are excluded
  from sitemaps.
- Server: records Core `response.redirect` (existing `SsrResponseState`).
- Browser: no-op. It must not throw, must not perform Vue Router navigation,
  and must not invent a client HTTP redirect. Client navigation remains Vue
  Router.

`setResponseRedirect` is Core-owned and remains available when SEO is
disabled.

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
    resolve: async ({ domain, signal }): Promise<SiteSeoResolution> => {
      const site = await database.sites.byDomain(domain.hostname, { signal })

      if (!site) {
        return { status: 'not-found', responseStatus: 404 }
      }

      return {
        status: 'resolved',
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
  siteRobots: {
    resolve: async ({ domain, siteOrigin, signal }): Promise<SiteRobotsResolution> => {
      const site = await database.sites.byDomain(domain.hostname, { signal })

      if (!site) {
        return { status: 'not-found', responseStatus: 404 }
      }

      return {
        status: 'resolved',
        config: {
          groups: site.robotsGroups,
          sitemaps: [siteOrigin + '/sitemap.xml'],
        },
        revision: site.robotsRevision,
        lastModified: site.updatedAt,
      }
    },
  },
})
~~~

The application configures Core resolveSiteUrl(request) for custom domains. It
returns the validated current origin for the selected tenant.

An unknown host must return `status: 'not-found'`. An existing unpublished
site returns `status: 'resolved'` with `index`/`follow` false. Those are
different contracts.

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
export interface SitemapImageEntry {
  loc: string
}

export interface SitemapVideoEntry {
  thumbnailLoc: string
  title: string
  description: string
  contentLoc?: string
  playerLoc?: string
  duration?: number
  publicationDate?: string | Date
  familyFriendly?: boolean
  live?: boolean
  tags?: readonly string[]
}

export interface SitemapNewsEntry {
  publication: {
    name: string
    language: string
  }
  publicationDate: string | Date
  title: string
}

export interface SitemapEntry {
  loc: string
  lastmod?: string | Date
  changefreq?: 'always' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'never'
  priority?: number
  alternates?: Record<string, string>
  images?: readonly SitemapImageEntry[]
  videos?: readonly SitemapVideoEntry[]
  news?: SitemapNewsEntry
}

export interface SitemapContext extends SeoEndpointContext {
  hostname: string
  subdomain: string | null
  isCustomDomain: boolean
  params: Readonly<Record<string, string>>
}

export interface SitemapShardCollection extends SeoEndpointResultMeta {
  kind: 'sharded'
  revision: string | number
  shardCount: number
  getShard: (
    context: SitemapContext,
    shardNumber: number,
  ) => SitemapSource | Promise<SitemapSource>
}

export type SitemapSource =
  | Iterable<SitemapEntry>
  | AsyncIterable<SitemapEntry>

export interface SitemapEntriesResult extends SeoEndpointResultMeta {
  kind?: 'entries'
  entries: SitemapSource
}

export type SitemapNotFoundResult = {
  status: 'not-found'
  responseStatus?: 404 | 421
}

export type SitemapProviderResult =
  | SitemapSource
  | SitemapShardCollection
  | SitemapEntriesResult
  | SitemapNotFoundResult

export type SitemapProvider = (
  context: SitemapContext,
) => SitemapProviderResult | Promise<SitemapProviderResult>
~~~

A video entry requires `contentLoc` or `playerLoc` (or both). Image sitemaps
use `loc` only; Google-deprecated caption/geo/title/license fields are not
part of the 1.0 public API. News uses the required publication name,
language, date, and title.

Page `loc` values remain same-origin. Image, video, and news media URLs may
be cross-origin under the existing approved-media rules.

### 19.1 Sitemap extension validation

Generic sitemap limits still apply: 50,000 URLs and 50 MB uncompressed per
sitemap file. First-class image, video, and news support adds extension
limits. Invalid extension data must not be serialized. Reject the entry or
the shard; do not emit partial or over-limit extension XML.

Image:

- at most 1,000 `image:image` elements per URL
- 1,001 images on one `SitemapEntry` is a validation failure

News:

- at most 1,000 `news:news` entries per sitemap file, even when the URL
  count is below 50,000
- a shard or document with 1,001 news entries is a validation failure
- providers must attach news metadata only to recent articles appropriate
  for a News sitemap
- when news metadata ages out, omit the `news` extension; do not delete the
  normal sitemap URL

Video:

- `thumbnailLoc`, `title`, and `description` are required
- `contentLoc` or `playerLoc` is required (or both)
- `duration`, when present, must be an integer from 1 through 28,800
  seconds
- `description` must be at most 2,048 characters
- `tags` must contain at most 32 entries
- date values (`publicationDate`, and `lastmod` on the parent URL) must
  serialize to valid W3C Datetime / ISO 8601

A sharded news collection must size shards so each sitemap file stays within
the 1,000 news-entry bound. Generic 50k/50MB tests are not sufficient for
extension XML.

Returning a bare `SitemapSource` keeps the current small-site API. Cache
metadata for non-sharded providers uses `SitemapEntriesResult`. Sharded
providers already require `revision`; they may also set `lastModified`,
`cacheControl`, and `cacheTags`. `getShard` receives `shardNumber` where
`1 <= shardNumber <= shardCount`. `/sitemap-1.xml` maps to
`getShard(context, 1)`.

### 19.2 SEO endpoint tenant gating

`siteSeo` is the authoritative site/tenant existence gate for every SEO
endpoint of that application when it is configured.

If `siteSeo` is configured and returns `not-found`:

- `/sitemap.xml`, `/sitemap-N.xml`, and `/robots.txt` short-circuit with the
  same 404/421 policy
- the sitemap provider is not called
- `siteRobots.resolve()` is not called
- no tenant sitemap or robots body is emitted
- no normal cache write

`siteRobots` is never the sitemap gate. A robots `not-found` result does not
control sitemap dispatch.

If `siteSeo` is not configured, a `SitemapProvider` may return
`SitemapNotFoundResult` for an unknown host. That keeps dynamic providers
self-contained and symmetrical with `siteSeo` / `siteRobots`.

A sitemap `not-found` result does not call `siteRobots`. Each remaining
endpoint still fails closed for that host: no other tenant's URLs, no empty
platform sitemap as a success body.

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

1.0 has exactly one dynamic robots API: `siteRobots` on application config,
parallel to `siteSeo`. There is no `defineRobots()` and no `robots.config.ts`.

~~~ts
export interface RobotsGroup {
  userAgents: string | readonly string[]
  allow?: readonly string[]
  disallow?: readonly string[]
  directives?: Record<string, string | number | boolean>
}

export interface RobotsLegacyConfig {
  groups?: never
  allow?: string | readonly string[]
  disallow?: string | readonly string[]
  sitemaps?: readonly string[]
}

export interface RobotsGroupsConfig {
  groups: readonly RobotsGroup[]
  sitemaps?: readonly string[]
  allow?: never
  disallow?: never
}

export type RobotsConfig = RobotsLegacyConfig | RobotsGroupsConfig

export type SiteRobotsContext = SeoEndpointContext

export type SiteRobotsResolution =
  | ({
      status: 'resolved'
      config: RobotsConfig
    } & SeoEndpointResultMeta)
  | {
      status: 'not-found'
      responseStatus?: 404 | 421
    }

export type SiteRobotsResolver = (
  context: SiteRobotsContext,
) => SiteRobotsResolution | Promise<SiteRobotsResolution>

export interface SiteRobotsConfig {
  resolve: SiteRobotsResolver
}
~~~

Single-application:

~~~ts
export default defineSsrConfig({
  siteRobots: {
    resolve: async (context) => ({
      status: 'resolved',
      config: {
        groups: [
          { userAgents: '*', allow: ['/'], disallow: ['/admin'] },
        ],
        sitemaps: [context.siteOrigin + '/sitemap.xml'],
      },
      revision: 'robots-rev-1',
    }),
  },
})
~~~

Multi-application:

~~~ts
export default defineSsrConfig({
  applications: {
    website: {
      siteRobots: {
        resolve: async (context) => resolveTenantRobots(context),
      },
    },
  },
})
~~~

Resolution precedence for `/robots.txt`:

~~~text
seo.mode === 'private' → framework conservative Disallow: /; do not call siteRobots
  ↓
siteRobots.resolve() when configured
  ↓
static seo.robotsTxt
  ↓
framework default wildcard Allow: /
~~~

Private mode is static application configuration. It is not request-dynamic
through siteSeo or siteRobots. Preview/private still requires real
authentication/access control. Robots.txt is not privacy or authorization.

`siteRobots.resolve()` uses `SiteRobotsContext` (`SeoEndpointContext`):
`applicationId`, `siteOrigin`, `domain`, `signal`, `pathname`, `search`.
It does not receive `publicConfig`. Tenant lookup uses `domain` /
`siteOrigin`. It must not be treated as a page SEO provider; `/robots.txt`
is a distinct HTTP request.

When `siteSeo` is configured, resolve it first. A siteSeo `not-found` result
skips `siteRobots` entirely (section 19.2). `siteRobots` does not gate
sitemap.

Legacy `seo.robotsTxt` allow/disallow shorthand remains valid. Normalization:

~~~text
RobotsLegacyConfig allow/disallow
  → one User-agent: * group
  → a string allow/disallow value becomes a one-element array
  → omitted allow normalizes to ['/']
  → sitemaps pass through
~~~

`RobotsGroupsConfig` is the explicit multi-group form. Mixing `groups` with
`allow`/`disallow` is a type error.

Failure:

- `status: 'not-found'` → HTTP `responseStatus ?? 404`, no tenant robots
  body, no cache write
- throw/timeout → 503/configured failure policy, no false public policy
- abort → stop work, no cache write

### 20.1 SeoRobotsInput.additional reserved names

`additional` is only for unknown/future meta robots directives. First-class
names are reserved and cannot appear in `additional`, compared
case-insensitively after normalizing hyphens/underscores/camelCase to one
directive identity.

Reserved identities:

- `index`, `noindex`
- `follow`, `nofollow`
- `nosnippet`, `noimageindex`
- `max-snippet`, `max-image-preview`, `max-video-preview`
- `notranslate`, `indexifembedded`, `unavailable_after`, `noarchive`

Those include both the typed field names (`maxSnippet`, `unavailableAfter`)
and their robots-token forms. Duplicate ownership is a validation error, not
a merge.

`additional` key syntax: `/^[A-Za-z][A-Za-z0-9-]*$/`. Reject `:`, `/`,
whitespace, CR, LF, NUL, and other control characters in keys and values.

Rendering:

- boolean `true` → emit the directive token only
- boolean `false` → omit the directive
- number → `token:number`
- string → `token:value` after control-character rejection

`RobotsGroup.directives` uses the same control-character rules. It must also
reject robots.txt field names that already have first-class fields:
`user-agent`, `allow`, `disallow`, `sitemap`.

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
- duplicate singleton head identities;
- global/site generic meta/links cannot recreate canonical, hreflang, or og:url.

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
not normal page-cache entries. `status: 'not-found'` is tenant-missing: it
must not produce a 200 cache entry with platform/default SEO.

### 23.1 Provider and endpoint cache metadata

~~~ts
export interface SeoProviderMeta {
  revision?: string | number
  cacheTags?: readonly string[]
}

export interface SeoEndpointResultMeta extends SeoProviderMeta {
  lastModified?: string | Date
  cacheControl?: string
}
~~~

Ownership:

- `SiteSeoResolution` uses `SeoProviderMeta` only
- `SiteRobotsResolution`, `SitemapEntriesResult`, and
  `SitemapShardCollection` use `SeoEndpointResultMeta`

`siteSeo` is not an HTTP SEO endpoint. `lastModified` and `cacheControl` on
`siteSeo.resolve()` are not part of the public API and have no HTML, ETag,
or response-cache meaning. Task-021 must not read them from siteSeo.

There is no structured `maxAge` / `staleWhileRevalidate` field. If those
policies are needed on sitemap or robots responses, pass a validated
`cacheControl` string.

Semantics:

- HTML page cache identity remains the snapshot hash from M-9. siteSeo
  `revision` / `cacheTags` are invalidation and observability hints, not an
  HTML ETag API.
- `/robots.txt` and `/sitemap.xml` (including shards) use endpoint metadata
  as HTTP validators when present:
  - `revision` → ETag
  - `lastModified` → Last-Modified
  - `cacheControl` → Cache-Control, after CR/LF/control-character rejection
- Sharded sitemaps still require `revision` (M-7). Other endpoint results may
  omit it; the framework then uses its default endpoint cache policy.
- `cacheTags` are invalidation hints, not HTTP headers.
- Conditional GET (If-None-Match / If-Modified-Since) applies to sitemap and
  robots endpoints when validators are present.

Task-021 implements these semantics. It must not invent a second public
cache-config object.

## 24. Failure behavior

| Failure | Behavior |
|---|---|
| Site SEO timeout | Abort-aware 503/504 policy; never another tenant's defaults. |
| Tenant not found | `siteSeo` `not-found` gates HTML/sitemap/robots and skips those providers. Independent `SitemapNotFoundResult` / `SiteRobotsResolution` `not-found` when siteSeo is not configured. HTTP `responseStatus ?? 404` (404 or 421 only); no tenant snapshot, canonical, sitemap, or robots output; no normal cache entry. |
| Malformed SEO field | Reject or omit the field according to validation severity; log details. |
| Sitemap failure | 503 or configured stale-cache policy; never partial XML. |
| Sitemap extension limit | Reject the entry or shard; never emit over-limit image/video/news XML. |
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
setResponseRedirect(...)
useSsrRequestContext().response.headers
~~~

Required pre-1.0 correction:

- remove global canonical, status, and sitemap;
- keep global index and follow;
- keep global title, description, and image, including `null` clearing;
- keep global html lang/dir;
- reject global first-class canonical, status, sitemap, alternates, and openGraph.url;
- keep existing common global SEO fields;
- keep array sitemap providers for small sites;
- keep robots allow/disallow shorthand;
- keep noarchive compatibility;
- keep static seo.robotsTxt as the fallback when siteRobots is not configured.

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
- src/SsrBrowserRuntime.ts
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
3. Add server-only site-stable siteSeo resolver with `SiteSeoResolution` (`resolved` | `not-found`). Context has no pathname, search, or publicConfig.
4. Serialize validated public `SeoSiteDefaults` into existing hydration state. The browser restores that snapshot, keeps it across same-origin client navigation, and never calls `siteSeo.resolve()`.
5. Implement parent-to-child route composition.
6. Implement deterministic field-specific SEO composition, including OG `key` identity, `null` collection clearing, and page-level hreflang `null` removal.
7. Add whole-object reactive useSeo().
8. Add scoped declarative status lifecycle.
9. Add Core `setResponseRedirect()`. Do not add `setResponseHeader`; keep headers on `useSsrRequestContext().response.headers`.
10. Implement error and redirect SEO rules, including tenant-not-found 404/421 fail-closed.
11. Implement keyed meta/link composition and layer-aware reserved identities (global/site cannot emit canonical, hreflang, or og:url).
12. Implement JSON-LD composition and explicit replacement.
13. Add page/route hreflang and safe lang/dir attributes. Do not accept first-class `alternates` on application or site defaults.
14. Add server-only `siteRobots.resolve()` and reserved `additional` validation. Endpoint context has no publicConfig.
15. Add sitemap extensions, same-origin validation, and extension-specific limits.
16. Add explicit large-site shard/index contract with 1-based `shardNumber`.
17. Add automatic site SEO snapshot hashing to SSR cache identity.
18. Implement `SeoProviderMeta` for siteSeo and `SeoEndpointResultMeta` for sitemap/robots validators.
19. Add security, cancellation, and failure tests.
20. Update README and package smoke coverage.

## 28. Required validation matrix

### Global and dynamic resolution

- static global defaults;
- global index/follow defaults;
- request-resolved tenant defaults;
- tenant `title: null` clears platform title; omitted title inherits;
- `openGraph`/`twitter`/`robots: null` clears the inherited object;
- `meta`/`links`/`structuredData: null` clears inherited collections;
- `structuredDataMode: 'replace'` at the site layer replaces platform JSON-LD;
- `alternates.languages[lang] = null` removes that language on page/route layers only;
- application/site defaults reject first-class `alternates` and `openGraph.url`;
- page `og:url` defaults from effective canonical, else current page URL when canonical is omitted;
- `canonical: false` or `null` does not derive og:url unless `openGraph.url` is explicit;
- omitted canonical on a normal page still derives og:url from siteOrigin + pathname;
- page may override `og:url`; 404/410/5xx/redirect do not derive og:url unless explicit and allowed;
- global/site generic `meta property="og:url"` rejected;
- global/site generic `link rel="canonical"` rejected;
- global/site generic `link rel="alternate"` with hreflang rejected;
- global `rel="alternate"` without hreflang remains allowed;
- tenant-not-found returns `status: 'not-found'`, not index/follow false;
- tenant-not-found never yields HTTP 200 with platform/default SEO;
- unpublished existing tenant may resolve with index/follow false;
- same-path concurrent tenants;
- resolver timeout, error, and abort;
- tenant-not-found isolation;
- hydration restores the public site snapshot only;
- client-side navigation keeps the hydrated site snapshot;
- SPA navigation and hard reload of the same origin/tenant see the same site defaults;
- siteSeo context has no pathname, search, or publicConfig and is not a page resolver;
- sitemap/robots context has no publicConfig;
- endpoint cache identity does not vary on header-derived publicConfig;
- browser never calls siteSeo.resolve() or siteRobots.resolve();
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
- setResponseRedirect default 302 and same-origin unless allowExternal;
- setResponseRedirect is a browser no-op;
- no public setResponseHeader helper;
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
- OG explicit `key` replacement versus unkeyed ordered append;
- Twitter/X fields;
- hreflang and x-default on page/route/`useSeo` only;
- application/site first-class `alternates` rejected;
- og:url derived from canonical string, else current page URL when canonical is omitted;
- `canonical: false` / `null` does not derive og:url;
- application/site `openGraph.url` rejected;
- global/site generic canonical, hreflang, and og:url rejected;
- generic `links` may still set `rel="alternate"` without hreflang;
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
- at most 1,000 images per URL;
- at most 1,000 news entries per sitemap file;
- news metadata aging omits `news` but keeps the URL;
- video requires contentLoc or playerLoc;
- video duration 1..28800, description <= 2048 chars, at most 32 tags;
- invalid extension data is rejected, not emitted;
- shard index and deterministic shard names;
- getShard(context, 1) serves /sitemap-1.xml;
- siteSeo not-found skips sitemap and robots providers;
- sitemap not-found without siteSeo;
- siteRobots does not gate sitemap;
- revision mismatch;
- provider cancellation;
- concurrent tenants;
- ETag and conditional GET;
- provider failure.

### Robots and security

- default wildcard group;
- legacy robotsTxt allow/disallow normalizes to one User-agent: * group;
- mixing groups with allow/disallow is rejected;
- multiple user-agent groups;
- siteRobots.resolve() tenant policy;
- siteRobots not-found 404/421;
- reserved robots.additional names rejected;
- preview/private policy skips siteRobots and emits Disallow: /;
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
- server-only siteSeo resolution and `SiteSeoResolution`;
- siteSeo site-stable context (no pathname, search, or publicConfig);
- sitemap/robots endpoint context (no publicConfig);
- tenant-not-found fail-closed behavior;
- hydration of public site SEO defaults;
- global/site title and `null` clearing;
- `meta`/`links`/`structuredData` collection clearing;
- page/route hreflang only; `null` language removal on those layers;
- site-wide `htmlAttributes.lang` is not page hreflang;
- page-owned `og:url`; omitted canonical still derives from the current page URL; `false`/`null` does not;
- global/site Open Graph has no `url`;
- global/site generic meta/links cannot emit canonical, hreflang, or og:url;
- Core-owned canonical origin;
- custom domains and subdomains;
- hreflang and x-default;
- structured-data composition;
- OG array `key` identity;
- dynamic sitemap records and sharded sitemaps;
- sitemap `shardNumber` 1-based URLs;
- siteSeo endpoint gating;
- image/video/news sitemap extension limits;
- server-only siteRobots.resolve();
- legacy robotsTxt allow/disallow versus groups;
- reserved robots.additional names;
- preview/private limitations;
- robots.txt not being access control;
- automatic response-cache SEO variation;
- SeoProviderMeta versus SeoEndpointResultMeta;
- Core `setResponseRedirect` (no `setResponseHeader`);
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
- raw HTML injection;
- public `setResponseHeader` helper (use `useSsrRequestContext().response.headers`).

## Final recommendation

The current implementation remains **SEO API NOT READY FOR 1.0** until
task-021 implements this contract.

Revision-007 closes the remaining `og:url` fallback contradiction from
review/007 without reopening accepted architecture.

| Finding | Status |
|---|---|
| M-1 Global index/follow remain valid | ACCEPTED |
| M-2 One Core siteOrigin authority | ACCEPTED |
| M-3 index/follow one owner | ACCEPTED |
| M-4 Component sitemap membership removed | ACCEPTED |
| M-5 Error SEO policy corrected | ACCEPTED |
| M-6 Dynamic sitemap provider owns membership | ACCEPTED |
| M-7 Large sitemap shard contract | ACCEPTED |
| M-8 Server-only siteSeo types/result/failure | CLOSED |
| M-9 Framework-owned SEO cache hashing | ACCEPTED |
| M-10 Tenant-not-found result union | CLOSED |
| M-11 SiteSeo public types and SeoSiteDefaults | CLOSED |
| M-12 siteRobots.resolve() API | CLOSED |
| M-13 Referenced OG/Twitter/sitemap types | CLOSED |
| M-14 Repeatable OG `key` identity | CLOSED |
| M-15 Reserved robots.additional names | CLOSED |
| M-16 Endpoint metadata | CLOSED (split in M-21) |
| M-17 Server → hydration site SEO rule | CLOSED (site-scoped in M-18) |
| M-18 SiteSeoContext is site-stable | CLOSED (structurally completed in M-23) |
| M-19 Robots legacy allow/disallow type | CLOSED |
| M-20 Global/site title and clearing | CLOSED (collections completed in M-24) |
| M-21 SeoProviderMeta vs SeoEndpointResultMeta | CLOSED |
| M-22 Sitemap extension validation limits | CLOSED |
| M-23 SiteSeoContext excludes publicConfig | CLOSED |
| M-24 Generic collection and hreflang clearing | CLOSED |
| M-25 setResponseRedirect; no setResponseHeader | CLOSED |
| M-26 shardNumber and sitemap not-found gating | CLOSED |
| M-27 Page-only first-class `alternates` | CLOSED |
| M-28 Endpoint context excludes publicConfig | CLOSED |
| M-29 Page-owned og:url and generic URL identities | CLOSED |
| M-30 og:url fallback vs canonical undefined/false/null | CLOSED |

**SEO 1.0 IMPLEMENTATION CONTRACT READY**

Task-021 may now implement and harden this contract. Task-021 must not invent
public API shape for the types and failure modes named in this document.


