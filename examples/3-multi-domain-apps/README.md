# Multi-App / Different Subdomains

Three applications share one global server and one global port.

- `website`
  - SSR
  - `*.localhost` / `*.example.com`
  - global `/src/main.ts`
  - global `/src/App.vue`
  - its own routes + SEO + sitemap + robots

- `admin`
  - SPA
  - `admin.localhost` / `admin.example.com`
  - global `/src/main.ts`
  - global `/src/App.vue`
  - its own routes + SEO

- `docs`
  - SSR
  - `docs.localhost` / `docs.example.com`
  - its own `/src/modules/docs/main.ts`
  - its own `/src/modules/docs/App.vue`
  - its own routes + SEO + sitemap + robots

No application has its own port. Applications are registered explicitly:

```ts
export default defineServer({
  server: { port: 4211 },
  applications: [website, admin, docs],
})
```

Core selects the application from the normalized request hostname. The same
request domain supplies each SSR application's default `siteOrigin`, including
custom domains; fixed `PUBLIC_URL` configuration is not required.
