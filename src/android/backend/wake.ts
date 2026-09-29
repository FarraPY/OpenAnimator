/**
 * Pantalla encendida mientras dura un trabajo largo (un turno de Claude, una exportación): si se
 * apaga, Android pausa el WebView y el trabajo se corta. Cuenta los pedidos, así terminar uno no
 * apaga la pantalla mientras sigue el otro.
 */
import { host } from '../host'
import { getSettings } from './settings'

let holds = 0
const set = (on: boolean) => { try { host().call('app.keepScreenOn', { on }) } catch { /* sin puente */ } }

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
