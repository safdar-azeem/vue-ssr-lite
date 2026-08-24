# vue-ssr-lite

A lightweight, convention-first Server-Side Rendering (SSR) runtime for Vue 3 and Vite.

---

## 📦 Installation

```bash
npm install vue-ssr-lite vue-router
```

---

## 🚀 Setup

### 1. Vite Plugin

Add `vueSsrLite()` to your `vite.config.ts`:

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { vueSsrLite } from 'vue-ssr-lite/vite'

export default defineConfig({
  plugins: [vue(), vueSsrLite()],
})
```

### 2. Package Scripts

Add the SSR scripts to your `package.json`:

```json
{
  "scripts": {
    "dev": "vue-ssr-lite dev",
    "build": "vue-ssr-lite build",
    "start": "vue-ssr-lite start"
  }
}
```

### 3. HTML Entry

Keep your standard Vite `index.html` (no changes needed):

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>My Vue App</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

---

## 📁 Project Structure

```text
my-vue-app/
├── src/
│   ├── components/
│   ├── router/
│   │   └── routes.ts      # Route definitions
│   ├── views/
│   ├── App.vue            # Root component
│   └── main.ts            # Application definition (defineApplication)
├── index.html             # Standard Vite HTML
├── vite.config.ts         # Vite configuration with vueSsrLite plugin
├── ssr.config.ts          # (Optional) Server configuration
└── package.json
```

---

## ⚙️ Configuration

### 1. Configure `src/main.ts`

Replace `createApp().mount()` with `defineApplication()`:

```ts
// src/main.ts
import { defineApplication } from 'vue-ssr-lite'
import App from './App.vue'
import routes from './router/routes'

export default defineApplication({
  root: App,
  routes,
})
```

> **Migrating from `app.use(router)`:** Pass your route records directly to `defineApplication({ routes })`. `vue-ssr-lite` creates the router automatically using memory history on the server and web history in the browser. *(For custom `createRouter()` options, see [Custom Router Factory](#custom-router-factory) below).*

> **Plugins:** If your application uses Pinia or other stateful plugins, return them from a factory function so each server request gets an isolated instance:
> ```ts
> plugins: () => [
>   createPinia(),
> ],
> ```

> **Optional `install()` hook:** Need `app.component()`, `app.directive()`, `app.provide()`, or navigation guards? Add the optional hook:
> ```ts
> install({ app, router, server }) {
>   app.component('MyHeader', MyHeader)
>   app.provide('apiUrl', 'https://api.example.com')
> }
> ```

### 2. (Optional) Server Configuration `ssr.config.ts`

```ts
// ssr.config.ts
import { defineSsrConfig } from 'vue-ssr-lite/server'

export default defineSsrConfig({
  server: {
    port: 3000,
    trustProxy: true,
  },
  publicConfig: {
    apiUrl: process.env.API_URL || 'https://api.example.com',
  },
})
```

---

## 💡 How to Use

### 1. Server Data Fetching

Use Vue's standard `onServerPrefetch()` hook to resolve asynchronous data before the SSR HTML is rendered. Data that needs to hydrate on the client should be managed by a store or data-fetching integration that supports serialization.

### 2. Reactive SEO & Head Tags (`useSeo`)

```vue
<!-- src/views/ProductView.vue -->
<script setup lang="ts">
import { useSeo } from 'vue-ssr-lite'

useSeo({
  title: 'Wireless Headphones',
  description: 'High quality audio product.',
})
</script>
```

> Canonical URLs and social metadata can be derived from application SEO configuration or passed directly to `useSeo()`. Reactive titles (`title: computed(...)`) and Open Graph objects are also supported.

### 3. HTTP Status Codes & 404 Pages (`setResponseStatus`)

```vue
<!-- src/views/NotFound.vue -->
<script setup lang="ts">
import { setResponseStatus, useSeo } from 'vue-ssr-lite'

setResponseStatus(404)

useSeo({
  title: '404 - Page Not Found',
})
</script>

<template>
  <h1>404 - Page Not Found</h1>
</template>
```

### 4. Runtime Helpers

```vue
<script setup lang="ts">
import { usePublicConfig, useSiteOrigin } from 'vue-ssr-lite'

const config = usePublicConfig<{ apiUrl: string }>()
const siteOrigin = useSiteOrigin() // e.g. "https://example.com"
</script>
```

---

## 🚀 Advanced Configuration

### Custom Router Factory

If your application requires custom `createRouter()` options (e.g. scroll behavior or other custom createRouter options), use the `router` factory instead of `routes`:

```ts
// src/main.ts
import { defineApplication } from 'vue-ssr-lite'
import { createRouter } from 'vue-router'
import App from './App.vue'
import routes from './router/routes'

export default defineApplication({
  root: App,
  router: ({ history }) =>
    createRouter({
      history,
      routes,
      scrollBehavior: (to, from, savedPosition) => savedPosition || { top: 0 },
    }),
})
```

### Multiple Applications (Monorepo)

Run multiple independent applications (SSR or SPA) from one repository, automatically routed by domain or subdomain:

```ts
// ssr.config.ts
import { defineSsrConfig } from 'vue-ssr-lite/server'

export default defineSsrConfig({
  applications: {
    website: {
      app: './src/website/main.ts',
      host: 'example.com',
      render: 'ssr',
    },
    admin: {
      app: './src/admin/main.ts',
      host: 'admin.example.com',
      render: 'spa', // Client-only SPA
    },
  },
})
```

---

## 📦 Package Exports

| Import | Exports |
| :--- | :--- |
| `vue-ssr-lite` | `defineApplication`, `useSeo`, `usePublicConfig`, `useSiteOrigin`, `setResponseStatus`, `defineExtension` |
| `vue-ssr-lite/vite` | `vueSsrLite` |
| `vue-ssr-lite/server` | `defineSsrConfig`, `useSsrDomain`, `useSsrRequestContext`, `defineSitemap` |

---

## License

[MIT](LICENSE) © [Safdar Azeem](https://github.com/safdar-azeem)
