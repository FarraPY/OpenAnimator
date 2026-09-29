import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

/**
 * Interfaz para la app de Android (android/build/www). La arma android/scripts/build-web.mjs,
 * que además copia app/ (plantillas, runtime, guías de la IA) y el rasterizador.
 */
const PROJECT_ORIGIN = process.env.OA_PROJECT_ORIGIN || 'https://oaproject.androidplatform.net'

export default defineConfig({
  root: path.resolve(__dirname, 'android/web'),
  publicDir: false,
  plugins: [
    react(),
    { name: 'oa-project-origin', transformIndexHtml: (html) => html.replaceAll('__PROJECT_ORIGIN__', PROJECT_ORIGIN) },
  ],
  base: '/',
  resolve: { alias: { '/src': path.resolve(__dirname, 'src') } },
  build: {
    outDir: path.resolve(__dirname, 'android/build/www'),
    emptyOutDir: true,
    target: 'chrome100',
    chunkSizeWarningLimit: 4000,
    sourcemap: false,
  },
})
