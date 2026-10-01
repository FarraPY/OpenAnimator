/**
 * Ajustes en el iPhone: listas agrupadas como las de iOS. Lo más importante es Claude: instalar Claude Code en el
 * teléfono (se baja de npm y se adapta acá mismo) y conectarlo a la cuenta del usuario con el token de
 * `claude setup-token` (usa su plan, no una clave de la API).
 */
import { ReactNode, useEffect, useState } from 'react'
import { call, EFFORTS, fmtSize, MODELS, on, Settings } from '../../api'
import { useApp } from '../../App'
import { useDialogs } from '../../components/Dialogs'
import PluginsSettings from '../../components/PluginsSettings'
import { Icon, Logo } from '../../ui/icons'
import { Button, Progress, Select, Spinner, Switch, TextArea, TextInput } from '../../ui/kit'
import { Chips, Group, Row, Tap, TopBar } from './PhoneApp'
import { isNative, nativeCall } from '../host/native'
import { logVerbose, setLogVerbose } from '../host/applog'

const SECTIONS: Record<string, string> = { ia: 'Claude', plugins: 'Plugins de IA', storage: 'Almacenamiento', debug: 'Depuración', about: 'Acerca de' }
const ACCENTS: Array<{ id: Settings['ui']['accent']; c: string }> = [
  { id: 'violet', c: '#7b6cff' }, { id: 'blue', c: '#3d8bff' }, { id: 'teal', c: '#14b3a7' }, { id: 'green', c: '#3bb46e' }, { id: 'amber', c: '#e3902b' }, { id: 'rose', c: '#e5537a' },
]
const PERMS = [
  { value: 'default', label: 'Preguntar siempre', desc: 'Pide permiso antes de cambiar archivos o usar plugins' },
  { value: 'acceptEdits', label: 'Aceptar ediciones', desc: 'Edita el proyecto sin preguntar; los plugins con costo, sí' },
  { value: 'plan', label: 'Planificar', desc: 'Sólo investiga y propone un plan' },
  { value: 'bypassPermissions', label: 'Sin preguntar', desc: 'Hace todo sin pedir permiso' },
]
type WebStatus = { installed: { version: string; installedAt: number; size: number } | null; token: string; installing: boolean }
type InstallProg = { phase: string; done: number; total: number }

export default function PhoneSettings({ section, onBack }: { section?: string; onBack: () => void }) {
  const [sec, setSec] = useState<string | null>(section && SECTIONS[section] ? section : null)
  const back = () => (sec && !section ? setSec(null) : onBack())
  return (
    <>
      <TopBar left={<Tap icon="chevron-left" label="Volver" onClick={back} />} title={sec ? SECTIONS[sec] : 'Ajustes'} />
      <div className="ph-scroll">
        {!sec ? <Main open={setSec} /> : sec === 'ia' ? <ClaudeSection /> : sec === 'plugins' ? <div className="ph-desk"><PluginsSettings /></div> : sec === 'storage' ? <StorageSection /> : sec === 'debug' ? <DebugSection /> : <AboutSection />}
      </div>
    </>
  )
}

