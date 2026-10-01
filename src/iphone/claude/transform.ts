/**
 * Adapta un módulo de Claude Code (compilado para Bun) para que lo cargue un Worker del navegador:
 *  - import.meta.require("/$bunfs/…") (Bun evalúa otro trozo en ese momento, de forma sincrónica):
 *      · si corre al evaluar el módulo (fuera de funciones) → import estático: el trozo se evalúa justo antes;
 *      · si está dentro de una función (carga perezosa) → globalThis.__oaRequire("…"), y el trozo se precarga cuando
 *        arranca Claude Code (un import estático adelantaría su evaluación y armaría ciclos que en Bun no existen);
 *  - el resto de import.meta.require (módulos de Node por nombre, o la función guardada en una variable) → __oaRequire;
 *  - import.meta.dirname / dir / url → los valores que tiene en Bun (la carpeta virtual /$bunfs/root);
 *  - los módulos de Node y los externos ("fs", "node:crypto", "ws", "bun:jsc"…) → <base>oa-node/<nombre>.js, y los
 *    trozos ("/$bunfs/root/…") → <base>$bunfs/root/… (la app puede estar en una subcarpeta, como en GitHub Pages).
 * Las posiciones las dan es-module-lexer (imports) y acorn (si un require está dentro de una función): no se toca
 * nada que sólo parezca código dentro de un texto. El resto es el código de Anthropic tal cual.
 */
import { init, parse } from 'es-module-lexer/minimal'
import { parse as parseJs } from 'acorn'

export const ready = init
export const nodeModuleFile = (spec: string) => spec.replace(/^node:/, '').replace(/\//g, '__').replace(/:/g, '_') + '.js'
const isBare = (s: string | undefined): s is string => !!s && !s.startsWith('/') && !s.startsWith('.') && !/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && !s.startsWith('data:')

/** Nombres que importa una declaración `import … from` / `export … from` (para que el envoltorio los exporte). */
function importedNames(stmt: string) {
  const out: string[] = []
  const m = /^(?:import|export)\s*([\s\S]*?)\s*from\s*["']/.exec(stmt)
  const named = m && /\{([^}]*)\}/.exec(m[1])
  if (named) for (const part of named[1].split(',')) { const n = part.trim().split(/\s+as\s+/)[0].trim().replace(/^["']|["']$/g, ''); if (n && n !== 'default' && n !== 'type') out.push(n) }
  return out
}

/** Posiciones de `import.meta` en los import.meta.require("/$bunfs/…") que corren al evaluar el módulo. */
function eagerRequires(src: string) {
  const out = new Set<number>()
  if (!src.includes('import.meta.require("/$bunfs/')) return out
  let ast: any
  try { ast = parseJs(src, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true }) } catch { return out }
  const stack: Array<[any, boolean]> = [[ast, false]]
  while (stack.length) {
    const [node, inFn] = stack.pop()!
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && node.callee.object.type === 'MetaProperty' && node.callee.property.name === 'require' && !inFn) out.add(node.callee.object.start)
    // Dentro de una función (o de un campo de instancia) el código corre después, cuando se lo llama.
    const fn = inFn || node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression' || (node.type === 'PropertyDefinition' && !node.static)
    for (const k in node) {
      const v = node[k]
      if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') stack.push([c, fn]) } else if (v && typeof v === 'object' && typeof v.type === 'string') stack.push([v, fn])
    }
  }
  return out
}

export type TransformCtx = {
  /** Carpeta de la app con / final (p. ej. "/OpenAnimator/"). */
  base: string
  /** Módulos externos que se importan, con los nombres que se piden de cada uno. */
  externals: Map<string, Set<string>>
  /** Trozos que se cargan de forma perezosa (se precargan al arrancar). */
  lazy: Set<string>
}

export function transformModule(name: string, src: string, ctx: TransformCtx) {
  const [imports] = parse(src, name)
  const eager = eagerRequires(src)
  const statics = new Map<string, string>()
  const edits: Array<[number, number, string]> = []
  const chunkUrl = (p: string) => ctx.base + p.slice(1) // "/$bunfs/root/x.js" → "<base>$bunfs/root/x.js"
  for (const im of imports) {
    if (im.d === -2) {
      const after = src.slice(im.e, im.e + 200)
      let m: RegExpExecArray | null
      if ((m = /^\.require\(\s*"(\/\$bunfs\/root\/[^"]+)"\s*\)/.exec(after))) {
        if (eager.has(im.s) && /\.m?js$/.test(m[1])) {
          if (!statics.has(m[1])) statics.set(m[1], `__oaR${statics.size}`)
          edits.push([im.s, im.e + m[0].length, statics.get(m[1])!])
        } else {
          if (/\.m?js$/.test(m[1])) ctx.lazy.add(m[1].slice(13))
          edits.push([im.s, im.e + m[0].length, `globalThis.__oaRequire(${JSON.stringify(m[1])})`])
        }
      } else if ((m = /^\.require\b/.exec(after))) edits.push([im.s, im.e + m[0].length, 'globalThis.__oaRequire'])
      else if ((m = /^\.(dirname|dir)\b/.exec(after))) edits.push([im.s, im.e + m[0].length, '"/$bunfs/root"'])
      else if ((m = /^\.url\b/.exec(after))) edits.push([im.s, im.e + m[0].length, JSON.stringify('file:///$bunfs/root/' + name)])
      continue
    }
    const spec = im.n
    const quoted = src[im.s] === '"' || src[im.s] === "'"
    if (spec?.startsWith('/$bunfs/root/')) { edits.push([im.s, im.e, quoted ? JSON.stringify(chunkUrl(spec)) : chunkUrl(spec)]); continue }
    if (!isBare(spec)) continue
    const target = ctx.base + 'oa-node/' + nodeModuleFile(spec)
    edits.push([im.s, im.e, quoted ? JSON.stringify(target) : target])
    if (!ctx.externals.has(spec)) ctx.externals.set(spec, new Set())
    if (im.d === -1) for (const n of importedNames(src.slice(im.ss, im.se))) ctx.externals.get(spec)!.add(n)
  }
  edits.sort((a, b) => b[0] - a[0])
  for (const [s, e, t] of edits) src = src.slice(0, s) + t + src.slice(e)
  let head = ''
  for (const [spec, id] of statics) head += `import * as ${id} from ${JSON.stringify(chunkUrl(spec))};`
  // El punto de entrada espera la precarga de los trozos perezosos (después de sus propios imports estáticos, como en Bun).
  if (name === 'cli') head += 'await globalThis.__oaPreload?.();'
  return head + src
}

const RESERVED = new Set('arguments await break case catch class const continue debugger default delete do else enum eval export extends false finally for function if implements import in instanceof interface let new null package private protected public return static super switch this throw true try typeof var void while with yield'.split(' '))
/** Envoltorio ES de un módulo de Node: toma el módulo armado por el runtime y exporta todos los nombres pedidos. */
export function wrapperSource(spec: string, names: Iterable<string>) {
  const ok = [...new Set(names)].filter((n) => /^[A-Za-z_$][\w$]*$/.test(n) && !RESERVED.has(n)).sort()
  return `const m = globalThis.__oaMod(${JSON.stringify(spec)}, ${JSON.stringify(ok)});\nexport default (m.default ?? m);\n` + (ok.length ? `export const { ${ok.join(', ')} } = m;\n` : '')
}

export const isCode = (name: string) => name === 'cli' || /\.(m?js)$/.test(name)
