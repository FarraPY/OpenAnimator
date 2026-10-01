// path de Node: POSIX (path-browserify). win32 es una aproximación: Claude Code corre como Linux y sólo la usa en ramas de Windows.
import pb from 'path-browserify'

export const posix = { ...pb }
export const win32 = { ...pb, sep: '\\', delimiter: ';' }
for (const p of [posix, win32]) {
  p.posix = posix
  p.win32 = win32
  p.toNamespacedPath = (x) => x
  p.matchesGlob = (file, pattern) => globToRegExp(pattern).test(file)
}

/** Glob simple (*, **, ?, {a,b}) a RegExp. */
export function globToRegExp(g) {
  let re = '', i = 0
  while (i < g.length) {
    const c = g[i]
    if (c === '*') { if (g[i + 1] === '*') { re += '.*'; i += 2; if (g[i] === '/') i++; continue } re += '[^/]*' }
    else if (c === '?') re += '[^/]'
    else if (c === '{') { const j = g.indexOf('}', i); if (j > i) { re += '(' + g.slice(i + 1, j).split(',').map((s) => s.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|') + ')'; i = j + 1; continue } re += '\\{' }
    else re += /[.+^$()|[\]\\]/.test(c) ? '\\' + c : c
    i++
  }
  return new RegExp('^' + re + '$')
}
export default posix