function Main({ open }: { open: (s: string) => void }) {
  const { settings: s, updateSettings: up, info } = useApp()
  if (!s) return <div className="ph-center"><Spinner /></div>
  return (
    <>
      <h1 className="ph-title">Ajustes</h1>
      <Group>
        <Row icon="sparkles" label="Claude" detail={info?.claude ? 'Conectado · con tu plan' : 'Sin configurar'} chevron onClick={() => open('ia')} />
        <Row icon="plug" label="Plugins de IA" detail="Imágenes, voz, efectos, otras IA" chevron onClick={() => open('plugins')} />
        <Row icon="drive" label="Almacenamiento" detail="Espacio, papelera y caché" chevron onClick={() => open('storage')} />
      </Group>
      <Group title="Apariencia">
        <Row label="Color de acento">
          <div className="accents">{ACCENTS.map((a) => <button key={a.id} className={`accent-dot ${s.ui.accent === a.id ? 'on' : ''}`} style={{ background: a.c }} aria-label={a.id} onClick={() => up({ ui: { accent: a.id } })} />)}</div>
        </Row>
        <Row label="Reducir animaciones"><Switch checked={s.ui.reduceMotion} onChange={(v) => { up({ ui: { reduceMotion: v } }); if (v) document.documentElement.setAttribute('data-reduce-motion', ''); else document.documentElement.removeAttribute('data-reduce-motion') }} /></Row>
        <Row label="Preguntar antes de borrar"><Switch checked={s.ui.confirmDelete !== false} onChange={(v) => up({ ui: { confirmDelete: v } })} /></Row>
      </Group>
      <Group title="Editor">
        <Row label="Duración de las imágenes" detail="Al agregar una foto al timeline">
          <Chips value={s.editor.imageDuration || 5} onChange={(v) => up({ editor: { imageDuration: v } })} options={[3, 5, 8].map((x) => ({ value: x, label: `${x} s` }))} />
        </Row>
      </Group>
      <Group>
        {isNative() && <Row icon="terminal" label="Depuración" detail="Registro de la app y envío en vivo" chevron onClick={() => open('debug')} />}
        <Row icon="info" label="Acerca de OpenAnimator" chevron onClick={() => open('about')} />
      </Group>
    </>
  )
}

// ── Claude ─────────────────────────────────────────────────────────────────────
/** Un modelo según el Claude Code instalado (en inglés): `value` es lo que él entiende (opus, sonnet…, que siguen al más nuevo). */
type CodeModel = { value: string; resolvedModel?: string; displayName?: string; description?: string }
const TAGLINE: Record<string, string> = {
  opus: 'El más capaz: dirección artística y escenas complejas',
  sonnet: 'Rápido y muy capaz para el trabajo diario',
  haiku: 'El más rápido, para cambios chicos',
  fable: 'Lo más capaz, para lo más difícil y largo',
}
/** Los de Claude Code con nombres de acá («Opus 5.5»); un modelo nuevo aparece con lo que diga Claude Code. */
function modelOptions(list: CodeModel[]) {
  return list.map((m) => {
    const parts = String(m.description || '').split(' · ')
    const price = parts.find((x) => x.includes('$'))
    if (m.value === 'default') {
      const now = /\(currently ([^)]+)\)/.exec(m.description || '')?.[1]
      return { value: '', label: 'Recomendado', desc: now ? `El que elige Claude Code (hoy, ${now})` : 'El que elige Claude Code', hint: price }
    }
    const family = (m.resolvedModel || m.value).replace(/^claude-/, '').split('-')[0]
    const name = parts[0] && !parts[0].includes('$') ? parts[0] : m.displayName || m.value
    return { value: m.value, label: name, desc: TAGLINE[family] || parts.slice(1).filter((x) => !x.includes('$')).join(' · '), hint: price }
  })
}

