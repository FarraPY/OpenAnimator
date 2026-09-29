/**
 * Claude con el plan del usuario en la tablet: Claude Code corre en Termux y OpenAnimator lo maneja.
 * Asistente de configuración con el estado real de cada paso (Termux, preparación, permiso, sesión).
 */
import { ReactNode, useEffect, useState } from 'react'
import { call } from '../../api'
import { useApp } from '../../App'
import { Icon } from '../../ui/icons'
import { Badge, Button, Spinner } from '../../ui/kit'

type TermuxSt = { installed: boolean; version?: string; store?: string; permission: boolean; command: string }
type BridgeSt = {
  version: number; node: string
  claude: { path: string; version: string | null; error?: string } | null
  auth: { loggedIn: boolean; method: string; provider: string } | null
}

function Step({ n, done, title, children }: { n: number; done?: boolean; title: ReactNode; children?: ReactNode }) {
  return (
    <div className={`tx-step ${done ? 'done' : ''}`}>
      <span className="tx-num">{done ? <Icon name="check" size={16} /> : n}</span>
      <div className="tx-body">
        <div className="tx-title">{title}</div>
        {children}
      </div>
    </div>
  )
}

export function TermuxSetup() {
  const { toast, refreshInfo } = useApp()
  const [st, setSt] = useState<TermuxSt | null>(null)
  const [bridge, setBridge] = useState<BridgeSt | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [checking, setChecking] = useState(false)
  const [denied, setDenied] = useState(false)

  const refresh = () => call<TermuxSt>('termux:status').then((s) => { setSt(s); refreshInfo() }).catch(() => {})
  useEffect(() => {
    refresh()
    // Al volver de Termux o de los ajustes de Android, se actualiza el estado.
    const onVis = () => { if (document.visibilityState === 'visible') refresh() }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])

  const check = async () => {
    setChecking(true); setMsg(null)
    try {
      const b = await call<BridgeSt>('termux:check')
      setBridge(b)
      setMsg({ ok: true, text: await call<string>('claude:test') })
    } catch (e: any) { setMsg({ ok: false, text: e.message }) } finally { setChecking(false) }
  }
  const permit = async () => {
    const ok = await call<boolean>('termux:permission').catch(() => false)
    setDenied(!ok)
    await refresh()
    if (ok) toast('Permiso concedido')
  }
  const copy = async () => { await call('clipboard:text', st?.command || ''); toast('Comando copiado: pegalo en Termux') }

  if (!st) return <div className="row t3" style={{ padding: 20 }}><Spinner />Revisando Termux…</div>
  const ready = !!bridge?.claude && !!bridge.auth?.loggedIn
  const play = st.store === 'com.android.vending'

  return (
    <div className="tx-steps">
      <Step n={1} done={st.installed} title={st.installed ? `Termux ${st.version || ''} instalado` : 'Instalá Termux'}>
        <div className="tx-desc">
          {st.installed
            ? (play ? 'Es la versión de Google Play (experimental). Si algo falla, instalá la de F-Droid.' : 'Es la terminal Linux donde va a correr Claude Code.')
            : 'Termux es una app gratuita que trae una terminal Linux: ahí corre Claude Code. Conviene la versión de F-Droid o la de GitHub (la de Google Play es experimental).'}
        </div>
        {!st.installed && <div className="tx-actions">
          <Button variant="primary" icon="download" onClick={() => call('shell:openExternal', 'https://f-droid.org/packages/com.termux/')}>Descargar de F-Droid</Button>
          <Button icon="external" onClick={() => call('shell:openExternal', 'https://github.com/termux/termux-app/releases')}>GitHub</Button>
        </div>}
      </Step>

      <Step n={2} done={!!bridge?.claude} title="Prepará Termux (una sola vez)">
        <div className="tx-desc">Copiá este comando, pegalo en Termux y esperá a que diga «Listo». Instala Node.js y Claude Code (con el instalador de la comunidad: unos 250 MB) y deja que OpenAnimator le mande comandos a Termux.</div>
        <pre className="tx-cmd">{st.command}</pre>
        <div className="tx-actions">
          <Button variant="primary" icon="copy" onClick={copy} disabled={!st.installed}>Copiar comando</Button>
          <Button icon="terminal" onClick={() => call('termux:open')} disabled={!st.installed}>Abrir Termux</Button>
        </div>
      </Step>

      <Step n={3} done={st.permission} title="Dale permiso a OpenAnimator">
        <div className="tx-desc">Para que la app pueda arrancar Claude Code en Termux (Android lo llama «ejecutar comandos en Termux»).</div>
        {!st.permission && <div className="tx-actions">
          <Button variant="primary" icon="shield" onClick={permit} disabled={!st.installed}>Permitir</Button>
          {denied && <Button icon="settings" onClick={() => call('app:openSettings')}>Abrir ajustes de la app</Button>}
        </div>}
        {denied && !st.permission && <div className="tx-desc warn">Android no mostró el permiso. Abrí los ajustes de OpenAnimator › Permisos › Permisos adicionales y activá el de Termux.</div>}
      </Step>

      <Step n={4} done={!!bridge?.auth?.loggedIn} title="Iniciá sesión en Claude con tu plan">
        <div className="tx-desc">Se abre Termux con el inicio de sesión de Claude Code: seguí el enlace, entrá con tu cuenta de Claude y volvé acá. La sesión queda en Termux; OpenAnimator nunca la ve.</div>
        <div className="tx-actions">
          <Button icon="key" onClick={() => call('termux:login').catch((e: any) => toast(e.message, true))} disabled={!st.permission}>Iniciar sesión en Claude</Button>
        </div>
      </Step>

      <Step n={5} done={ready} title="Probá la conexión">
        <div className="tx-actions">
          <Button variant={ready ? 'secondary' : 'primary'} icon="zap" onClick={check} loading={checking} disabled={!st.permission}>Probar</Button>
          {ready && <Badge tone="ok" icon="check">Listo para usar</Badge>}
        </div>
        {msg && <div className={`plug-test-msg ${msg.ok ? 'ok' : 'err'}`} style={{ fontSize: 14 }}><Icon name={msg.ok ? 'check-circle' : 'x-circle'} size={16} />{msg.text}</div>}
      </Step>

      <div className="key-note"><Icon name="info" size={16} /><div>
        Claude Code no tiene versión oficial para Android: corre en Termux con un instalador de la comunidad, así que una actualización puede romperlo por un tiempo. Para que Android no lo cierre: en <b>Ajustes › Batería</b>, dejá Termux y OpenAnimator sin restricciones, y en <b>Opciones de desarrollador</b> activá «Desactivar restricciones de procesos secundarios».
      </div></div>
    </div>
  )
}
