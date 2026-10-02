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
assert.deepEqual(c.unqueue(c.items.find((x) => x.text === 'tres')!.id), ['tres'], 'sacar uno devuelve su texto')
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
