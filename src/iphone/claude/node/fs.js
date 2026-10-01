// fs de Node sobre memfs (disco en memoria del Worker). Lo que se escribe se avisa (onChange) para guardarlo.
import { Volume, createFsFromVolume } from 'memfs'
import { Buffer } from 'buffer'
import { posix as path } from './path.js'

const MUTATING = /^(write|append|mkdir|mkdtemp|rm|rmdir|unlink|rename|copy|cp|truncate|ftruncate|symlink|link|utimes|lutimes|futimes|chmod|lchmod|fchmod|chown|lchown|fchown|close|fsync|fdatasync)/

export function createFs({ files = [], dirs = [], onChange = () => {} } = {}) {
  const vol = new Volume()
  for (const d of dirs) vol.mkdirSync(d, { recursive: true })
  for (const [f, data] of files) {
    vol.mkdirSync(path.dirname(f), { recursive: true })
    vol.writeFileSync(f, typeof data === 'string' ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength))
  }
  const base = createFsFromVolume(vol)
  const touched = (args) => { for (const a of args.slice(0, 2)) if (typeof a === 'string' || a instanceof URL) onChange(typeof a === 'string' ? a : a.pathname) }
  // Mutaciones con aviso: sincrónicas, con callback y promesas.
  const wrap = (obj, name) => {
    const fn = obj[name]
    if (typeof fn !== 'function' || !MUTATING.test(name)) return fn
    const w = function (...args) { const r = fn.apply(this, args); if (r && typeof r.then === 'function') return r.then((v) => { touched(args); return v }); touched(args); return r }
    return Object.assign(w, fn)
  }
  const fs = {}
  for (const k of Object.keys(base)) fs[k] = wrap(base, k)
  const promises = {}
  for (const k of Object.keys(base.promises)) promises[k] = wrap(base.promises, k)
  // Lo que memfs no trae (o trae distinto) y Node sí.
  promises.constants = fs.constants
  fs.promises = promises
  fs.realpathSync.native = fs.realpathSync
  if (fs.realpath) fs.realpath.native = fs.realpath
  const statfs = { type: 0x858458f6, bsize: 4096, blocks: 1e7, bfree: 5e6, bavail: 5e6, files: 1e6, ffree: 9e5 }
  fs.statfsSync = () => ({ ...statfs })
  fs.statfs = (p, o, cb) => (cb || o)(null, { ...statfs })
  promises.statfs = async () => ({ ...statfs })
  if (!fs.cpSync) {
    fs.cpSync = (src, dst, o = {}) => {
      const st = fs.statSync(src)
      if (st.isDirectory()) { fs.mkdirSync(dst, { recursive: true }); for (const e of fs.readdirSync(src)) fs.cpSync(path.join(src, e), path.join(dst, e), o) } else fs.copyFileSync(src, dst)
      onChange(dst)
    }
    fs.cp = (s, d, o, cb) => { if (typeof o === 'function') { cb = o; o = {} } try { fs.cpSync(s, d, o); cb?.(null) } catch (e) { cb?.(e) } }
    promises.cp = async (s, d, o) => fs.cpSync(s, d, o)
  }
  fs.openAsBlob = async (p) => new Blob([fs.readFileSync(p)])
  return { fs, vol }
}
