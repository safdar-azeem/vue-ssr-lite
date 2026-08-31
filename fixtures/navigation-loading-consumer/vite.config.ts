import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'
import { vueSsrLite } from 'vue-ssr-lite/vite'

export default defineConfig({
  plugins: [vueSsrLite(), vue()],
})
