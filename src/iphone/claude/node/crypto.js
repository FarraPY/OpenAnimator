// crypto de Node: hashes y HMAC sincrónicos (@noble/hashes), aleatorios y webcrypto del navegador.
import { Buffer } from 'buffer'
import { sha224, sha256, sha384, sha512 } from '@noble/hashes/sha2.js'
import { md5, sha1, ripemd160 } from '@noble/hashes/legacy.js'
import { sha3_256, sha3_512 } from '@noble/hashes/sha3.js'
import { hmac } from '@noble/hashes/hmac.js'
import { pbkdf2 as nPbkdf2 } from '@noble/hashes/pbkdf2.js'
import { scrypt as nScrypt } from '@noble/hashes/scrypt.js'

const ALGOS = { sha1, sha224, sha256, sha384, sha512, md5, ripemd160, rmd160: ripemd160, 'sha3-256': sha3_256, 'sha3-512': sha3_512, 'sha-256': sha256, 'sha-1': sha1, 'sha-512': sha512 }
const algo = (name) => {
  const h = ALGOS[String(name).toLowerCase()]
  if (!h) throw Object.assign(new Error(`Digest method not supported: ${name}`), { code: 'ERR_CRYPTO_INVALID_DIGEST' })
  return h
}
const bytes = (data, enc) => (typeof data === 'string' ? Buffer.from(data, enc || 'utf8') : data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : Buffer.from(data))
const out = (u8, enc) => { const b = Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength); return enc && enc !== 'buffer' ? b.toString(enc) : b }

class Hash {
  constructor(h, inner) { this._h = h; this._inner = inner || h.create() }
  update(data, enc) { this._inner.update(bytes(data, enc)); return this }
  digest(enc) { return out(this._inner.digest(), enc) }
  copy() { return new Hash(this._h, this._inner.clone()) }
}
class Hmac {
  constructor(h, key) { this._inner = hmac.create(h, bytes(key)) }
  update(data, enc) { this._inner.update(bytes(data, enc)); return this }
  digest(enc) { return out(this._inner.digest(), enc) }
}
export const createHash = (name) => new Hash(algo(name))
export const createHmac = (name, key) => new Hmac(algo(name), key)
export const hash = (name, data, enc = 'hex') => out(algo(name)(bytes(data)), enc)
export const getHashes = () => Object.keys(ALGOS)
export const getCiphers = () => []
export const getCurves = () => []

export const getRandomValues = (a) => globalThis.crypto.getRandomValues(a)
export const randomUUID = () => globalThis.crypto.randomUUID()
export const randomFillSync = (buf, off = 0, size) => { const u = new Uint8Array(buf.buffer || buf, (buf.byteOffset || 0) + off, size ?? (buf.byteLength - off)); for (let i = 0; i < u.length; i += 65536) globalThis.crypto.getRandomValues(u.subarray(i, i + 65536)); return buf }
export const randomFill = (buf, off, size, cb) => { cb = [off, size, cb].find((x) => typeof x === 'function'); try { randomFillSync(buf, typeof off === 'number' ? off : 0, typeof size === 'number' ? size : undefined); cb(null, buf) } catch (e) { cb(e) } }
export function randomBytes(n, cb) {
  const b = Buffer.alloc(n)
  randomFillSync(b)
  if (cb) { queueMicrotask(() => cb(null, b)); return }
  return b
}
export const pseudoRandomBytes = randomBytes
export function randomInt(min, max, cb) {
  if (max === undefined || typeof max === 'function') { cb = max; max = min; min = 0 }
  const range = max - min
  const v = min + Math.floor((globalThis.crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32) * range)
  if (cb) { queueMicrotask(() => cb(null, v)); return }
  return v
}
export function timingSafeEqual(a, b) {
  if (a.byteLength !== b.byteLength) throw Object.assign(new RangeError('Input buffers must have the same byte length'), { code: 'ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH' })
  const x = bytes(a), y = bytes(b)
  let d = 0
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i]
  return d === 0
}
export const pbkdf2Sync = (pw, salt, iter, len, digest) => out(nPbkdf2(algo(digest || 'sha1'), bytes(pw), bytes(salt), { c: iter, dkLen: len }))
export const pbkdf2 = (pw, salt, iter, len, digest, cb) => { try { cb(null, pbkdf2Sync(pw, salt, iter, len, digest)) } catch (e) { cb(e) } }
export const scryptSync = (pw, salt, len, o = {}) => out(nScrypt(bytes(pw), bytes(salt), { N: o.N || o.cost || 16384, r: o.r || o.blockSize || 8, p: o.p || o.parallelization || 1, dkLen: len }))
export const scrypt = (pw, salt, len, o, cb) => { if (typeof o === 'function') { cb = o; o = {} } try { cb(null, scryptSync(pw, salt, len, o)) } catch (e) { cb(e) } }

export const webcrypto = globalThis.crypto
export const subtle = globalThis.crypto.subtle
export const constants = {}
export class KeyObject { constructor(type) { this.type = type } export() { throw new Error('KeyObject no disponible') } }
export class X509Certificate { constructor() { throw new Error('X509Certificate no disponible en el iPhone') } }
export default { createHash, createHmac, hash, getHashes, getCiphers, getCurves, getRandomValues, randomUUID, randomBytes, pseudoRandomBytes, randomFillSync, randomFill, randomInt, timingSafeEqual, pbkdf2Sync, pbkdf2, scryptSync, scrypt, webcrypto, subtle, constants, KeyObject, X509Certificate }
