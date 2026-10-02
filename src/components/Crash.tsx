import { Component, ReactNode } from 'react'
import { Icon } from '../ui/icons'

/**
 * Si una pantalla falla al dibujarse, React desmonta todo y queda la ventana vacía (en el iPhone, sólo el fondo azul,
 * hasta cerrar la app). Esto atrapa el error, lo deja en la consola (en el teléfono y la tablet va al registro de la
 * app) y muestra qué pasó con «Reintentar» y «Volver al inicio». `resetKey`: al cambiar de pantalla se vuelve a probar.
 */
export default class Crash extends Component<{ children: ReactNode; resetKey: string; onHome: () => void }, { error: Error | null; key: string }> {
  state = { error: null as Error | null, key: this.props.resetKey }
  static getDerivedStateFromError(error: Error) { return { error } }
  static getDerivedStateFromProps(p: { resetKey: string }, s: { error: Error | null; key: string }) {
    return p.resetKey !== s.key ? { error: null, key: p.resetKey } : null
  }
  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error('Falló la pantalla:', error?.stack || error, (info.componentStack || '').split('\n').slice(0, 8).join('\n'))
  }
  render() {
    const e = this.state.error
    if (!e) return this.props.children
    return (
      <div className="crash">
        <Icon name="alert" size={30} />
        <h2>Algo falló al mostrar esta pantalla</h2>
        <p className="t3">Quedó anotado en el registro de la app. {String(e.message || e).slice(0, 300)}</p>
        <div className="row" style={{ gap: 10, justifyContent: 'center' }}>
          <button className="b b-secondary b-md" onClick={() => this.setState({ error: null })}>Reintentar</button>
          <button className="b b-primary b-md" onClick={() => { this.setState({ error: null }); this.props.onHome() }}>Volver al inicio</button>
        </div>
      </div>
    )
  }
}
