import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const backend = 'http://localhost:3000'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: backend,
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (_proxyReq, req) => console.log('[vite →]', req.method, req.url))
          proxy.on('proxyRes', (res, req) => console.log('[vite ←]', res.statusCode, req.method, req.url))
        }
      },
      '/health': { target: backend, changeOrigin: true },
      '/files':  { target: backend, changeOrigin: true },
    }
  }
})