function ClaudeSection() {
  const { settings: s, updateSettings: up, toast, refreshInfo } = useApp()
  const dlg = useDialogs()
  const [st, setSt] = useState<WebStatus | null>(null)
  const [prog, setProg] = useState<InstallProg | null>(null)
  const [latest, setLatest] = useState('')
  const [token, setToken] = useState('')
  const [editing, setEditing] = useState(false)
  const [test, setTest] = useState<{ busy?: boolean; ok?: boolean; msg?: string } | null>(null)
  const [logging, setLogging] = useState(false)
  const [models, setModels] = useState<CodeModel[] | null>(null)
  useEffect(() => { call<CodeModel[] | null>('claude:models').then(setModels).catch(() => {}); return on('claude:models', setModels) }, [])
  const refresh = () => call<WebStatus>('claude:webStatus').then((x) => { setSt(x); refreshInfo() }).catch((e) => toast(e.message, true))
  useEffect(() => {
    refresh()
    call<string>('claude:latest').then(setLatest).catch(() => {})
    return on('claude:installProgress', setProg)
  }, [])

  const install = async () => {
    setProg({ phase: 'buscando', done: 0, total: 1 })
    try { const m = await call('claude:install'); toast(`Claude Code ${m.version} instalado en el iPhone`); refresh() } catch (e: any) { toast(e.message, true) } finally { setProg(null) }
  }
  const saveToken = async (value = token) => {
    try { setSt(await call<WebStatus>('claude:setToken', value)); setToken(''); setEditing(false); refreshInfo(); if (value) runTest() } catch (e: any) { toast(e.message, true) }
  }
  // La página de Claude que abre iOS; al terminar vuelve sola a la app con la cuenta conectada.
  const signIn = async () => {
    setLogging(true)
    try { setSt(await call<WebStatus>('claude:login')); setEditing(false); refreshInfo(); toast('Cuenta de Claude conectada'); runTest() }
    catch (e: any) { toast(e.message, !/cancelaste/i.test(e.message)) }
    finally { setLogging(false) }
  }
  const paste = async () => { try { const v = (await navigator.clipboard.readText()).trim(); if (v) setToken(v) } catch { toast('No se pudo leer el portapapeles: pegalo a mano en el campo', true) } }
  const runTest = async () => {
    setTest({ busy: true })
    try { setTest({ ok: true, msg: await call<string>('claude:test') }) } catch (e: any) { setTest({ ok: false, msg: e.message }) }
  }
  if (!st || !s) return <div className="ph-center"><Spinner /></div>
  const c = s.claude
  const update = latest && st.installed && latest !== st.installed.version
  const pct = prog && prog.total ? (prog.done / prog.total) * 100 : 0
  const phase = !prog ? '' : prog.phase === 'descargando' ? `Descargando · ${fmtSize(prog.done)} de ${fmtSize(prog.total)}` : prog.phase === 'adaptando' ? `Preparando para el iPhone · ${prog.done} de ${prog.total}` : 'Buscando la última versión…'

  return (
    <>
      <div className="claude-hero">
        <span className="claude-hero-ic"><Icon name="sparkles" size={28} /></span>
        <div><b>Claude Code en tu iPhone</b><p>El Claude Code oficial corre dentro de OpenAnimator, en el teléfono, con tu plan de Claude (Pro o Max): sin PC, sin servidores y sin clave de la API.</p></div>
      </div>

      <Group title="1 · Claude Code" foot={!st.installed ? 'Se baja de npm (el paquete oficial de Anthropic, ~110 MB) y se adapta para Safari acá mismo. Hacelo con wifi.' : 'Queda guardado en el teléfono y funciona sin volver a bajarlo.'}>
        {prog ? (
          <div className="prow2 stack"><span className="row-main"><span className="row-label">{phase}</span><Progress value={pct} indeterminate={prog.phase === 'buscando'} /></span></div>
        ) : st.installed ? <>
          <Row icon="check-circle" label={`Instalado · ${st.installed.version}`} detail={`${new Date(st.installed.installedAt).toLocaleDateString()}`} />
          {update && <Row icon="download" label={`Actualizar a ${latest}`} chevron onClick={install} />}
          {isNative() && <Row label="Actualizar solo" detail="Con wifi o datos, cuando no estás usando a Claude; se prueba antes de usarla"><Switch checked={c.autoUpdate !== false} onChange={(v) => up({ claude: { autoUpdate: v } })} /></Row>}
        </> : <Row icon="download" label="Instalar Claude Code" detail={latest ? `Versión ${latest}` : undefined} chevron onClick={install} />}
      </Group>

      <Group title="2 · Tu cuenta de Claude" foot={isNative()
        ? <>Se abre la página de Claude, entrás con tu cuenta y volvés sola a la app. Usa tu plan, no una clave de la API: el token dura un año y queda cifrado en el iPhone. También podés pegar el de <code>claude setup-token</code>.</>
        : <>En una computadora (o en la tablet, en Termux) con Claude Code, corré <code>claude setup-token</code>, iniciá sesión y copiá el token que aparece (empieza con <code>sk-ant-oat</code>; dura un año). No es una clave de la API: usa tu plan. Se guarda cifrado en el iPhone.</>}>
        {isNative() && (!st.token || editing) && (
          <div className="prow2 stack">
            <Button variant="primary" icon="key" loading={logging} disabled={logging || !st.installed} onClick={signIn}>
              {logging ? 'Esperando que inicies sesión…' : 'Iniciar sesión con Claude'}
            </Button>
          </div>
        )}
        {st.token && !editing ? <>
          <Row icon="key" label="Cuenta conectada" detail={st.token} />
          <Row icon="edit" label={isNative() ? 'Cambiar de cuenta' : 'Cambiar el token'} chevron onClick={() => setEditing(true)} />
          <Row icon="trash" label="Desconectar" danger onClick={async () => { if (await dlg.confirm({ title: '¿Desconectar tu cuenta?', message: 'Se borra el token del iPhone. Claude deja de funcionar hasta que pegues otro.', ok: 'Desconectar', danger: true })) saveToken('') }} />
        </> : (
          <div className="prow2 stack">
            <span className="row-main">
              <TextInput value={token} onChange={setToken} placeholder="sk-ant-oat01-…" mono type="password" onEnter={() => token && saveToken()} />
              <span className="row gap8 mt8">
                <Button icon="copy" onClick={paste}>Pegar</Button>
                <div className="grow" />
                {st.token && <Button variant="ghost" onClick={() => { setEditing(false); setToken('') }}>Cancelar</Button>}
                <Button variant="primary" icon="check" disabled={!token.trim()} onClick={() => saveToken()}>Guardar</Button>
              </span>
            </span>
          </div>
        )}
        {!isNative() && <Row icon="copy" label="Copiar el comando" detail="claude setup-token" onClick={() => call('clipboard:text', 'claude setup-token').then(() => toast('Comando copiado'))} />}
      </Group>

      <Group title="3 · Probar">
        <Row icon={test?.ok ? 'check-circle' : test?.ok === false ? 'x-circle' : 'zap'} label={test?.busy ? 'Probando… (Claude Code arranca y responde con Haiku)' : 'Probar la conexión'} detail={test?.msg}
          onClick={test?.busy || !st.installed ? undefined : runTest}>{test?.busy && <Spinner />}</Row>
      </Group>

      <Group title="Cómo trabaja Claude">
        <Row label="Modelo" stack><Select value={models ? (models.some((m) => m.value === c.model) ? c.model : models.find((m) => m.resolvedModel === c.model)?.value ?? c.model) : c.model}
          onChange={(v) => up({ claude: { model: String(v) } })}
          options={models ? modelOptions(models) : MODELS.map((m) => ({ value: m.id, label: m.name, desc: m.desc, hint: m.note }))} /></Row>
        <Row label="Esfuerzo" stack><Select value={c.effort} onChange={(v) => up({ claude: { effort: v as any } })} options={EFFORTS.map((e) => ({ value: e.id, label: e.name, desc: e.desc }))} /></Row>
        <Row label="Permisos" stack><Select value={c.permissionMode} onChange={(v) => up({ claude: { permissionMode: v as any } })} options={PERMS} /></Row>
        <Row label="Modo ahorro" detail="Imágenes más chicas, menos relecturas, respuestas cortas: rinde más tu límite de uso"><Switch checked={c.saver !== false} onChange={(v) => up({ claude: { saver: v } })} /></Row>
        <Row label="Mostrar el razonamiento"><Switch checked={c.showThinking !== false} onChange={(v) => up({ claude: { showThinking: v } })} /></Row>
        <Row label="Retomar la última conversación" detail="Al abrir un proyecto"><Switch checked={c.continueChat !== false} onChange={(v) => up({ claude: { continueChat: v } })} /></Row>
        <Row label="Instrucciones para Claude" detail="Se agregan a todas las conversaciones nuevas" stack><TextArea value={c.extraInstructions || ''} onChange={(v) => up({ claude: { extraInstructions: v } })} rows={3} /></Row>
      </Group>
      {dlg.element}
    </>
  )
}

