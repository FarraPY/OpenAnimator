// Prueba del protocolo del chat (electron/claude-session.ts, lo usan la PC, el iPhone y Termux). La cola: lo que se escribe mientras
// Claude trabaja espera y sale solo al terminar el turno; sacarlo de la cola lo devuelve; si Claude Code se cierra, lo
// próximo retoma la misma conversación.   node --experimental-transform-types scripts/check-chat.mts
import assert from 'node:assert/strict'
import { ClaudeStreamSession } from '../electron/claude-session.ts'

class Fake extends ClaudeStreamSession {
  on = false; starts: Array<string | undefined> = []; lines: any[] = []
  protected get alive() { return this.on }
  start() { this.on = true; this.starts.push(this.opts.resume); return true }
  protected writeLine(obj: any) { this.lines.push(obj) }
  protected terminate() { this.on = false }
  line(m: any) { this.onLine(JSON.stringify(m)) }
  exit(code: number) { this.on = false; this.closed(code, '') }
}
const events: any[] = []
const c = new Fake({ projectId: 'p', permissionMode: 'acceptEdits' }, (e) => events.push(e))
const sent = () => c.lines.filter((l) => l.type === 'user').map((l) => l.message.content.at(-1).text)

c.send('uno')
c.line({ type: 'system', subtype: 'init', session_id: 'ses-1', model: 'm' })
c.send('dos'); c.send('tres'); c.send('cuatro')
assert.deepEqual(sent(), ['uno'], 'mientras trabaja, lo nuevo espera')
assert.deepEqual(c.items.filter((x) => x.queued).map((x) => x.text), ['dos', 'tres', 'cuatro'])
assert.deepEqual(await c.unqueue(c.items.find((x) => x.text === 'tres')!.id), ['tres'], 'sacar uno devuelve su texto')
assert.ok(events.some((e) => e.type === 'remove') && !c.items.some((x) => x.text === 'tres'))
c.line({ type: 'result', subtype: 'success', is_error: false })
assert.deepEqual(sent(), ['uno', 'dos'], 'al terminar el turno sale el primero de la cola')
assert.ok(c.busy && c.items.find((x) => x.text === 'dos')!.queued === false)
// Claude Code se cierra a mitad del turno: lo que queda en la cola sale en uno nuevo que retoma la conversación.
c.exit(143)
assert.deepEqual(sent(), ['uno', 'dos', 'cuatro'])
assert.deepEqual(c.starts, [undefined, 'ses-1'], 'el nuevo Claude Code arranca con --resume')
c.line({ type: 'result', subtype: 'success', is_error: false })
assert.ok(!c.busy && !c.items.some((x) => x.queued))
console.log('cola del chat: ok')

// Subagentes en segundo plano (mensajes como los de Claude Code 2.x): la fila del subagente trabaja hasta que avisa que
// terminó, sus herramientas van marcadas con él, su texto no se mezcla con el de Claude y no se relanza el proceso
// (cambiar el esfuerzo) mientras trabajan.
const s = new Fake({ projectId: 'p', permissionMode: 'acceptEdits' }, () => {})
s.send('hacé el video')
s.line({ type: 'system', subtype: 'init', session_id: 'ses-2', model: 'm' })
s.line({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'tA', name: 'Agent', input: { description: 'Escena 1', prompt: '…' } }] } })
s.line({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'x', description: 'Escena 1' }] })
s.line({ type: 'system', subtype: 'task_started', task_id: 'x', tool_use_id: 'tA', is_backgrounded: true })
s.line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tA', content: [{ type: 'text', text: 'Async agent launched successfully.' }] }] } })
const agent = s.items.find((x) => x.name === 'Agent')!
assert.equal(agent.status, 'trabajando')
s.line({ type: 'assistant', parent_tool_use_id: 'tA', message: { content: [{ type: 'text', text: 'Voy a escribir la escena' }, { type: 'tool_use', id: 'tB', name: 'mcp__openanimator__Write', input: { file_path: 'scenes/e1.html' } }] } })
s.line({ type: 'user', parent_tool_use_id: 'tA', message: { content: [{ type: 'tool_result', tool_use_id: 'tB', content: 'ok' }] } })
const write = s.items.find((x) => x.name === 'mcp__openanimator__Write')!
assert.ok(write.parent === agent.id && write.status === 'ok', 'la herramienta del subagente va con él')
assert.ok(!s.items.some((x) => x.kind === 'assistant' && /Voy a escribir/.test(x.text || '')), 'el texto del subagente no se muestra como de Claude')
s.line({ type: 'result', subtype: 'success', is_error: false })
assert.ok(!s.busy && s.tasks === 1, 'el turno terminó pero el subagente sigue')
s.setOptions({ effort: 'high' }, 'Esfuerzo: alto')
assert.ok(s.on, 'no se relanza mientras hay subagentes trabajando')
s.line({ type: 'system', subtype: 'background_tasks_changed', tasks: [] })
s.line({ type: 'system', subtype: 'task_notification', task_id: 'x', tool_use_id: 'tA', status: 'completed', summary: 'Escena 1 lista' })
assert.ok(agent.status === 'ok' && agent.result === 'Escena 1 lista')
s.line({ type: 'system', subtype: 'init', session_id: 'ses-2', model: 'm' })
assert.ok(s.busy, 'el turno que empieza solo cuenta como trabajando')
s.line({ type: 'result', subtype: 'success', is_error: false })
assert.ok(!s.busy)
await new Promise((r) => setTimeout(r, 80))
assert.deepEqual(s.starts, [undefined], 'el esfuerzo nuevo se aplica recién ahora (relanzar con --resume en el próximo mensaje)')
assert.ok(!s.on && s.opts.resume === 'ses-2')
console.log('subagentes: ok')

