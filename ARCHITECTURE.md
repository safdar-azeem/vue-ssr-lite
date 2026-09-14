# Repository architecture

`vue-ssr-lite` is organized by framework responsibility. Consumer conventions
(`server.ts`, `src/main.ts`, `src/App.vue`, and `index.html`) are independent of
this internal layout.

## Repository map

```text
src/                 Production package source and build integrations
  index.ts           vue-ssr-lite
  client.ts          vue-ssr-lite/client
  server.ts          vue-ssr-lite/server
  vite.ts            vue-ssr-lite/vite
  application/
  assets/
  browser/
  config/
    compile/
    modules/
    projection/
  data/fetch/
  deployment/vercel/
  diagnostics/
  extensions/
    core/
    seo/
  head/
  hydration/
  middleware/
  navigation/
  rendering/
  request/
  server/
    runtime/
    routes/
  vite/
  cli/
tests/
  unit/              Focused module and subsystem contracts
  integration/       Rendering, browser, transport, Vite, and consumer scenarios
  architecture/      Public API, release, source, and bundle boundaries
  helpers/           Shared test setup and fetch harness
  environment/       Custom jsdom environment
  fixtures/          Consumer applications used by tests and audits
tools/
  audits/            Bundle, capability, attribution, and release-regression analysis
  package/           Package artifact, declaration, and installed-consumer smoke checks
  resolution/        TypeScript module resolution hooks for test workers
examples/            User-facing applications, separate from fixtures
```

## Production ownership

| Domain | Responsibility |
| --- | --- |
| `application` | Vue application creation, installation, disposal, host capabilities, and application lifecycle contracts (`SsrApplicationTypes`). |
| `browser` | Hydration/SPA startup, browser resolution, capability activation, and browser timing. |
| `config` | Public configuration types and helpers, public-config snapshots, and server-configuration convenience helpers. |
| `config/compile` | Config-file discovery and evaluation, module-graph boundaries, normalization, and compiled runtime configuration. |
| `config/modules` | Server/client module source emitted from resolved configuration entries. |
| `config/projection` | Static application/import analysis, browser-safe projection, and mutation validation. |
| `rendering` | SSR render passes, reconciliation, template preparation/injection, and HTML escaping. The public watcher bridge here is also browser-safe. |
| `hydration` | Hydration lifecycle, payload serialization, and Vue hydration compatibility. |
| `request` | Request context, request/header/domain contracts, domain/origin authority, response status, resolution contracts, and server request-state observation. |
| `assets` | Asset manifests, source attribution, request-selected resources, and browser stylesheet handoff. HTTP file serving belongs to `server/runtime`. |
| `diagnostics` | Error classification, logging/metrics contracts, timing diagnostics, and public/development error documents. |
| `head` | Managed head collection, serialization, and DOM reconciliation. |
| `navigation` | Vue navigation transactions, loading UI, enhanced `RouterView`, and SSR/SPA route transitions. |
| `middleware` | Universal Vue navigation middleware, including browser activation. |
| `data/fetch` | `useFetch`, request identity, execution, caching, hydration, and runtime ownership. |
| `extensions/core` | Extension definitions, context, and lifecycle; `extensions/seo` owns the built-in SEO implementation and its endpoints. |
| `server/runtime` | HTTP hosting, transport, endpoint/readiness/cache/error-render contracts, request pipeline, admission, response cache, static files, and production/development lifecycle. |
| `server/routes` | HTTP route compilation/dispatch, HTTP middleware, native responses, and their public types/identity helpers. |
| `deployment` | Provider detection, deployment metadata/assets, and adapters such as Vercel. |
| `vite` | Plugin lifecycle, virtual modules, SSR module loading, and development/build asset integration. |
| `cli` | CLI arguments, commands, development console, and Vite orchestration. |

Configuration flows from public helpers/types through discovery and the config
graph, into normalized configuration and browser projection, then into emitted
runtime modules. `projection/index.ts` is the compiler-facing surface. Its
implementation separates AST syntax, lexical scopes/helper identity, import
safety, source detection, single-module validation, cross-module mutation
validation, and emission/coverage/merging. Keep these checks explicit.

## Boundaries and dependency direction

The four root entrypoints are explicit, thin façades. Keep their exported names,
package export keys, and `dist/{index,client,server,vite}.mjs` and declaration
entrypaths stable. The CLI remains `dist/cli.mjs`. Private renderer and Vercel
build entries also retain their existing output names. Internal modules import
the responsible domain directly; add a barrel only for a meaningful surface.

Production source must never import tests, fixtures, examples, or tools. Tests
and tools may import production internals. Application/browser execution must
not import CLI, deployment, Vite implementation, config compilation, Node
built-ins, or HTTP execution code. CLI and deployment orchestration may depend
on server/build infrastructure; Vite may depend on config compilation and asset
metadata. Keep type-only dependencies explicitly type-only.

A folder name alone does not establish browser safety. Public HTTP identity
helpers and types in `server/routes` are browser-safe; its execution modules and
`server/runtime` are server-only. Likewise, request observation, server
reconciliation, fetch async-local scope, source attribution, and SEO endpoints
have server/build ownership even when neighboring modules are universal.
`extensions/seo/server.ts` converts head contributions and is browser-safe despite
its historical filename. Follow the actual import graph and existing boundary
checks when adding dependencies.

Source identities are part of internal regression contracts. When moving an
implementation, update bootstrap identities, projection helper recognition,
source/installed module attribution, and the reviewed browser-module allowlist
in `tools/audits/SsrPerformanceContracts.ts`. Preserve the strength of those
checks and keep source and installed-package accounting aligned.

## Where new work goes

Choose the domain that owns the behavior; transport belongs to the HTTP server,
Vue route transitions to navigation, and application configuration to config.
Extend a focused module before adding an abstraction. Retain established `Ssr`
names and split files only when responsibilities can be separated coherently.

Place focused tests under `tests/unit/<domain>`, scenarios across domains under
`tests/integration/<domain>`, and package/source-boundary contracts under
`tests/architecture`. Existing mixed suites remain whole to preserve coverage.
Consumer fixtures belong in `tests/fixtures`; runnable demonstrations stay in
`examples`. Audit implementations belong in `tools`, with their
tests under `tests/unit/tools` or `tests/architecture`.

Vitest discovers `tests/**/*.test.ts` and preserves the separate Admin SPA jsdom
project. Typechecking includes production source, audit TypeScript,
and shared test helpers; package declaration generation includes only `src`.
Keep reports and local migration artifacts under
`node_modules/.cache/vue-ssr-lite`, outside the published package.
