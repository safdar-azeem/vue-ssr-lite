<script setup lang="ts">
import { RouterView } from 'vue-ssr-lite'
</script>

<template>
  <section class="dashboard">
    <h1 id="dashboard-title">Dashboard</h1>
    <nav>
      <RouterLink to="/dashboard">Overview</RouterLink>
      <RouterLink to="/dashboard/settings">Settings</RouterLink>
    </nav>
    <RouterView />
  </section>
</template>