// A mitad del turno (Claude Code 2.1+, que avisa con command_lifecycle; mensajes como los que manda de verdad): lo que se
// escribe mientras trabaja se le manda enseguida y lo lee en la próxima pausa del mismo turno, sin cortarlo.
const l = new Fake({ projectId: 'p', permissionMode: 'acceptEdits' }, () => {})
const userLines = () => l.lines.filter((x) => x.type === 'user')
const lc = (u: string, state: string) => l.line({ type: 'command_lifecycle', command_uuid: u, state, uuid: 'x', session_id: 'ses-3' })
l.send('hacé tres escenas')
const u1 = userLines()[0].uuid
assert.match(u1, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, 'cada mensaje lleva un uuid de verdad (va al registro de Claude Code)')
lc(u1, 'queued'); lc(u1, 'started')
l.line({ type: 'system', subtype: 'init', session_id: 'ses-3', model: 'm' })
l.line({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: 'scenes/a.html' } }] } })
l.send('que la segunda sea azul')
assert.equal(userLines().length, 2, 'trabajando, se le manda enseguida (no espera al final del turno)')
const u2 = userLines()[1].uuid
const azul = l.items.find((x) => x.text === 'que la segunda sea azul')!
assert.ok(azul.queued && azul.midTurn)
lc(u2, 'queued')
l.line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } })
lc(u2, 'started')
const at = l.items.findIndex((x) => x.text === 'que la segunda sea azul')
assert.ok(at === l.items.length - 1 && !l.items[at].queued && l.items[at - 1].name === 'Write', 'al leerlo queda después de lo que Claude hizo antes')
assert.ok(l.busy, 'el turno sigue')
// Retirar uno que todavía no leyó: Claude Code lo saca de su cola.
l.send('mejor no, dejala roja')
const u3 = userLines()[2].uuid
lc(u3, 'queued')
const back = l.unqueue(l.items.find((x) => x.text === 'mejor no, dejala roja')!.id)
const cancel = l.lines.at(-1)
assert.deepEqual(cancel.request, { subtype: 'cancel_async_message', message_uuid: u3 })
lc(u3, 'cancelled')
l.line({ type: 'control_response', response: { subtype: 'success', request_id: cancel.request_id, response: { cancelled: true } } })
assert.deepEqual(await back, ['mejor no, dejala roja'], 'vuelve al cuadro de texto')
assert.ok(!l.items.some((x) => x.text === 'mejor no, dejala roja') && !l.items.some((x) => x.kind === 'notice' && /no llegó/.test(x.text || '')))
// Uno que Claude ya leyó no se puede retirar.
l.send('agregá música')
const u4 = userLines()[3].uuid
const late = l.unqueue(l.items.find((x) => x.text === 'agregá música')!.id)
lc(u4, 'started')
l.line({ type: 'control_response', response: { subtype: 'success', request_id: l.lines.at(-1).request_id, response: { cancelled: false } } })
assert.deepEqual(await late, [])
assert.ok(l.items.some((x) => x.text === 'agregá música' && !x.queued))
// Llega cuando el turno ya terminaba: Claude Code lo corre enseguida como un turno nuevo; mientras tanto no se relanza.
l.send('y un título')
const u5 = userLines()[4].uuid
lc(u5, 'queued')
l.setOptions({ effort: 'high' }, 'Esfuerzo: alto')
l.line({ type: 'result', subtype: 'success', is_error: false })
await new Promise((r) => setTimeout(r, 80))
assert.ok(l.on, 'con un mensaje sin leer no se relanza el proceso')
lc(u5, 'started')
l.line({ type: 'system', subtype: 'init', session_id: 'ses-3', model: 'm' })
assert.ok(l.busy && !l.items.some((x) => x.queued))
l.line({ type: 'result', subtype: 'success', is_error: false })
await new Promise((r) => setTimeout(r, 80))
assert.ok(!l.on && l.opts.resume === 'ses-3', 'ahora sí se relanza (esfuerzo nuevo)')
// Claude Code se cierra con un mensaje sin leer: sale de nuevo en el próximo proceso.
l.send('hola')
l.line({ type: 'system', subtype: 'init', session_id: 'ses-3', model: 'm' })
l.send('¿seguís?')
const n = userLines().length
l.exit(1)
assert.equal(userLines().length, n + 1, 'el que no leyó se vuelve a mandar al relanzarlo')
assert.equal(userLines().at(-1).message.content.at(-1).text, '¿seguís?')
console.log('mensajes a mitad del turno: ok')
