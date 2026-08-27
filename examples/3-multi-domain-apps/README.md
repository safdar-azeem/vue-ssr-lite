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

No application has its own port.
