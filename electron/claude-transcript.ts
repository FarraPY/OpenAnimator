/**
 * Las conversaciones que guarda Claude Code (~/.claude/projects/<carpeta>/<sesión>.jsonl), sin Node: las lee la PC
 * (claude.ts, con fs) y el iPhone (src/android/backend/webclaude.ts, con su carpeta de datos).
 */
import { nid, type ChatItem } from './claude-session'

export const CTX_SUFFIX = /\n\n\(Contexto del editor:[\s\S]*$/
export const userText = (m: any): string => {
  const c = m?.message?.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n')
  return ''
}
export const isRealPrompt = (m: any) => m.type === 'user' && !m.isMeta && !m.isSidechain && !!userText(m).trim() && !/^\s*<|^\[Request interrupted/.test(userText(m))

/** Carpeta donde Claude Code guarda las conversaciones de un directorio de trabajo. */
export const sessionsSlug = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, '-')

/** Título (el último aiTitle) y primer pedido de una conversación, a partir del principio y el final del archivo. */
export function sessionInfo(head: string, tail: string): { title: string; first: string } | null {
  let first = ''
  for (const line of head.split('\n')) {
    try { const m = JSON.parse(line); if (isRealPrompt(m)) { first = userText(m).replace(CTX_SUFFIX, '').trim(); break } } catch { /* línea cortada */ }
  }
  if (!first) return null
  let title = ''
  const titles = [...tail.matchAll(/"aiTitle":"((?:[^"\\]|\\.)*)"/g)]
  if (titles.length) try { title = JSON.parse(`"${titles[titles.length - 1][1]}"`) } catch { /* ignore */ }
  return { title: title || first.split('\n')[0].slice(0, 80), first: first.slice(0, 220) }
}

/** Reconstruye lo que se ve en el chat a partir del archivo de la conversación. */
export function parseTranscript(text: string): ChatItem[] {
  const items: ChatItem[] = []
  const tools = new Map<string, ChatItem>()
  for (const line of text.split('\n')) {
    let m: any
    try { m = JSON.parse(line) } catch { continue }
    if (m.isSidechain) continue
    if (m.type === 'system' && m.subtype === 'compact_boundary') { items.push({ id: nid('n'), kind: 'notice', text: 'Conversación compactada.', level: 'info' }); continue }
    const c = m.message?.content
    if (m.type === 'user') {
      if (m.isMeta || m.isCompactSummary) continue
      if (Array.isArray(c)) for (const b of c) if (b.type === 'tool_result') {
        const it = tools.get(b.tool_use_id)
        if (!it) continue
        const txt = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((x: any) => (x.type === 'text' ? x.text : x.type === 'image' ? '[imagen]' : '')).join('\n') : ''
        it.status = b.is_error ? 'error' : 'ok'; it.isError = !!b.is_error; it.result = txt.slice(0, 4000)
      }
      if (isRealPrompt(m)) {
        const imgs = Array.isArray(c) ? c.filter((b: any) => b.type === 'image').length : 0
        items.push({ id: nid('u'), kind: 'user', text: userText(m), images: imgs || undefined })
      } else if (/^\[Request interrupted/.test(userText(m))) items.push({ id: nid('n'), kind: 'notice', text: 'Interrumpido.', level: 'info' })
    } else if (m.type === 'assistant' && Array.isArray(c)) {
      for (const b of c) {
        if (b.type === 'text' && b.text?.trim()) items.push({ id: nid('a'), kind: 'assistant', text: b.text, status: 'ok' })
        else if (b.type === 'tool_use') { const it: ChatItem = { id: nid('tool'), kind: 'tool', name: b.name, input: b.input, status: 'ok' }; tools.set(b.id, it); items.push(it) }
      }
    }
  }
  return items.slice(-400)
}
