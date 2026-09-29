/**
 * Claves de API de los plugins (OpenAI, ElevenLabs, Fish Audio…).
 * Se guardan en data/secrets.json cifradas con el almacén del sistema (DPAPI en Windows vía safeStorage):
 * nunca en texto plano si el sistema lo permite, nunca en settings.json y nunca se mandan a la interfaz.
 * Nota: DPAPI ata el cifrado al usuario de Windows; si se copia la carpeta data/ a otra PC hay que volver a cargarlas.
 */
import fs from 'node:fs'
import path from 'node:path'
import { safeStorage } from 'electron'
import { DATA_DIR } from './paths'
import { atomicWrite } from './projects'

const FILE = () => path.join(DATA_DIR, 'secrets.json')
type Store = Record<string, { v: string; enc: boolean }>

function load(): Store {
  try { return JSON.parse(fs.readFileSync(FILE(), 'utf8')) } catch { return {} }
}
function save(s: Store) { atomicWrite(FILE(), JSON.stringify(s, null, 1)) }

export function setSecret(key: string, value: string) {
  const s = load()
  const v = value.trim()
  if (!v) delete s[key]
  else if (safeStorage.isEncryptionAvailable()) s[key] = { v: safeStorage.encryptString(v).toString('base64'), enc: true }
  else s[key] = { v: Buffer.from(v).toString('base64'), enc: false }
  save(s)
}

export function getSecret(key: string): string {
  const e = load()[key]
  if (!e) return ''
  try { return e.enc ? safeStorage.decryptString(Buffer.from(e.v, 'base64')) : Buffer.from(e.v, 'base64').toString('utf8') } catch { return '' }
}

export const hasSecret = (key: string) => !!getSecret(key)

/** Versión enmascarada para mostrar en la interfaz ("sk-…a1B2"). */
export function maskedSecret(key: string) {
  const v = getSecret(key)
  return v ? `${v.slice(0, 3)}…${v.slice(-4)}` : ''
}
