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

/**
 * `using` / `await using` (gestión explícita de recursos): Bun los entiende y el WebKit de iOS todavía no (SyntaxError).
 * Se reescriben como lo hacen los compiladores (Babel, TypeScript): TODO el bloque va dentro de un try (así no cambia
 * dónde se ve cada declaración: una función definida antes del `using` puede usar algo declarado después), cada recurso
 * se anota en una pila ($oaUse) y el finally los libera en orden inverso ($oaDispose / $oaDisposeAsync, definidos en
 * claude/node/inject.js). En la cabecera de un for-of, el cuerpo queda dentro del try. En el nivel del módulo sólo se
 * cambia por `const` (un try no puede envolver import/export).
 */
export function lowerUsing(src: string): string {
  if (!/\busing\s/.test(src)) return src
  let ast: any
  try { ast = parseJs(src, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true }) } catch { return src }
  const edits: Array<[number, number, string]> = []
  const dispose = (d: any) => d.declarations.map((x: any) => x.id.name).reverse().map((n: string) => (d.kind === 'await using'
    ? `if (${n} != null) await (${n}[Symbol.asyncDispose] || ${n}[Symbol.dispose]).call(${n});`
    : `if (${n} != null) ${n}[Symbol.dispose]();`)).join(' ')
  const keyword = (d: any) => edits.push([d.start, d.start + /^(await\s+)?using/.exec(src.slice(d.start))![0].length, 'const'])
  const isUsing = (s: any) => s?.type === 'VariableDeclaration' && (s.kind === 'using' || s.kind === 'await using')
  const stack: any[] = [ast]
  while (stack.length) {
    const node = stack.pop()
    const list: any[] | null = node.type === 'BlockStatement' || node.type === 'StaticBlock' ? node.body : node.type === 'SwitchCase' ? node.consequent : null
    const usings = list ? list.filter(isUsing) : []
    if (list && usings.length) {
      // Las directivas ("use strict") tienen que seguir al principio.
      let first = 0
      while (first < list.length && list[first].directive) first++
      const anyAwait = usings.some((s) => s.kind === 'await using')
      const from = first < list.length ? list[first].start : list[list.length - 1].end
      // En un case, entre llaves: dos case no pueden declarar el mismo $oaR.
      const open = node.type === 'SwitchCase' ? '{ ' : '', close = node.type === 'SwitchCase' ? ' }' : ''
      edits.push([from, from, open + 'const $oaR = []; try { '])
      for (const s of usings) {
        keyword(s)
        for (const d of s.declarations) if (d.init) edits.push([d.init.start, d.init.start, `$oaUse($oaR, ${s.kind === 'await using'}, `], [d.init.end, d.init.end, ')'])
      }
      const end = list[list.length - 1].end
      edits.push([end, end, (anyAwait ? ' } finally { await $oaDisposeAsync($oaR) }' : ' } finally { $oaDispose($oaR) }') + close])
    } else if (node.type === 'Program') {
      for (const s of node.body) if (isUsing(s)) keyword(s)
    } else if ((node.type === 'ForOfStatement' || node.type === 'ForInStatement') && isUsing(node.left)) {
      keyword(node.left)
      edits.push([node.body.start, node.body.start, '{ try { '], [node.body.end, node.body.end, ` } finally { ${dispose(node.left)} } }`])
    }
    for (const k in node) {
      const v = node[k]
      if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') stack.push(c) } else if (v && typeof v === 'object' && typeof v.type === 'string') stack.push(v)
    }
  }
  // De atrás para adelante; en una misma posición, en el orden en que se agregaron (inserciones estables).
  edits.forEach((e, i) => ((e as any).i = i))
  edits.sort((a, b) => b[0] - a[0] || (b as any).i - (a as any).i)
  for (const [s, e, t] of edits) src = src.slice(0, s) + t + src.slice(e)
  return src
}

export function transformModule(name: string, src: string, ctx: TransformCtx) {
  src = lowerUsing(src)
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
