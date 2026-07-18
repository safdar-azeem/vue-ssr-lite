# Builto Website Builder compatibility analysis

Builto's public website builder has now been migrated onto the package's SSR,
hydration and unified-bootstrap contracts. This document records the original
analysis and the resolution status of each migration item.

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

## Migration status

- **Resolved.** `SiteApp.vue` no longer reads `window` at setup; it is a thin root over the shared runtime and derives location from the router/request context. Section data enters `WebsiteSectionDataState` through `ssrWatch` and the section loaders, never a discarded watcher.
- **Resolved.** The public shell query is `cache-first`; hydration serves from the restored Apollo cache with no duplicate request (single restore path in `vue-apollo-client`).
- **Resolved.** The public portfolio template registers an eager renderer, and `WebsiteRenderer` resolves it synchronously; the registry now rejects an SSR template that lacks a synchronous renderer.
- **Resolved.** Router v5 compatibility is validated. `builto-webBuilder` runs on `vue-router` v5 and its route contract test passes against the package's `>=4 <6` peer range; `erp-app` and the package's own suite exercise v4. Route matching, memory/web history replay and `resolve()` behaviour are identical across both majors for the record shapes used here.
- **Resolved.** Home, dynamic pages, blog/project listings and detail slugs, and unknown depths are real route records (`WebsitePublicRoutes.ts`), producing correct 200/404 status naturally. Draft and published data remain isolated; only verified published snapshots are anonymously cacheable.
- **Resolved.** The builder entry uses a separate application id (`website-builder`) and auth boundary (`admin`); the public client (`website-public`) reads no token on the server. Only the request-scoped, allow-listed preview cookie is forwarded.

These are generic extension-point requirements; none required an
application-name conditional in `vue-ssr-lite`.
