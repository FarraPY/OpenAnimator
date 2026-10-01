import { v } from './dep.js'
const d2 = await import('./dep2.js')
const txt = await (await fetch('data.txt')).text()
postMessage(`module ok · estático ${v} · dinámico ${d2.v} · fetch ${txt.trim()}`)
