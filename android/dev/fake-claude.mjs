#!/usr/bin/env node
/**
 * Claude Code de mentira para probar el modo Termux en la PC (android/dev/server.mjs --termux-claude
 * fake). Habla el mismo protocolo que `claude -p --input-format stream-json --output-format
 * stream-json`: arranca el servidor MCP de --mcp-config (oa-mcp.mjs → puente → app), pide permiso
 * con control_request para lo que no está en --allowedTools y sigue un guion fijo (crea una escena, la
 * pone en el timeline y mira fotogramas). Guarda la conversación como .jsonl, igual que Claude Code.
 */
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'

const argv = process.argv.slice(2)
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined }
if (argv.includes('--version')) { console.log('9.9.9 (Claude Code de prueba)'); process.exit(0) }
if (argv[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' })); process.exit(0) }
if (argv.includes('--help')) { console.log('  --tools <tools...>  Specify the list of available tools'); process.exit(0) }

const mode = opt('--permission-mode') || 'default'
const allowed = new Set((opt('--allowedTools') || '').split(/[ ,]+/).filter(Boolean))
const session = opt('--resume') || crypto.randomUUID()
const model = opt('--model') || 'claude-opus-5-5'
const out = (o) => process.stdout.write(JSON.stringify({ ...o, session_id: session }) + '\n')
const log = []
const jsonl = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'), `${session}.jsonl`)
fs.mkdirSync(path.dirname(jsonl), { recursive: true })
const record = (o) => fs.appendFileSync(jsonl, JSON.stringify({ ...o, sessionId: session }) + '\n')

// ── cliente MCP ─────────────────────────────────────────────────────────────────
const cfg = JSON.parse(fs.readFileSync(opt('--mcp-config'), 'utf8')).mcpServers.openanimator
const mcp = spawn(cfg.command, cfg.args, { env: { ...process.env, ...cfg.env }, stdio: ['pipe', 'pipe', 'inherit'] })
const pending = new Map()
let rpc = 0
readline.createInterface({ input: mcp.stdout }).on('line', (l) => { const m = JSON.parse(l); pending.get(m.id)?.(m); pending.delete(m.id) })
const call = (method, params) => new Promise((res) => { const id = ++rpc; pending.set(id, res); mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n') })
await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-claude', version: '1' } })
const tools = (await call('tools/list', {})).result.tools.map((t) => `mcp__openanimator__${t.name}`)
out({ type: 'system', subtype: 'init', cwd: process.cwd(), tools, mcp_servers: [{ name: 'openanimator', status: 'connected' }], model, permissionMode: mode })

// ── permisos ────────────────────────────────────────────────────────────────────
const perms = new Map()
function permission(name, input) {
  if (mode === 'bypassPermissions' || allowed.has(name)) return Promise.resolve(true)
  const request_id = crypto.randomUUID()
  out({ type: 'control_request', request_id, request: { subtype: 'can_use_tool', tool_name: name, input } })
  return new Promise((res) => perms.set(request_id, res))
}

// ── guion ───────────────────────────────────────────────────────────────────────
const SCENE = `<!doctype html>
<html><head><meta charset="utf-8"><style>
html,body{margin:0;width:100%;height:100%;background:#0f1a2b;overflow:hidden;font-family:system-ui,sans-serif}
#t{position:absolute;left:0;right:0;top:38%;text-align:center;color:#fff;font-size:110px;font-weight:800}
#s{position:absolute;left:0;right:0;top:58%;text-align:center;color:#8fd3ff;font-size:44px}
</style></head><body><div id="t">Hola desde Termux</div><div id="s">Claude Code con tu plan</div>
<script>
window.__oa = { duration: 4, render(t) {
  const e = 1 - Math.pow(1 - Math.min(1, t / 1.2), 3)
  document.getElementById('t').style.opacity = e
  document.getElementById('t').style.transform = 'translateY(' + (50 * (1 - e)) + 'px)'
  document.getElementById('s').style.opacity = Math.max(0, Math.min(1, (t - 0.8) / 0.8))
} }
</script></body></html>`
const tl = { format: 'oa-timeline/1', duration: 4, tracks: [{ id: 'escenas', name: 'Escenas', type: 'scene', clips: [{ id: 'c-termux', src: 'scenes/termux.html', start: 0, duration: 4, in: 0 }] }, { id: 'voz', name: 'Voz', type: 'audio', clips: [] }], notes: [] }
const STEPS = [
  { think: 'Veo cómo está armado el proyecto antes de crear la escena.', text: 'Reviso el proyecto.', tool: 'oa_proyecto', input: {} },
  { tool: 'Write', input: { file_path: 'scenes/termux.html', content: SCENE } },
  { tool: 'Write', input: { file_path: 'timelines/main.json', content: JSON.stringify(tl, null, 2) } },
  { tool: 'oa_ver_fotogramas', input: { times: [0.5, 2.5], width: 640 } },
]
let n = 0
const id = (p) => `${p}_${crypto.randomBytes(8).toString('hex')}`

async function turn(text) {
  const t0 = Date.now()
  record({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })
  if (/^\/compact/.test(text)) {
    out({ type: 'system', subtype: 'compact_boundary', compact_metadata: { pre_tokens: 42000 } })
    out({ type: 'result', subtype: 'success', is_error: false, duration_ms: 300, total_cost_usd: 0.01, result: '' })
    return
  }
  for (const s of STEPS) {
    const blocks = []
    let index = 0
    out({ type: 'stream_event', event: { type: 'message_start', message: { usage: { input_tokens: 30, cache_read_input_tokens: 14000 + 900 * n++, cache_creation_input_tokens: 400 } } } })
    if (s.think) {
      out({ type: 'stream_event', event: { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } } })
      out({ type: 'stream_event', event: { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: s.think } } })
      out({ type: 'stream_event', event: { type: 'content_block_stop', index } })
      blocks.push({ type: 'thinking', thinking: s.think, signature: 'fake' }); index++
    }
    if (s.text) {
      out({ type: 'stream_event', event: { type: 'content_block_start', index, content_block: { type: 'text', text: '' } } })
      out({ type: 'stream_event', event: { type: 'content_block_delta', index, delta: { type: 'text_delta', text: s.text } } })
      out({ type: 'stream_event', event: { type: 'content_block_stop', index } })
      blocks.push({ type: 'text', text: s.text }); index++
    }
    const name = `mcp__openanimator__${s.tool}`
    const use = { type: 'tool_use', id: id('toolu'), name, input: s.input }
    out({ type: 'stream_event', event: { type: 'content_block_start', index, content_block: { ...use, input: {} } } })
    out({ type: 'stream_event', event: { type: 'content_block_stop', index } })
    blocks.push(use)
    out({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 120 } } })
    out({ type: 'assistant', message: { role: 'assistant', model, content: blocks } })
    record({ type: 'assistant', message: { role: 'assistant', model, content: blocks } })
    let result
    if (await permission(name, s.input)) {
      const r = (await call('tools/call', { name: s.tool, arguments: s.input })).result
      result = { type: 'tool_result', tool_use_id: use.id, content: r.content, is_error: !!r.isError }
    } else result = { type: 'tool_result', tool_use_id: use.id, content: 'El usuario rechazó esta acción.', is_error: true }
    out({ type: 'user', message: { role: 'user', content: [result] } })
    record({ type: 'user', message: { role: 'user', content: [result] } })
  }
  const final = 'Listo: creé **scenes/termux.html** y la puse en el timeline de 0 a 4 s. Revisé los fotogramas en 0,5 s y 2,5 s.'
  out({ type: 'stream_event', event: { type: 'message_start', message: { usage: { input_tokens: 30, cache_read_input_tokens: 18000, cache_creation_input_tokens: 200 } } } })
  out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
  out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: final } } })
  out({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
  out({ type: 'assistant', message: { role: 'assistant', model, content: [{ type: 'text', text: final }] } })
  record({ type: 'assistant', message: { role: 'assistant', model, content: [{ type: 'text', text: final }] } })
  record({ type: 'summary', aiTitle: 'Escena de saludo desde Termux' })
  out({ type: 'result', subtype: 'success', is_error: false, duration_ms: Date.now() - t0, total_cost_usd: 0.021, result: final, modelUsage: { [model]: { contextWindow: 1000000 } } })
}

let busy = Promise.resolve()
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let m
  try { m = JSON.parse(line) } catch { return }
  if (m.type === 'control_response') { const r = perms.get(m.response?.request_id); perms.delete(m.response?.request_id); r?.(m.response?.response?.behavior === 'allow'); return }
  if (m.type === 'control_request') { out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id } }); return }
  if (m.type === 'user') {
    const text = (m.message.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n')
    busy = busy.then(() => turn(text)).catch((e) => out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: String(e?.message || e) }))
  }
}).on('close', () => { mcp.kill(); process.exit(0) })
