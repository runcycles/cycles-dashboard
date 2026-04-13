import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import sri from 'vite-plugin-sri-gen'
import { readFileSync } from 'fs'

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'))

export default defineConfig({
  plugins: [vue(), tailwindcss(), sri()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    proxy: {
      // Runtime-plane endpoints go to cycles-server (7878).
      // Order matters: more-specific pattern first.
      '/v1/reservations': {
        target: 'http://localhost:7878',
        changeOrigin: true,
      },
      '/v1': {
        target: 'http://localhost:7979',
        changeOrigin: true,
      },
    },
  },
})
