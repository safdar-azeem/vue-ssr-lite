# Simple Single Application

Target developer experience:

- `server.ts` is the only server configuration file.
- `/src/main.ts` and `/src/App.vue` are used automatically.
- No `defineApplication()` is required.
- Pinia is installed per app/request.
- Routes live in `src/routes.ts`.
- SEO precedence remains:
  1. global/site SEO
  2. route SEO
  3. dynamic/component `useSeo()`
- Sitemap and robots are global because there is only one application.
