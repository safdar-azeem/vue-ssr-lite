<script setup lang="ts">
import { RouterView } from 'vue-ssr-lite'
</script>

<template>
  <div class="shell">
    <header class="site-header">
      <div>
        <p class="eyebrow">vue-ssr-lite example</p>
        <strong>Server API Application</strong>
      </div>

      <nav>
        <RouterLink to="/">Overview</RouterLink>
        <RouterLink to="/products">Products</RouterLink>
        <RouterLink to="/products/1">Product #1</RouterLink>
        <RouterLink to="/organizations/org_1">Organization</RouterLink>
      </nav>
    </header>

    <RouterView>
      <template #fallback>
        <main class="panel">
          <p>Loading page…</p>
        </main>
      </template>
    </RouterView>
  </div>
</template>