// ── almacenamiento ─────────────────────────────────────────────────────────────
function StorageSection() {
  const { toast } = useApp()
  const dlg = useDialogs()
  const [info, setInfo] = useState<{ internal: { free: number; total: number; projects: number } } | null>(null)
  const [trash, setTrash] = useState<Array<{ id: string; name: string; size: number; deletedAt?: string }> | null>(null)
  const [cache, setCache] = useState<{ export: number; peaks: number; thumbs: number } | null>(null)
  const load = () => {
    call('storage:info').then(setInfo).catch(() => {})
    call('trash:list').then(setTrash).catch(() => setTrash([]))
    call('cache:stats').then(setCache).catch(() => {})
  }
  useEffect(load, [])
  const used = info ? info.internal.total - info.internal.free : 0
  return (
    <>
      <Group title="Espacio" foot="Safari guarda todo dentro de la app (proyectos, medios, videos exportados y Claude Code). Con la app en la pantalla de inicio, iOS no lo borra solo.">
        <Row icon="drive" label={info ? `${fmtSize(used)} usados` : 'Calculando…'} detail={info ? `${fmtSize(info.internal.free)} libres para OpenAnimator · ${info.internal.projects} proyectos` : undefined} />
        {cache && <Row icon="refresh" label="Vaciar la caché" detail={`Miniaturas y formas de onda: ${fmtSize((cache.peaks || 0) + (cache.thumbs || 0))}`} onClick={async () => { await call('cache:clear', 'peaks'); await call('cache:clear', 'thumbs'); toast('Caché vacía'); load() }} />}
      </Group>
      <Group title="Papelera" foot="Lo borrado se guarda 30 días.">
        {!trash ? <Row label="Cargando…" /> : !trash.length ? <Row label="Vacía" /> : trash.map((x) => (
          <Row key={x.id} icon="trash2" label={x.name} detail={fmtSize(x.size)}>
            <Button size="sm" onClick={async () => { await call('trash:restore', x.id); toast('Recuperado'); load() }}>Recuperar</Button>
          </Row>
        ))}
        {!!trash?.length && <Row icon="trash" label="Vaciar la papelera" danger onClick={async () => { if (await dlg.confirm({ title: '¿Vaciar la papelera?', message: 'Se borra para siempre.', ok: 'Vaciar', danger: true })) { await call('trash:empty'); load() } }} />}
      </Group>
      {dlg.element}
    </>
  )
}

