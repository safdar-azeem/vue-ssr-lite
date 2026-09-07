<script setup lang="ts">
import { ref } from 'vue'
import { useFetch } from 'vue-ssr-lite'
import { memberHeaders } from '../demoAuth'
import type { ProductsResponse } from '../../shared/api'

const search = ref('')

const { data, pending, error, refresh } = useFetch<
  ProductsResponse,
  { search?: string }
>('/api/products', {
  headers: memberHeaders,
  variables: () => ({
    search: search.value.trim() || undefined,
  }),
  fetchPolicy: 'network-only',
  nextFetchPolicy: 'cache-first',
})

const title = ref('Desk clock')
const description = ref('A small clock created from the browser with native fetch().')
const price = ref('24')
const mutationPending = ref(false)
const mutationMessage = ref('')

const createProduct = async () => {
  mutationMessage.value = ''
  const priceInput = price.value.trim()
  const parsedPrice = Number(priceInput)

  if (priceInput === '' || !Number.isFinite(parsedPrice) || parsedPrice < 0) {
    mutationMessage.value = 'Enter a valid non-negative price.'
    return
  }

  mutationPending.value = true

  try {
    const response = await fetch('/api/products', {
      method: 'POST',
      headers: {
        ...memberHeaders,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        title: title.value,
        description: description.value,
        price: parsedPrice,
      }),
    })

    const body = await response.json() as {
      product?: { title: string }
      error?: string
    }

    if (!response.ok) {
      mutationMessage.value = body.error ?? `Create failed with HTTP ${response.status}.`
      return
    }

    mutationMessage.value = `Created "${body.product?.title ?? title.value}".`
    await refresh()
  } catch {
    mutationMessage.value = 'Create request failed.'
  } finally {
    mutationPending.value = false
  }
}
</script>

<template>
  <main>
    <section class="page-heading">
      <div>
        <p class="eyebrow">GET /api/products</p>
        <h1>Products</h1>
        <p>
          This list is read with SSR-aware <code>useFetch()</code>. Search is sent as a
          normal query parameter through <code>variables</code>.
        </p>
      </div>

      <button type="button" :disabled="pending" @click="refresh()">Refresh</button>
    </section>

    <section class="panel">
      <label>
        Search
        <input v-model="search" type="search" placeholder="Notebook…" />
      </label>

      <p v-if="pending" class="muted">Loading products…</p>
      <p v-if="error" class="error">
        Unable to load products<span v-if="error.status"> (HTTP {{ error.status }})</span>.
      </p>

      <div v-if="data" class="product-list" :aria-busy="pending">
        <RouterLink
          v-for="product in data.products"
          :key="product.id"
          :to="`/products/${product.id}`"
          class="product-row"
        >
          <span>
            <strong>{{ product.title }}</strong>
            <small>{{ product.description }}</small>
          </span>
          <strong>${{ product.price.toFixed(2) }}</strong>
        </RouterLink>

        <p v-if="data.products.length === 0" class="muted">No matching products.</p>
      </div>

      <p v-if="data" class="muted">Viewer: {{ data.viewer.name }} · {{ data.viewer.role }}</p>
    </section>

    <section class="panel">
      <p class="eyebrow">POST /api/products</p>
      <h2>Create with native fetch()</h2>
      <p><code>useFetch()</code> handles GET/HEAD data. Mutations use the native Fetch API.</p>

      <div class="form-grid">
        <label>
          Title
          <input v-model="title" />
        </label>

        <label>
          Price
          <input v-model="price" type="text" inputmode="decimal" />
        </label>

        <label class="full">
          Description
          <textarea v-model="description" rows="3" />
        </label>
      </div>

      <button type="button" :disabled="mutationPending" @click="createProduct">
        {{ mutationPending ? 'Creating…' : 'Create product' }}
      </button>

      <p v-if="mutationMessage" class="muted">{{ mutationMessage }}</p>
    </section>
  </main>
</template>
