// Prueba de la cola del chat (electron/claude-session.ts, la usan la PC, el iPhone y Termux): lo que se escribe mientras
// Claude trabaja espera y sale solo al terminar el turno; sacarlo de la cola lo devuelve; si Claude Code se cierra, lo
// próximo retoma la misma conversación.   node --experimental-transform-types scripts/check-chat-queue.mts
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
