<script setup lang="ts">
import { useFetch } from 'vue-ssr-lite'
import type { HealthResponse } from '../../shared/api'

const { data, pending, error, refresh } = useFetch<HealthResponse>('/api/health', {
  fetchPolicy: 'cache-first',
})
</script>

<template>
  <main>
    <section class="hero">
      <p class="eyebrow">Native Request + Response</p>
      <h1>Server routes, middleware, database code, and Vue data fetching.</h1>
      <p>
        This example keeps the Vue application normal while adding an application HTTP layer
        through <code>defineServerRoutes()</code> and <code>defineServerMiddleware()</code>.
      </p>
    </section>

    <section class="grid two">
      <article class="panel">
        <h2>Health route through useFetch</h2>

        <p v-if="pending">Loading <code>/api/health</code>…</p>
        <p v-else-if="error" class="error">
          Request failed<span v-if="error.status"> (HTTP {{ error.status }})</span>.
        </p>
        <template v-else-if="data">
          <p><strong>Status:</strong> {{ data.status }}</p>
          <p><strong>Request ID:</strong> <code>{{ data.requestId }}</code></p>
        </template>

        <button type="button" :disabled="pending" @click="refresh()">Refresh</button>
      </article>

      <article class="panel">
        <h2>Demo authentication</h2>
        <p>Protected example routes accept these fixture tokens:</p>
        <pre>Bearer member-token
Bearer admin-token</pre>
        <p class="muted">They are public demonstration values, not secrets.</p>
      </article>
    </section>

    <section class="panel">
      <h2>API surface</h2>
      <div class="route-list">
        <code>GET /api/health</code>
        <code>GET /api/products</code>
        <code>POST /api/products</code>
        <code>GET /api/products/:id</code>
        <code>PATCH /api/products/:id</code>
        <code>DELETE /api/products/:id</code>
        <code>GET /api/organizations/:organizationId/products/:productId</code>
      </div>
    </section>
  </main>
</template>
