# Builto Website Builder compatibility analysis

Builto was analyzed but intentionally not modified in this phase.

## Current public runtime

The public entry is `src/site/main.ts` + `SiteApp.vue`, mounted from `site.html`. It is CSR-only, creates a separate public `vue-apollo-client`, resolves a development slug or domain from `window.location`, manages navigation with `history.pushState`, loads a published/draft shell through generated operations, loads active section content through version-pinned controllers, registers public templates, renders through `WebsiteRenderer`, and produces SEO through `vlite3` bindings. The builder/admin entry, routes, authenticated Apollo client, editing stores, forms, and autosave are independent.

## Package fit

The package API supports a later Builto migration without Builto-specific runtime branches:

- `site.html` becomes a normal plugin-managed SSR template and the builder remains a SPA entry.
- Host patterns support `*.localhost`, the production Builto base domain, and verified custom domains; `createExtension` can resolve slug/domain/publication data.
- A catch-all Vue Router route can replace manual history state and provide identical server/browser route replay for home, dynamic pages, blogs/projects, and not-found paths.
- Named/versioned Apollo caches support different public endpoints and publication versions. Request-scoped clients prevent domains/publications from sharing data.
- Publication snapshots, draft preview, template registration, section loading, and contact operations remain Builto-owned application logic.
- `resolveHead`/request context support Builto SEO, Open Graph, canonical origin, favicon, JSON-LD, website-not-found, page-not-found, unpublished, and noindex states.
- Draft preview may remain client-only by returning an application shell; no builder authentication cookie needs to enter public SSR.
- Cache keys can be supplied externally using application + normalized hostname/resolved website + route + publication version + locale. The default package cache remains off.

## Migration cautions for the later phase

- `SiteApp.vue` currently reads `window` at module setup boundaries and must receive location from the request context/router.
- The current `network-only` public shell policy would intentionally bypass hydration cache; it should become cache-first for published initial data or explicitly rely on restored state.
- Public template dynamic imports and every `vlite3` block must pass server-render smoke tests.
- Router v5 compatibility must be validated against the package's declared `>=4 <6` peer range.
- Draft and published data must remain isolated, and only verified published snapshots may be anonymously cacheable.
- The builder entry and its authenticated Apollo/global stores must remain outside the public client/server entry graphs.

These are generic extension-point requirements; none requires an application-name conditional in `vue-ssr-lite`.
