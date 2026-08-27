# Route Rendering Contract

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
global application render mode
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

When client-side navigation crosses render modes, Core performs a full-document navigation.

Example:

```text
/app/projects (SPA) -> /about (SSR)
```

loads `/about` as a new document so the route receives SSR semantics.

Within the same rendering tree, ordinary Vue Router navigation is unchanged.
