/**
 * Pantalla encendida mientras dura un trabajo largo (un turno de Claude, una exportación, mover proyectos): si se
 * apaga, Android pausa el WebView y el trabajo se corta. Cuenta los pedidos, así terminar uno no
 * apaga la pantalla mientras sigue el otro.
 */
import { host } from '../host'
import { getSettings } from './settings'

let holds = 0
const set = (on: boolean) => { try { host().call('app.keepScreenOn', { on }) } catch { /* sin puente */ } }
// Una página nueva (p. ej. tras un cierre del motor web) no hereda los pedidos de la anterior.
set(false)

/** Pide la pantalla encendida; devuelve la función que la libera (se puede llamar más de una vez). */
export function holdAwake(): () => void {
  if (getSettings().android?.keepAwake === false) return () => {}
  if (holds++ === 0) set(true)
  let done = false
  return () => {
    if (done) return
    done = true
    if (--holds === 0) set(false)
  }
}

/**
 * Proyecto abierto en el editor: la pantalla sigue encendida hasta 10 min sin tocar la tablet (Android la apagaba
 * a los 2 min mirando la vista previa o leyendo el chat). Los trabajos largos la piden aparte y no vencen.
 */
let editing = 0, idle = 0
let editRelease: (() => void) | null = null
function stillThere() {
  if (!editing) return
  if (!editRelease) editRelease = holdAwake()
  clearTimeout(idle)
  idle = window.setTimeout(() => { editRelease?.(); editRelease = null }, 10 * 60_000)
}
window.addEventListener('pointerdown', stillThere, true)
window.addEventListener('keydown', stillThere, true)

export function holdWhileEditing(): () => void {
  editing++
  stillThere()
  let done = false
  return () => {
    if (done) return
    done = true
    if (--editing === 0) { clearTimeout(idle); editRelease?.(); editRelease = null }
  }
}
