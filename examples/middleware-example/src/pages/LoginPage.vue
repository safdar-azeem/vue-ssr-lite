<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router'
import { login } from '../auth'

const route = useRoute()
const router = useRouter()

const signIn = async () => {
  login()

  const redirect = typeof route.query.redirect === 'string'
    ? route.query.redirect
    : '/dashboard'

  await router.push(redirect)
}
</script>

<template>
  <section class="page">
    <p class="eyebrow">Demo session</p>
    <h2>Login</h2>
    <p>
      This fake login writes a normal cookie so the next direct SSR request can
      observe the same session as browser middleware.
    </p>

    <button type="button" @click="signIn">Login</button>
  </section>
</template>
