<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useFetch } from 'vue-ssr-lite'
import { adminHeaders, memberHeaders } from '../demoAuth'
import type { ProductResponse } from '../../shared/api'

const route = useRoute()
const router = useRouter()
const id = computed(() => String(route.params.id))

const { data, pending, error, refresh } = useFetch<ProductResponse>(
  () => `/api/products/${id.value}`,
  {
    fetchPolicy: 'network-only',
    nextFetchPolicy: 'cache-first',
  },
)

const title = ref('')
const price = ref('')
const actionPending = ref(false)
const actionMessage = ref('')

const updateProduct = async () => {
  const patch: Record<string, unknown> = {}

  if (title.value.trim()) patch.title = title.value.trim()
  const priceInput = price.value.trim()
  if (priceInput !== '') {
    const parsedPrice = Number(priceInput)
    if (!Number.isFinite(parsedPrice) || parsedPrice < 0) {
      actionMessage.value = 'Enter a valid non-negative price, or leave it blank.'
      return
    }
    patch.price = parsedPrice
  }

  if (Object.keys(patch).length === 0) {
    actionMessage.value = 'Enter a new title or price first.'
    return
  }

  actionPending.value = true
  actionMessage.value = ''

  try {
    const response = await fetch(`/api/products/${id.value}`, {
      method: 'PATCH',
      headers: {
        ...memberHeaders,
        'content-type': 'application/json',
      },
      body: JSON.stringify(patch),
    })

    const body = await response.json() as { error?: string }

    if (!response.ok) {
      actionMessage.value = body.error ?? `Update failed with HTTP ${response.status}.`
      return
    }

    title.value = ''
    price.value = ''
    actionMessage.value = 'Product updated.'
    await refresh()
  } catch {
    actionMessage.value = 'Update request failed.'
  } finally {
    actionPending.value = false
  }
}

const deleteProduct = async () => {
  actionPending.value = true
  actionMessage.value = ''

  try {
    const response = await fetch(`/api/products/${id.value}`, {
      method: 'DELETE',
      headers: adminHeaders,
    })

    const body = await response.json() as { error?: string }

    if (!response.ok) {
      actionMessage.value = body.error ?? `Delete failed with HTTP ${response.status}.`
      return
    }

    await router.push('/products')
  } catch {
    actionMessage.value = 'Delete request failed.'
  } finally {
    actionPending.value = false
  }
}
</script>

<template>
  <main>
    <section class="page-heading">
      <div>
        <p class="eyebrow">GET /api/products/:id</p>
        <h1>Product #{{ id }}</h1>
      </div>

      <button type="button" :disabled="pending" @click="refresh()">Refresh</button>
    </section>

    <section class="panel">
      <p v-if="pending">Loading product…</p>
      <p v-if="error" class="error">
        Unable to load product<span v-if="error.status"> (HTTP {{ error.status }})</span>.
      </p>

      <template v-if="data">
        <h2>{{ data.product.title }}</h2>
        <p>{{ data.product.description }}</p>
        <p><strong>${{ data.product.price.toFixed(2) }}</strong></p>
      </template>
    </section>

    <section class="grid two">
      <article class="panel">
        <p class="eyebrow">PATCH /api/products/:id</p>
        <h2>Path middleware + native fetch()</h2>
        <p>Authentication runs at group scope. Product lookup runs once at path scope.</p>

        <label>
          New title
          <input v-model="title" placeholder="Leave blank to keep current title" />
        </label>

        <label>
          New price
          <input v-model="price" type="text" inputmode="decimal" placeholder="Leave blank to keep current price" />
        </label>

        <button type="button" :disabled="actionPending" @click="updateProduct">Update as member</button>
      </article>

      <article class="panel danger-panel">
        <p class="eyebrow">DELETE /api/products/:id</p>
        <h2>Method middleware</h2>
        <p>DELETE adds <code>adminMiddleware</code> after the group and path middleware.</p>

        <button type="button" class="danger" :disabled="actionPending" @click="deleteProduct">Delete as admin</button>
      </article>
    </section>

    <p v-if="actionMessage" class="panel muted">{{ actionMessage }}</p>
  </main>
</template>