// ── Depuración ─────────────────────────────────────────────────────────────────
type LogStatus = { remote?: string; sentAt?: number; error?: string; pending: number; size: number }

/** El registro de la app (ios/OpenAnimator/AppLog.swift): verlo, compartirlo y mandarlo en vivo a la computadora. */
function DebugSection() {
  const { toast } = useApp()
  const [st, setSt] = useState<LogStatus | null>(null)
  const [url, setUrl] = useState('')
  const [tail, setTail] = useState<string | null>(null)
  const [verbose, setVerbose] = useState(logVerbose())
  const refresh = () => nativeCall<LogStatus>('log.status').then((x) => { setSt(x); setUrl((u) => u || x.remote || '') }).catch(() => {})
  useEffect(() => { refresh(); const t = setInterval(refresh, 2000); return () => clearInterval(t) }, [])
  const live = async (on: boolean) => {
    try { setSt(await nativeCall<LogStatus>('log.remote', { url: on ? url.trim() : '' })); toast(on ? 'Registro en vivo encendido' : 'Registro en vivo apagado') } catch (e: any) { toast(e.message, true) }
  }
  const view = async () => {
    try {
      const r = await fetch('/fs/logs/app.log', { cache: 'no-store' })
      setTail(r.ok ? (await r.text()).trimEnd().split('\n').slice(-400).join('\n') : 'Todavía no hay nada en el registro.')
    } catch (e: any) { toast(e.message, true) }
  }
  if (!st) return <div className="ph-center"><Spinner /></div>
  const ago = st.sentAt ? Math.max(0, Math.round((Date.now() - st.sentAt) / 1000)) : null
  const state = !st.remote ? 'Apagado' : st.error ? `Sin conexión: ${st.error}` : ago != null ? `Enviando · lo último hace ${ago} s` : 'Conectando…'
  return (
    <>
      <Group title="Registro de la app" foot="Errores, avisos, lo que hace Claude y cada exportación (con su velocidad y el informe), más lo del sistema: falta de memoria, cierres, temperatura. Queda en el iPhone (Archivos › OpenAnimator › logs) y nunca guarda tus claves.">
        <Row icon="file" label="Ver lo último" chevron onClick={view} />
        <Row icon="share" label="Compartir el registro" detail={fmtSize(st.size)} chevron onClick={() => nativeCall('share', { path: 'logs/app.log' }).catch((e) => toast(e.message, true))} />
        <Row label="Registro detallado" detail="También todo lo que la app escribe en la consola"><Switch checked={verbose} onChange={(v) => { setVerbose(v); setLogVerbose(v) }} /></Row>
      </Group>
      <Group title="En vivo a tu computadora" foot={<>Con el iPhone y la computadora en la misma red wifi: en la computadora corré <code>node scripts/registro-remoto.mjs</code> (o pedíselo a Claude Code) y pegá acá la dirección que muestra. Cada línea llega al instante; si se corta, se guarda y se manda después.</>}>
        <div className="prow2 stack">
          <span className="row-main">
            <TextInput value={url} onChange={setUrl} placeholder="http://192.168.0.10:8799/k/…" mono />
            <span className="row gap8 mt8">
              <span className="grow t3">{state}</span>
              {st.remote ? <Button onClick={() => live(false)}>Apagar</Button>
                : <Button variant="primary" icon="send" disabled={!/^https?:\/\/\S+/.test(url.trim())} onClick={() => live(true)}>Encender</Button>}
            </span>
          </span>
        </div>
      </Group>
      {tail != null && <Group title="Lo último"><div className="prow2"><pre className="viewer-text" style={{ maxHeight: '60vh', overflow: 'auto', fontSize: 11 }}>{tail}</pre></div></Group>}
    </>
  )
}

