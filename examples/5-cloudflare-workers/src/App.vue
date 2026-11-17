<script setup lang="ts">
import { RouterView } from 'vue-ssr-lite'
</script>

<template>
  <header class="top">
    <img src="/logo.svg" alt="" width="32" height="32" />
    <nav>
      <RouterLink to="/">Home</RouterLink>
      <RouterLink to="/posts/hello-workers">Post</RouterLink>
      <RouterLink to="/dashboard">Dashboard (SPA)</RouterLink>
      <RouterLink to="/dashboard/settings">Settings (SPA)</RouterLink>
    </nav>
  </header>
  <main>
    <RouterView />
  </main>
</template>
