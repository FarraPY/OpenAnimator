/**
 * Los modelos para elegir. En el iPhone los dice el Claude Code instalado (claude:models: lo mismo que su /model, según
 * la cuenta, con alias como opus/sonnet que siguen al más nuevo); en la PC y la tablet, la lista fija de api.ts.
 */
import { useEffect, useState } from 'react'
import { call, MODELS, modelName, on } from './api'
import { isIphone } from './platform'

type CodeModel = { value: string; resolvedModel?: string; displayName?: string; description?: string }
export type ModelOption = { value: string; label: string; desc?: string; hint?: string }

const TAGLINE: Record<string, string> = {
  opus: 'El más capaz: dirección artística y escenas complejas',
  sonnet: 'Rápido y muy capaz para el trabajo diario',
  haiku: 'El más rápido, para cambios chicos',
  fable: 'Lo más capaz, para lo más difícil y largo',
}

/** Los de Claude Code (en inglés) con nombres de acá («Opus 5.5»); uno nuevo aparece con lo que diga Claude Code. */
function fromCode(list: CodeModel[]): ModelOption[] {
  return list.map((m) => {
    const parts = String(m.description || '').split(' · ')
    const price = parts.find((x) => x.includes('$'))
    if (m.value === 'default') {
      const now = /\(currently ([^)]+)\)/.exec(m.description || '')?.[1]
      return { value: '', label: 'Recomendado', desc: now ? `El que elige Claude Code (hoy, ${now})` : 'El que elige Claude Code', hint: price }
    }
    const family = (m.resolvedModel || m.value).replace(/^claude-/, '').split('-')[0]
    const name = parts[0] && !parts[0].includes('$') ? parts[0] : m.displayName || m.value
    return { value: m.value, label: name, desc: TAGLINE[family] || parts.slice(1).filter((x) => !x.includes('$')).join(' · '), hint: price }
  })
}

let known: CodeModel[] | null = null

/** Opciones, el valor que corresponde a lo guardado (un nombre completo → su alias) y el nombre para mostrar. */
export function useModels() {
  const [list, setList] = useState<CodeModel[] | null>(known)
  useEffect(() => {
    if (!isIphone()) return
    const set = (l: CodeModel[] | null) => { if (l?.length) { known = l; setList(l) } }
    call<CodeModel[] | null>('claude:models').then(set).catch(() => {})
    return on('claude:models', set)
  }, [])
  if (!list) return { options: MODELS.map((m): ModelOption => ({ value: m.id, label: m.name, desc: m.desc, hint: m.note })), value: (v: string) => v, name: modelName }
  const options = fromCode(list)
  const value = (v: string) => {
    if (!v || v === 'default') return ''
    if (list.some((m) => m.value === v)) return v
    return list.find((m) => m.value !== 'default' && (m.resolvedModel === v || m.resolvedModel?.startsWith(v + '-')))?.value ?? v
  }
  const name = (v?: string) => options.find((o) => o.value === value(v || ''))?.label || (v === 'default' ? 'Recomendado' : v) || 'Recomendado'
  return { options, value, name }
}
