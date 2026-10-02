// API de Anthropic de mentira para la prueba de punta a punta en el simulador (no gasta el plan de nadie).
//   node ios/test/mock-anthropic.mjs [puerto]
// Contesta en streaming como /v1/messages. Un mensaje con «[mcp] herramienta {json}» hace que el "modelo" llame a esa
// herramienta; después de la respuesta de la herramienta, contesta «Listo: usé la herramienta…».
import http from 'node:http'

const PORT = +(process.argv[2] || 8899)
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a)
const CORS = { 'Access-Control-Allow-Origin': '*' }
const usage = { input_tokens: 12, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

function sse(res, events) {
  res.writeHead(200, { ...CORS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'request-id': 'req_mock' })
  let i = 0
  const tick = () => {
    if (i >= events.length) return res.end()
    const [type, data] = events[i++]
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
    setTimeout(tick, 10)
  }
  tick()
}

function reply(body) {
  const msgs = body.messages || []
  const textOf = (m) => (typeof m?.content === 'string' ? m.content : (m?.content || []).map((b) => b.text || (b.type === 'tool_result' ? '[tool_result] ' + JSON.stringify(b.content).slice(0, 200) : '')).join(' '))
  const texts = msgs.map(textOf)
  // El pedido del usuario: el último mensaje con texto propio (Claude Code agrega avisos de sistema que empiezan con "<").
  const ask = texts.findLastIndex((t) => /\S/.test(t) && !/^\s*(# Environment|<)/.test(t) && !t.startsWith('[tool_result]'))
  const answered = texts.slice(ask + 1).some((t) => t.includes('[tool_result]'))
  log('pedido:', (texts[ask] || '').slice(0, 160).replace(/\s+/g, ' '), answered ? '(herramienta respondida)' : '')
  const tools = (body.tools || []).map((t) => t.name)
  const start = ['message_start', { message: { id: 'msg_' + Date.now(), type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } }]
  const m = /\[mcp\]\s+(\S+)\s*(\{.*\})?/s.exec(texts[ask] || '')
    // El analizador de videos («Crear plantilla desde un video»): escribe un análisis mínimo.
    || (/_analisis\/analisis\.json/.test(texts[ask] || '') ? [null, 'Write', JSON.stringify({ file_path: '_analisis/analisis.json', content: JSON.stringify({ titulo: 'Estilo de prueba', resumen: 'Lo escribió la API de mentira.' }) })] : null)
  if (m && !answered) {
    const name = tools.find((t) => t.endsWith(m[1])) || m[1]
    return [start,
      ['content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_' + Date.now(), name, input: {} } }],
      ['content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: (m[2] || '{}').replace(/\s*\(Contexto del editor:[\s\S]*$/, '') } }],
      ['content_block_stop', { index: 0 }],
      ['message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } }],
      ['message_stop', {}]]
  }
  const result = /\[tool_result\] (.*)/.exec(texts.slice(ask).join(' '))
  const text = answered ? `Listo: usé la herramienta y respondió ${result ? result[1].slice(0, 160) : ''}` : `Hola, soy el Claude de prueba. Herramientas: ${tools.length}. Mensajes: ${msgs.length}.`
  return [start,
    ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }],
    ...text.match(/.{1,16}/gs).map((t) => ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: t } }]),
    ['content_block_stop', { index: 0 }],
    ['message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 30 } }],
    ['message_stop', {}]]
}

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { ...CORS, 'Access-Control-Allow-Methods': 'GET,POST,HEAD,OPTIONS', 'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || '*', 'Access-Control-Max-Age': '600' })
    return res.end()
  }
  let b = ''
  req.on('data', (d) => { b += d })
  req.on('end', () => {
    let body = {}
    try { body = JSON.parse(b || '{}') } catch { /* no es JSON */ }
    log(req.method, u.pathname, body.model || '', `tools=${(body.tools || []).length}`)
    if (u.pathname === '/v1/messages' && req.method === 'POST') {
      if (body.stream) return sse(res, reply(body))
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ id: 'msg_x', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null, usage }))
    }
    if (u.pathname === '/v1/messages/count_tokens') { res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' }); return res.end('{"input_tokens":100}') }
    if (u.pathname === '/api/hello') { res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' }); return res.end('{"message":"hello"}') }
    res.writeHead(404, { ...CORS, 'Content-Type': 'application/json' })
    res.end('{"type":"error","error":{"type":"not_found_error","message":"mock"}}')
  })
}).listen(PORT, '127.0.0.1', () => log(`API de mentira en http://127.0.0.1:${PORT}`))
