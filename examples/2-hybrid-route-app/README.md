# Single Domain / Route-Level Rendering

One application. One domain. One global server. One global port.

Example:

```text
example.com/                 -> SSR
example.com/about            -> SSR
example.com/pricing          -> SSR

example.com/app              -> SPA
example.com/app/projects     -> SPA
example.com/app/settings     -> SPA

example.com/admin            -> SPA
example.com/admin/users      -> SPA
example.com/admin/settings   -> SPA
```

The global/default render mode is SSR.

A route tree can override it with:

```ts
meta: {
  render: 'spa'
}
```

Child routes inherit the nearest parent render mode.

SEO precedence remains:

1. global/site SEO
2. route SEO
3. dynamic/component `useSeo()`

This keeps the application module-based without creating separate application definitions merely to change rendering by URL.
