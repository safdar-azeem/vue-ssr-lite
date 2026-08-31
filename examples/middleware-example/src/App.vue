<script setup lang="ts">
import { LoadingIndicator, RouteSuspense } from 'vue-ssr-lite'
</script>

<template>
  <LoadingIndicator />

  <div class="app-shell layout">
    <aside class="sidebar">
      <div>
        <p class="eyebrow">vue-ssr-lite</p>
        <strong>Navigation demo</strong>
      </div>

      <nav>
        <RouterLink to="/">Home</RouterLink>
        <RouterLink to="/about">About</RouterLink>
        <RouterLink to="/dashboard">Dashboard</RouterLink>
      </nav>
    </aside>

    <section class="layout-content">
      <header class="app-header">
        <div>
          <p class="eyebrow">Persistent header</p>
          <h1>Middleware Example</h1>
        </div>
        <span class="header-status">The sidebar and header stay mounted</span>
      </header>

      <main>
        <RouteSuspense :delay="120">
          <RouterView />

          <template #fallback>
            <div class="page-skeleton">
              <span class="skeleton-line skeleton-line-short" />
              <span class="skeleton-line" />
              <span class="skeleton-line" />
              <strong>Loading route middleware…</strong>
            </div>
          </template>
        </RouteSuspense>
      </main>
    </section>
  </div>
</template>
