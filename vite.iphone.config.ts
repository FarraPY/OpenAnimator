import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

/**
 * Interfaz para el iPhone (dist-iphone/): una app web que se instala desde Safari. La arma scripts/build-iphone.mjs,
 * que además copia app/ (plantillas, runtime, guías de la IA), el rasterizador, el Service Worker y los Workers de
 * Claude Code. Rutas relativas: la app puede vivir en una subcarpeta (GitHub Pages).
 */
export default defineConfig({
  root: path.resolve(__dirname, 'src/iphone'),
  publicDir: false,
  plugins: [react()],
  base: './',
  build: {
    outDir: path.resolve(__dirname, 'dist-iphone'),
    emptyOutDir: true,
    target: 'safari17',
    chunkSizeWarningLimit: 4000,
    sourcemap: false,
  },
})
