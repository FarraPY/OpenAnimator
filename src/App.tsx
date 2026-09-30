import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import Home from './pages/Home'
import Editor from './pages/Editor'
import SettingsPage from './pages/Settings'
import ChatPanel from './components/ChatPanel'
import { afterPaint, AppInfo, call, Settings, SettingsPatch } from './api'
import { Icon } from './ui/icons'
import { TooltipLayer } from './ui/kit'
import { isAndroid, recoveredBoot } from './platform'
import AndroidIntegration from './android/ui/Integration'

type ToastT = { id: number; text: string; kind: 'ok' | 'err' | 'info' }
type Route = { page: 'home' } | { page: 'editor'; id: string } | { page: 'settings'; section?: string; from?: Route }
type Ctx = {
  toast: (t: string, err?: boolean | 'ok' | 'info') => void
  info: AppInfo | null
  settings: Settings | null
  updateSettings: (patch: SettingsPatch) => Promise<void>
  go: (r: Route) => void
  route: Route
  refreshInfo: () => void
}
const AppCtx = createContext<Ctx>(null as any)
export const useApp = () => useContext(AppCtx)

export default function App() {
  const qs = new URLSearchParams(location.search)
  const initialOpen = qs.get('open')
  // Ventana de chat separada: ?chat=<proyecto>&session=<conversación>
  const chatWin = qs.get('chat') ? { project: qs.get('chat')!, session: qs.get('session') || '' } : null
  // Android reinició la página (su motor web se cerró, casi siempre por falta de memoria): se vuelve al
  // proyecto que estaba abierto.
  const recoveredTo = recoveredBoot && !initialOpen && !chatWin ? (() => { try { return localStorage.getItem('oa.openProject') || '' } catch { return '' } })() : ''
  const [route, setRoute] = useState<Route>(initialOpen ? { page: 'editor', id: initialOpen } : recoveredTo ? { page: 'editor', id: recoveredTo } : { page: 'home' })
  const [toasts, setToasts] = useState<ToastT[]>([])
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const seq = useRef(0)

  const toast = useCallback((text: string, kind: boolean | 'ok' | 'info' = false) => {
    const k: ToastT['kind'] = kind === true ? 'err' : kind === 'info' ? 'info' : 'ok'
    const id = ++seq.current
    setToasts((xs) => [...xs.slice(-3), { id, text, kind: k }])
    window.setTimeout(() => setToasts((xs) => xs.filter((x) => x.id !== id)), k === 'err' ? 8000 : 3800)
  }, [])

  const updateSettings = useCallback(async (patch: SettingsPatch) => {
    // Optimista: la interfaz cambia al instante y se guarda en segundo plano.
    setSettings((s) => {
      if (!s) return s
      const n: any = { ...s }
      for (const k of Object.keys(patch) as Array<keyof Settings>) n[k] = typeof (patch as any)[k] === 'object' && !Array.isArray((patch as any)[k]) && k !== 'export' ? { ...(s as any)[k], ...(patch as any)[k] } : (patch as any)[k]
      return n
    })
    try { setSettings(await call<Settings>('settings:set', patch)) } catch (e: any) { toast(e.message, true) }
  }, [toast])

  useEffect(() => {
    call<AppInfo>('app:info').then(setInfo).catch(() => {})
    call<Settings>('settings:get').then((s) => {
      setSettings(s)
      if (!initialOpen && !chatWin && !recoveredTo && s.ui.openLastProject && s.lastProject) setRoute({ page: 'editor', id: s.lastProject })
    })
    // El aviso (con lo que registró Android, si hay) lo da AndroidIntegration.
    if (recoveredBoot) history.replaceState(null, '', location.pathname)
  }, [])

  // Tema: acento, densidad y animaciones.
  useEffect(() => {
    const d = document.documentElement
    if (!settings) return
    d.dataset.accent = settings.ui.accent
    d.dataset.density = settings.ui.density
    if (settings.ui.reduceMotion) d.setAttribute('data-reduce-motion', ''); else d.removeAttribute('data-reduce-motion')
  }, [settings?.ui.accent, settings?.ui.density, settings?.ui.reduceMotion])

  const refreshInfo = useCallback(() => { call<AppInfo>('app:info').then(setInfo).catch(() => {}) }, [])
  const go = useCallback((r: Route) => {
    setRoute(r)
    // Después de pintar la pantalla nueva: guardar los ajustes escribe un archivo (en la tablet, sincrónico).
    if (r.page === 'editor') afterPaint(() => { call('settings:set', { lastProject: r.id }).catch(() => {}) })
    // Para volver acá si Android reinicia la página (en Ajustes se sigue recordando el proyecto de antes).
    if (r.page !== 'settings') try { localStorage.setItem('oa.openProject', r.page === 'editor' ? r.id : '') } catch { /* sin almacenamiento */ }
  }, [])

  return (
    <AppCtx.Provider value={{ toast, info, settings, updateSettings, go, route, refreshInfo }}>
      <div className={`app ${chatWin ? 'chat-window' : ''}`}>
        {chatWin ? <ChatPanel projectId={chatWin.project} windowMode attachTo={chatWin.session} visible
          context={async () => (await call('chat:getCtx', chatWin.project)) || { timeline: 'main', t: 0 }} />
          : route.page === 'editor' ? <Editor key={route.id} projectId={route.id} onClose={() => go({ page: 'home' })} />
          : route.page === 'settings' ? <SettingsPage section={route.section} onBack={() => go(route.from || { page: 'home' })} />
            : <Home onOpen={(id) => go({ page: 'editor', id })} />}
      </div>
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            <Icon name={t.kind === 'err' ? 'x-circle' : t.kind === 'info' ? 'info' : 'check-circle'} size={16} />
            <div className="grow" style={{ whiteSpace: 'pre-wrap', userSelect: 'text' }}>{t.text}</div>
            <button className="toast-x" onClick={() => setToasts((xs) => xs.filter((x) => x.id !== t.id))}><Icon name="x" size={14} /></button>
          </div>
        ))}
      </div>
      <TooltipLayer />
      {isAndroid() && <AndroidIntegration />}
    </AppCtx.Provider>
  )
}
