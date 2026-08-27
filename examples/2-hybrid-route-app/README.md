# Single Domain / Route-Level Rendering

One application. One domain. One global server. One global port.

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

The global render mode is SSR. A route tree overrides it with:

```ts
meta: {
  render: 'spa'
}
```

Child routes inherit the nearest parent render mode. Crossing SSR and SPA trees uses a full-document navigation. Navigation inside the same mode stays on Vue Router.

SEO precedence:

1. global/site SEO
2. route SEO
3. dynamic/component `useSeo()`

Automatic sitemap generation excludes private SPA branches such as `/app/**` and `/admin/**` unless those URLs are provided explicitly.
