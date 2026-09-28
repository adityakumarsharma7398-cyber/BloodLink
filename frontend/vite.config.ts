import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

// The whole monorepo shares one root-level .env; only VITE_* variables reach the browser.
const envDir = path.resolve(import.meta.dirname, '..');

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, envDir, '');
  const backendPort = env.BACKEND_PORT || '4000';

  return {
    envDir,
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: { '@': path.resolve(import.meta.dirname, './src') },
    },
    server: {
      port: 5173,
      proxy: {
        '/api': { target: `http://localhost:${backendPort}`, changeOrigin: true },
      },
    },
  };
});
