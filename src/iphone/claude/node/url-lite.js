// "url" para las librerías del paquete (memfs): URL del navegador + fileURLToPath/pathToFileURL POSIX.
export const URL = globalThis.URL
export const URLSearchParams = globalThis.URLSearchParams
export const fileURLToPath = (u) => decodeURIComponent((typeof u === 'string' ? new URL(u) : u).pathname)
export const pathToFileURL = (p) => new URL('file://' + String(p).split('/').map(encodeURIComponent).join('/'))
export default { URL, URLSearchParams, fileURLToPath, pathToFileURL }
