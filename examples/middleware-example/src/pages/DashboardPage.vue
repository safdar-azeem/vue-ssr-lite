<script setup lang="ts">
import { useRouter } from 'vue-router'
import { logout } from '../auth'

defineProps<{
  userName: string
  role: string
}>()

const router = useRouter()

const signOut = async () => {
  logout()
  await router.push('/')
}
</script>

<template>
  <section class="page">
    <p class="eyebrow">Protected route</p>
    <h2>Dashboard</h2>
    <p>This page is protected by <code>authMiddleware</code>.</p>

    <dl class="details">
      <div>
        <dt>User</dt>
        <dd>{{ userName }}</dd>
      </div>
      <div>
        <dt>Role</dt>
        <dd>{{ role }}</dd>
      </div>
    </dl>

    <div class="actions">
      <RouterLink to="/dashboard/nested">Open nested route</RouterLink>
      <button type="button" @click="signOut">Logout</button>
    </div>

    <RouterView />
  </section>
</template>
