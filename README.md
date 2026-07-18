# vue-ssr-lite

An API-client-neutral managed Vue 3 SSR runtime. It owns server creation, host
classification, isolated Vue applications and routers, rendering, generic
plugin hydration state, browser hydration, assets, errors, timeouts, metrics,
and request cleanup.

It does not import or understand Apollo, GraphQL, REST clients, authentication,
or application queries.

## Minimal application

```ts
import { defineSsrApplication } from 'vue-ssr-lite'
import apolloConfiguration from './config/ApolloConfiguration'
import StorefrontApp from './StorefrontApp.vue'
import { storefrontRoutes } from './routes'

export const storefrontApplication = defineSsrApplication({
  id: 'storefront',
  rootComponent: StorefrontApp,
  routes: storefrontRoutes,
  plugins: [apolloConfiguration],
})
```

`plugins` contains ordinary Vue plugins. `vue-ssr-lite` provides the generic
request and hydration contexts before installing them, so each plugin can
derive request scope and contribute serializable state without a framework
adapter or application `install` callback.

Declare SPA/SSR host routing and minimal public configuration:

```ts
import { defineSsrRuntime } from 'vue-ssr-lite'
import { storefrontApplication } from './StorefrontApplication'

export default defineSsrRuntime({
  name: 'unified-app',
  entries: [
    {
      id: 'admin',
      kind: 'spa',
      template: 'index.html',
      hosts: ['admin.example.com'],
    },
    {
      id: 'storefront',
      kind: 'ssr',
      template: 'site.html',
      hosts: ['*'],
      application: storefrontApplication,
    },
  ],
  server: {
    publicConfig: { shopBaseDomain: 'shop.example.com' },
  },
})
```

Register the SSR browser entry in Vite:

```ts
import { vueSsrLite } from 'vue-ssr-lite/vite'

export default {
  plugins: [
    vueSsrLite({
      applications: [{
        id: 'storefront',
        definition: 'src/StorefrontApplication.ts',
        exportName: 'storefrontApplication',
        template: 'site.html',
      }],
      spaEntries: { admin: 'index.html' },
    }),
  ],
}
```

The package Vite plugin owns Vue/Router deduplication and keeps
`vue-ssr-lite` external so the managed server and consumer bundle share the
same runtime. API-client Vite plugins own their own dependency identity.

## Request lifecycle

For every SSR request the package:

1. classifies the normalized host and deployment role;
2. creates a new Vue app, memory router, state, head, response, abort signal,
   request context, and hydration controller;
3. provides globally stable request/hydration injection keys;
4. installs generic application plugins;
5. resolves the route and waits for native Vue server-prefetch work;
6. renders HTML and collects plugin hydration state;
7. serializes escaped state into the application document; and
8. disposes all request-owned plugin resources.

Browser hydration restores the serialized application/plugin state before
component setup and mounts through the same application definition.

## Public package boundaries

- `vue-ssr-lite`: isomorphic definitions, request context, hydration contract,
  serialization, and public types.
- `vue-ssr-lite/client`: browser hydration only.
- `vue-ssr-lite/server`: renderer, Node lifecycle, host/proxy/cookie handling,
  assets, readiness, response caching, and shutdown.
- `vue-ssr-lite/vite`: HTML transformation, virtual browser entries, framework
  identity, and build inputs.

Application code may define routes, generic plugins, typed state/extensions,
head/status/redirect behavior, host entries, response caches, endpoints, and
service readiness. It never calls `renderToString`, manages API-client caches,
injects hydration HTML, starts the server, or performs request cleanup.

## Commands

```json
{
  "scripts": {
    "dev": "vue-ssr-lite dev --runtime src/SsrRuntime.ts",
    "build": "vue-ssr-lite build --runtime src/SsrRuntime.ts",
    "start": "vue-ssr-lite start"
  }
}
```

Production emits the consumer server runtime at
`dist/server/SsrRuntime.js` and browser assets under `dist/client`.
