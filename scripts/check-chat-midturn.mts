// Prueba de punta a punta de los mensajes a mitad del turno y de volver a un mensaje (editar, reintentar) con el Claude Code instalado en la PC (sin gastar el plan:
// contra una API de mentira local). Claude llama 3 veces a Bash (sleep 3); a los 4,5 s se le escribe algo, que tiene que
// leer en el MISMO turno (llega con el resultado de la herramienta); otro mensaje se retira antes de que lo lea.
//   node --experimental-transform-types scripts/check-chat-midturn.mts
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeStreamSession } from '../electron/claude-session.ts'

const usage = { input_tokens: 12, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
const seen: string[] = [] // lo que la API recibió de nuevo en cada pedido del turno
let echoed: string[] = []
const sse = (res: http.ServerResponse, events: Array<[string, any]>) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'request-id': 'req_mock' })
  for (const [type, data] of events) res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  res.end()
}
const start = (model: string): [string, any] => ['message_start', { message: { id: 'msg_' + Date.now(), type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage } }]
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (d) => (body += d))
  req.on('end', () => {
    const b = JSON.parse(body || '{}')
    if (req.url?.includes('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"input_tokens":10}') }
    const tools = (b.tools || []).map((t: any) => t.name)
    if (!tools.includes('Bash')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: b.model, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage })) }
    const msgs = b.messages || []
    // «[eco]»: contesta con los pedidos del usuario que le llegaron (para ver qué historia tiene la conversación).
    const asks = msgs.filter((m: any) => m.role === 'user').flatMap((m: any) => (Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }])).filter((c: any) => c.type === 'text' && c.text.startsWith('[eco]')).map((c: any) => c.text.slice(6))
    if (asks.length) { echoed = asks; return sse(res, [start(b.model), ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }], ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Vi: ' + asks.join(' | ') } }], ['content_block_stop', { index: 0 }], ['message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }], ['message_stop', {}]]) }
    seen.push(JSON.stringify(msgs.at(-1)?.content || ''))
    const results = msgs.flatMap((m: any) => (Array.isArray(m.content) ? m.content : [])).filter((c: any) => c.type === 'tool_result').length
    if (results < 3) return sse(res, [start(b.model), ['content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_' + Date.now(), name: 'Bash', input: {} } }], ['content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command: 'sleep 3', description: 'esperar' }) } }], ['content_block_stop', { index: 0 }], ['message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } }], ['message_stop', {}]])
    sse(res, [start(b.model), ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }], ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Terminé.' } }], ['content_block_stop', { index: 0 }], ['message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }], ['message_stop', {}]])
  })
})
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
const port = (server.address() as any).port

class Local extends ClaudeStreamSession {
  proc: ChildProcess | null = null
  out = ''
  protected get alive() { return !!this.proc }
  start() {
    const env = { ...process.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: 'sk-ant-test-mock', CLAUDE_CODE_OAUTH_TOKEN: '', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--setting-sources', '""',
      '--model', 'claude-sonnet-5', '--permission-mode', 'bypassPermissions', '--tools', 'Bash', '--strict-mcp-config']
    if (this.opts.resume) args.push('--resume', this.opts.resume)
    if (this.opts.resume && this.opts.resumeAt) args.push('--resume-session-at', this.opts.resumeAt, '--fork-session')
    const p = this.proc = spawn('claude', args, { cwd: mkdtempSync(join(tmpdir(), 'oa-midturn-')), shell: true, env })
    p.stdout!.on('data', (d) => { this.out += d; for (let i; (i = this.out.indexOf('\n')) >= 0;) { const line = this.out.slice(0, i); this.out = this.out.slice(i + 1); if (line.trim()) this.onLine(line) } })
    p.on('close', (code) => { if (this.proc === p) { this.proc = null; this.closed(code, '') } })
    return true
  }
  protected writeLine(obj: unknown) { this.proc?.stdin?.write(JSON.stringify(obj) + '\n') }
  protected terminate() { this.proc?.stdin?.end(); this.proc = null }
}

const results: number[] = []
const chat = new Local({ projectId: 'p', permissionMode: 'bypassPermissions' }, (e) => { if (e.type === 'item' && e.item?.kind === 'result') results.push(Date.now()) })
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const until = async (f: () => boolean, ms = 30000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('tiempo agotado'); await wait(50) } }
chat.send('Hacé tres esperas.')
await wait(4500)
assert.ok(chat.busy, 'sigue trabajando')
chat.send('MENSAJE A MITAD DEL TURNO')
chat.send('ESTE LO RETIRO')
const retirado = await chat.unqueue(chat.items.find((x) => x.text === 'ESTE LO RETIRO')!.id)
assert.deepEqual(retirado, ['ESTE LO RETIRO'], 'retirarlo antes de que lo lea devuelve su texto')
await until(() => results.length > 0)
await wait(500)
assert.equal(results.length, 1, 'un solo turno: el mensaje no lo cortó ni armó otro')
assert.ok(seen.some((s) => s.includes('MENSAJE A MITAD DEL TURNO')), 'Claude lo recibió dentro del turno')
assert.ok(!seen.some((s) => s.includes('ESTE LO RETIRO')), 'el retirado no le llegó')
const order = chat.items.map((x) => x.kind === 'user' ? x.text : x.kind === 'tool' ? 'Bash' : x.kind)
const mid = order.indexOf('MENSAJE A MITAD DEL TURNO')
assert.ok(mid > order.indexOf('Bash') && !chat.items.some((x) => x.queued), `queda donde lo leyó: ${order.join(' · ')}`)
console.log('mensajes a mitad del turno con Claude Code de verdad: ok —', order.join(' · '))
chat.kill()

// Editar y reenviar, y reintentar: la conversación vuelve a ese punto (una copia; la original queda en el historial).
const e = new Local({ projectId: 'p', permissionMode: 'bypassPermissions' }, (ev) => { if (ev.type === 'item' && ev.item?.kind === 'result') results.push(Date.now()) })
const turnDone = async (f: () => void) => { const n = results.length; f(); await until(() => results.length > n); await wait(300) }
await turnDone(() => e.send('[eco] uno'))
await turnDone(() => e.send('[eco] dos'))
await turnDone(() => e.send('[eco] tres'))
assert.deepEqual(echoed, ['uno', 'dos', 'tres'])
const first = e.sessionId
assert.equal(e.rewind(e.items.find((x) => x.text === '[eco] dos')!.id), '[eco] dos')
await turnDone(() => e.send('[eco] DOS EDITADO'))
assert.deepEqual(echoed, ['uno', 'DOS EDITADO'], 'Claude ve la conversación hasta «uno» y el pedido editado')
assert.ok(e.sessionId && e.sessionId !== first, 'es otra conversación (la original queda en el historial)')
await turnDone(() => e.send('[eco] cuatro'))
assert.deepEqual(echoed, ['uno', 'DOS EDITADO', 'cuatro'], 'y sigue desde ahí')
await turnDone(() => assert.ok(e.retry()))
assert.deepEqual(echoed, ['uno', 'DOS EDITADO', 'cuatro'], 'reintentar manda lo mismo sin la respuesta anterior')
assert.deepEqual(e.items.filter((x) => x.kind === 'user').map((x) => x.text), ['[eco] uno', '[eco] DOS EDITADO', '[eco] cuatro'])
console.log('editar y reenviar, y reintentar, con Claude Code de verdad: ok')
e.kill()
server.close()
process.exit(0)
