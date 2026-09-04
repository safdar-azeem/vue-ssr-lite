<script setup>
import { RouteSuspense } from 'vue-ssr-lite'
</script>

<template>
  <div class="shell">
    <nav>
      <RouterLink to="/">Home</RouterLink>
      <RouterLink to="/about">About</RouterLink>
      <RouterLink to="/posts/hello-world">Dynamic Post</RouterLink>
      <RouterLink to="/products">Products</RouterLink>
    </nav>

    <RouteSuspense>
      <RouterView />

      <template #fallback>
        <p>Loading page…</p>
      </template>
    </RouteSuspense>
  </div>
</template>
