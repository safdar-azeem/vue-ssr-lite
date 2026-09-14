<script setup lang="ts">
import { LoadingIndicator, RouterView } from 'vue-ssr-lite'
import PageSkeleton from './PageSkeleton.vue'
</script>

<template>
  <LoadingIndicator :delay="10" />

  <div class="application-layout">
    <aside class="persistent-sidebar">Sidebar</aside>

    <section>
      <header class="persistent-header">
        <RouterLink class="home-link" to="/">Home</RouterLink>
        <RouterLink class="about-link" to="/about">About</RouterLink>
        <RouterLink class="products-link" to="/products">Products</RouterLink>
        <RouterLink class="product-details-link" to="/products#details">
          Product Details
        </RouterLink>
        <RouterLink class="dashboard-link" to="/dashboard">Dashboard</RouterLink>
        <RouterLink class="settings-link" to="/settings">Settings</RouterLink>
        <RouterLink class="cancelled-link" to="/cancelled">Cancelled</RouterLink>
      </header>

      <main class="route-content">
        <RouterView :delay="10">
          <template #fallback>
            <PageSkeleton />
          </template>
        </RouterView>
      </main>
    </section>
  </div>
</template>
