/**
 * Claves en el iPhone (el token de Claude Code, claves de plugins): cifradas con AES-GCM en la carpeta de datos. La llave
 * es de WebCrypto, no exportable, y vive en IndexedDB: el archivo solo no sirve de nada. En memoria se tienen
 * descifradas (el puente las pide de forma sincrónica) y nunca se muestran enteras.
 */
import type { WebFS } from './webfs'

const FILE = '.secrets'

function idbKey(): Promise<CryptoKey> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('oa-keys', 1)
    open.onupgradeneeded = () => open.result.createObjectStore('k')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      const get = db.transaction('k').objectStore('k').get('secrets')
      get.onerror = () => reject(get.error)
      get.onsuccess = async () => {
        if (get.result) { resolve(get.result); return }
        try {
          const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
          const put = db.transaction('k', 'readwrite').objectStore('k').put(key, 'secrets')
          put.onsuccess = () => resolve(key)
          put.onerror = () => reject(put.error)
        } catch (e) { reject(e) }
      }
    }
  })
}

export class Secrets {
  private map = new Map<string, string>()
  private key: CryptoKey | null = null
  constructor(private fs: WebFS) {}

  async load() {
    this.key = await idbKey()
    if (!this.fs.exists(FILE)) return
    try {
      const raw = this.fs.readBytesSync(FILE)
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, this.key, raw.slice(12))
      for (const [k, v] of Object.entries(JSON.parse(new TextDecoder().decode(plain)))) this.map.set(k, String(v))
    } catch (e) { console.error('No se pudieron leer las claves guardadas', e) }
  }
  private async save() {
    if (!this.key) return
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this.key, new TextEncoder().encode(JSON.stringify(Object.fromEntries(this.map)))))
    const out = new Uint8Array(12 + data.length)
    out.set(iv); out.set(data, 12)
    this.fs.writeBytes(FILE, out)
  }
  get(name: string) { return this.map.get(name) || '' }
  set(name: string, value: string) {
    if (value) this.map.set(name, value); else this.map.delete(name)
    void this.save()
  }
  masked(name: string) { const v = this.map.get(name); return v ? `${v.slice(0, 7)}…${v.slice(-4)}` : '' }
  names() { return [...this.map.keys()] }
}
