import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const backend = 'http://localhost:3000'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // API + health already working
      '/api':    { target: backend, changeOrigin: true },
      '/health': { target: backend, changeOrigin: true },

      // NEW: serve generated documents from backend
      '/files':  { target: backend, changeOrigin: true },
    }
  }
})