function AboutSection() {
  const { info } = useApp()
  const line = (k: string, v: ReactNode) => <Row label={k} detail={v} />
  const d = (info as any)?.device
  return (
    <>
      <div className="about-hero"><Logo size={56} /><b>OpenAnimator</b><span className="t3">Versión {info?.version}</span></div>
      <Group title="Este equipo">
        {line('Equipo', d ? `${d.model} · iOS ${d.release}` : '—')}
        {line('Motor web', d?.webview || '—')}
        {line('Video', (info as any)?.codecs ? `H.264${(info as any).codecs.hevc ? ' · HEVC' : ''} por hardware (WebCodecs)` : '—')}
      </Group>
      <Group title="Cómo funciona" foot="Claude Code (de Anthropic) lo baja el propio iPhone desde npm; OpenAnimator no lo incluye ni lo modifica en sus servidores. Bibliotecas libres: Mediabunny (MPL-2.0), modern-screenshot, memfs, fflate, acorn, es-module-lexer (MIT).">
        {line('Escenas', 'HTML, SVG y JavaScript en función del tiempo')}
        {line('Exportación', 'Cada fotograma se dibuja y va al codificador de hardware')}
        {line('Tus datos', 'Todo queda en el iPhone')}
      </Group>
    </>
  )
}

