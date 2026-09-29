// Compila el proceso principal y el preload de Electron (TypeScript → CommonJS) con esbuild.
import { build } from 'esbuild'

const common = { bundle: true, platform: 'node', format: 'cjs', target: 'node22', sourcemap: true, external: ['electron'], logLevel: 'info' }
await build({ ...common, entryPoints: ['electron/main.ts'], outfile: 'dist-electron/main.js' })
await build({ ...common, entryPoints: ['electron/preload.ts'], outfile: 'dist-electron/preload.js' })
