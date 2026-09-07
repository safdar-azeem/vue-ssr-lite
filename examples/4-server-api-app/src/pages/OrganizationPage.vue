<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useFetch } from 'vue-ssr-lite'
import type { OrganizationProductResponse } from '../../shared/api'

const route = useRoute()
const organizationId = computed(() => String(route.params.organizationId))

const { data, pending, error, refresh } = useFetch<OrganizationProductResponse>(
  () => `/api/organizations/${organizationId.value}/products/1`,
  {
    fetchPolicy: 'network-only',
    nextFetchPolicy: 'cache-first',
  },
)
</script>

<template>
  <main>
    <section class="page-heading">
      <div>
        <p class="eyebrow">Prefix params + group middleware</p>
        <h1>Organization {{ organizationId }}</h1>
      </div>

      <button type="button" :disabled="pending" @click="refresh()">Refresh</button>
    </section>

    <section class="panel">
      <p>This page requests <code>/api/organizations/{{ organizationId }}/products/1</code>.</p>

      <p v-if="pending">Loading organization data…</p>
      <p v-if="error" class="error">
        Request failed<span v-if="error.status"> (HTTP {{ error.status }})</span>.
      </p>

      <template v-if="data">
        <dl>
          <dt>Organization</dt>
          <dd>{{ data.organization.name }}</dd>
          <dt>Product</dt>
          <dd>{{ data.product.title }}</dd>
          <dt>Viewer</dt>
          <dd>{{ data.viewer.name }}</dd>
        </dl>
      </template>
    </section>

    <section class="panel">
      <h2>What happens</h2>
      <ol>
        <li><code>authMiddleware</code> provides <code>context.user</code>.</li>
        <li><code>organizationMiddleware</code> requires <code>params.organizationId</code> and provides <code>context.organization</code>.</li>
        <li>The handler receives both prefix and child params: <code>organizationId</code> and <code>productId</code>.</li>
      </ol>
    </section>
  </main>
</template>
