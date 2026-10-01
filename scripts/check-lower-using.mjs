#!/usr/bin/env node
/**
 * Prueba de lowerUsing (src/iphone/claude/transform.ts): Claude Code usa `using` / `await using`, que el WebKit de iOS no
 * entiende; la app los reescribe al instalar. Esto comprueba el orden en que se liberan los recursos, los return, los
 * bloques anidados, for-of, await using y que no cambie el alcance de las declaraciones.
 *   node scripts/check-lower-using.mjs        (Node 23.6+: importa el .ts directo)
 */
import assert from 'node:assert/strict'
import { lowerUsing } from '../src/iphone/claude/transform.ts'

// Los ayudantes que define el Worker de Claude Code (src/iphone/claude/node/inject.js).
globalThis.$oaUse = (stack, isAsync, v) => { if (v != null) stack.push(isAsync, v); return v }
globalThis.$oaDispose = (stack) => { for (let i = stack.length - 2; i >= 0; i -= 2) stack[i + 1][Symbol.dispose]() }
globalThis.$oaDisposeAsync = async (stack) => {
  for (let i = stack.length - 2; i >= 0; i -= 2) { const v = stack[i + 1]; await (stack[i] ? (v[Symbol.asyncDispose] || v[Symbol.dispose]) : v[Symbol.dispose]).call(v) }
}

const sample = `
const log = [];
const res = (n) => ({ [Symbol.dispose]() { log.push('dispose ' + n) } });
function f() { log.push('start'); using a = res('a'), b = res('b'); using c = null; { using d = res('d'); log.push('inner') } log.push('body'); return 'ret' }
log.push(f());
for (using e of [res('e1'), res('e2')]) log.push('loop');
async function g() { await using h = { async [Symbol.asyncDispose]() { log.push('async h') } }; log.push('g body') }
await g();
function scope() { const early = () => later + jl(); using r = res('r'); const later = 'L'; function jl() { return 'J' } log.push(early()) }
scope();
function sw(x) { switch (x) { case 1: { using s1 = res('s1'); log.push('case1'); break } case 2: { using s2 = res('s2'); log.push('case2'); break } } }
sw(1); sw(2);
globalThis.__log = log;
`
const out = lowerUsing(sample)
assert.ok(!/\busing\s+[a-z]/.test(out), 'quedó un using sin reescribir')
await import('data:text/javascript,' + encodeURIComponent(out))
assert.equal(globalThis.__log.join(' | '),
  'start | inner | dispose d | body | dispose b | dispose a | ret | loop | dispose e1 | loop | dispose e2 | g body | async h | LJ | dispose r | case1 | dispose s1 | case2 | dispose s2')
assert.equal(lowerUsing('const usingX = 1; // using x = 2'), 'const usingX = 1; // using x = 2') // nada que tocar
console.log('lowerUsing: ok')
