#!/usr/bin/env node
/**
 * Servidor MCP (stdio, JSON-RPC 2.0, sin dependencias) que Claude Code lanza en Termux. Los
 * proyectos viven en la app de Android, no en Termux: cada herramienta viaja por el puente
 * (bridge.mjs) hasta la app, que la ejecuta y devuelve el resultado.
 */
import net from 'node:net'
import readline from 'node:readline'

const { OA_PORT, OA_PROC, OA_KEY } = process.env
const out = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')

// ── conexión con el puente ──────────────────────────────────────────────────────
const waiting = new Map()
let seq = 0, down = false
const sock = net.connect(+OA_PORT || 47821, '127.0.0.1')
sock.setNoDelay(true)
sock.on('connect', () => sock.write(JSON.stringify({ t: 'mcp', proc: OA_PROC, key: OA_KEY }) + '\n'))
readline.createInterface({ input: sock, crlfDelay: Infinity }).on('line', (line) => {
  let m
  try { m = JSON.parse(line) } catch { return }
  const w = waiting.get(m.id)
  if (w) { waiting.delete(m.id); w(m) }
})
const fail = () => {
  down = true
  for (const [id, w] of waiting) { waiting.delete(id); w({ error: 'Se cortó la conexión con OpenAnimator.' }) }
}
sock.on('error', fail)
sock.on('close', fail)
function ask(msg) {
  if (down) return Promise.resolve({ error: 'Se cortó la conexión con OpenAnimator.' })
  return new Promise((resolve) => {
    const id = ++seq
    waiting.set(id, resolve)
    sock.write(JSON.stringify({ ...msg, id }) + '\n')
  })
}

// ── MCP ─────────────────────────────────────────────────────────────────────────
readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', async (line) => {
  line = line.trim()
  if (!line) return
  let msg
  try { msg = JSON.parse(line) } catch { return }
  const { id, method, params } = msg
  if (id === undefined || id === null) return // notificación
  try {
    if (method === 'initialize') {
      out({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'openanimator', version: '1' } } })
    } else if (method === 'tools/list') {
      const r = await ask({ t: 'tools' })
      out({ jsonrpc: '2.0', id, result: { tools: r.tools || [] } })
    } else if (method === 'tools/call') {
      const r = await ask({ t: 'call', name: params?.name, arguments: params?.arguments || {} })
      if (r.error) out({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Error: ' + r.error }], isError: true } })
      else out({ jsonrpc: '2.0', id, result: { content: r.content || [], isError: !!r.isError } })
    } else if (method === 'ping') {
      out({ jsonrpc: '2.0', id, result: {} })
    } else {
      out({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Método no soportado: ' + method } })
    }
  } catch (e) {
    out({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e?.message || e) } })
  }
})
process.stdin.on('end', () => { sock.end(); process.exit(0) })
