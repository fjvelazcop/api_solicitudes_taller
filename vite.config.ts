import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
<<<<<<< HEAD
      host: '0.0.0.0',
      port: 4173,
      strictPort: true,
      hmr: {
        host: 'localhost',
        port: 24760,
      },
=======
      // Puerto del frontend (Vite dev server) - debe coincidir con package.json y server.ts.
      port: Number(process.env.FRONTEND_PORT) || 4100,
      strictPort: true,
      host: '0.0.0.0',
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
>>>>>>> 6c08857 (feat: actualizar configuración de puertos y scripts de inicio para backend y frontend)
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
      proxy: {
        '/api': {
          target: `http://localhost:${Number(process.env.PORT) || 4000}`,
          changeOrigin: true,
        },
        '/uploads': {
          target: `http://localhost:${Number(process.env.PORT) || 4000}`,
          changeOrigin: true,
        },
      },
    },
    preview: {
      host: '0.0.0.0',
      port: 4173,
      strictPort: true,
    },
  };
});
