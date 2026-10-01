import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // react-draggable (used by react-grid-layout) reads process.env at runtime
  define: { 'process.env': {} },
  server: {
    port: 5173,
    proxy: {
      '/api': process.env.API_URL || 'http://localhost:8010',
      '/auth': 'http://localhost:3001',
    },
  },
});
