import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { vueSsrLite } from '../../src/vite/SsrVitePlugin'

export default defineConfig({
  plugins: [vueSsrLite(), vue()],
})
