import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { vueSsrLite } from 'vue-ssr-lite/vite'

export default defineConfig({
  plugins: [vue(), vueSsrLite()],
})
