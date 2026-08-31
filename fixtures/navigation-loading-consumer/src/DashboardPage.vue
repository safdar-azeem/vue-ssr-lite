<script setup lang="ts">
defineProps<{
  userName: string
  role: string
  authRuns: number
}>()
</script>

<template>
  <article class="dashboard-page" :data-auth-runs="authRuns">
    <p>Dashboard page for {{ userName }} ({{ role }})</p>
    <RouterLink class="dashboard-nested-link" to="/dashboard/nested">
      Dashboard nested
    </RouterLink>
    <RouterView />
  </article>
</template>
