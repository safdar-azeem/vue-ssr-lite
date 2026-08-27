# Proposed Route Rendering Contract

Global default:

```ts
render: 'ssr'
```

Per-route override:

```ts
{
  path: '/app',
  meta: {
    render: 'spa'
  }
}
```

Inheritance:

```text
nearest matched route with meta.render
        ↓
parent route meta.render
        ↓
global server render mode
```

Direct request behavior:

```text
GET /
  -> SSR render + hydration

GET /about
  -> SSR render + hydration

GET /app
  -> SPA document

GET /app/projects
  -> SPA document

GET /admin/users
  -> SPA document
```

Recommended navigation-boundary behavior:

When client-side navigation crosses between different render modes, the runtime should perform a full-document navigation by default.

Example:

```text
/app/projects (SPA) -> /about (SSR)
```

should load `/about` as a new document so the route actually receives SSR semantics.

Within the same rendering tree, normal Vue Router client navigation remains unchanged.
