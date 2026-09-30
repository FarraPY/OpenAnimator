/**
 * Whisper en la tablet (Ajustes › Plugins › Whisper): whisper.cpp compilado en Termux. Se elige el
 * modelo, se instala en una sesión visible de Termux (compila una vez y descarga el modelo) y se mide
 * la velocidad real con una muestra de voz.
 */
import { ReactNode, useEffect, useState } from 'react'
import { call } from '../../api'
import { useApp } from '../../App'
import { useDialogs } from '../../components/Dialogs'
import { Icon } from '../../ui/icons'
import { Badge, Button, Segmented, Spinner } from '../../ui/kit'

type Model = { id: string; label: string; mb: number; desc: string; installed: boolean }
type Info = {
  ready: boolean; detail: string; termux: { installed: boolean; permission: boolean }
  bin: boolean; version: string | null; cores: number; busy: boolean; active: string | null; models: Model[]
}

function Row({ label, desc, children }: { label: ReactNode; desc?: ReactNode; children?: ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-text"><div className="set-label">{label}</div>{desc && <div className="set-desc">{desc}</div>}</div>
      {children && <div className="set-ctrl">{children}</div>}
    </div>
  )
}

export function WhisperSetup({ onChanged }: { onChanged: () => void }) {
  const { settings: s, updateSettings: up, toast } = useApp()
  const dlg = useDialogs()
  const [info, setInfo] = useState<Info | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState<'install' | 'test' | 'remove' | null>(null)
  const [test, setTest] = useState<{ ok: boolean; msg: string } | null>(null)

  const refresh = () => call<Info>('whisper:status').then((i) => { setInfo(i); setErr(null); onChanged() }, (e) => setErr(e.message))
  useEffect(() => {
    refresh()
    // Al volver de Termux (terminó la instalación) se actualiza el estado.
    const onVis = () => { if (document.visibilityState === 'visible') refresh() }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])

  if (!info) return err
    ? <div className="plug-test-msg err" style={{ fontSize: 13 }}><Icon name="x-circle" size={15} />{err}</div>
    : <div className="row t3" style={{ padding: '10px 0' }}><Spinner />Revisando Whisper en Termux…</div>

  const cur = info.models.find((m) => m.id === s?.plugins.whisper.model) || info.models.find((m) => m.id === 'small') || info.models[0]
  const termuxOk = info.termux.installed && info.termux.permission

  const install = async () => {
    setBusy('install'); setTest(null)
    try { await call('whisper:install', cur.id); toast('Se abrió Termux: cuando diga «Listo», volvé acá') } catch (e: any) { toast(e.message, true) } finally { setBusy(null) }
  }
  const runTest = async () => {
    setBusy('test'); setTest(null)
    try { setTest({ ok: true, msg: await call<string>('whisper:test', cur.id) }) } catch (e: any) { setTest({ ok: false, msg: e.message }) } finally { setBusy(null) }
  }
  const remove = async (m: Model) => {
    if (!(await dlg.confirm({ title: `¿Borrar el modelo ${m.label}?`, message: `Libera unos ${m.mb} MB. Lo podés volver a descargar cuando quieras.`, ok: 'Borrar', danger: true }))) return
    setBusy('remove')
    try { setInfo(await call<Info>('whisper:remove', m.id)); onChanged(); toast(`Modelo ${m.label} borrado`) } catch (e: any) { toast(e.message, true) } finally { setBusy(null) }
  }

  return (
    <div className="set-card plug-opts">
      {!termuxOk && <div className="key-note" style={{ margin: 12 }}><Icon name="info" size={16} /><div>
        Whisper corre en <b>Termux</b>, igual que Claude con tu plan. Primero hacé los pasos 1 a 3 de <b>Ajustes › Claude › Con tu plan de Claude</b>: instalar Termux, prepararlo y darle permiso a OpenAnimator.
      </div></div>}

      <Row label="Modelo" desc={<>{cur.desc} Pesa unos {cur.mb} MB.</>}>
        <Segmented value={cur.id} onChange={(v) => { up({ plugins: { whisper: { model: v } } }); setTest(null); setTimeout(refresh, 120) }}
          options={info.models.map((m) => ({ value: m.id, label: m.label, icon: m.installed ? 'check' as const : undefined, tip: m.installed ? 'Descargado' : 'Sin descargar' }))} />
      </Row>

      <Row label={info.bin ? `whisper.cpp ${info.version || ''}` : 'Instalación'} desc={
        !info.bin ? 'La primera vez compila whisper.cpp en Termux (unos 5 a 10 minutos) y descarga el modelo. Se abre Termux para que veas el avance; cuando diga «Listo», volvé acá.'
          : cur.installed ? 'Listo para transcribir en la tablet, sin internet y sin costo.'
            : `Falta descargar ${cur.label} (${cur.mb} MB). Se abre Termux con la descarga.`}>
        {cur.installed && info.bin
          ? <Badge tone="ok" icon="check">Listo</Badge>
          : <Button variant="primary" icon="download" onClick={install} loading={busy === 'install'} disabled={!termuxOk}>{info.bin ? `Descargar ${cur.label}` : 'Instalar Whisper'}</Button>}
      </Row>

      {info.bin && <Row label="Velocidad en esta tablet" desc="Transcribe una muestra de voz de 11 segundos (en inglés) y mide cuánto tarda.">
        <Button icon="gauge" onClick={runTest} loading={busy === 'test'} disabled={!cur.installed || !!busy}>Probar</Button>
      </Row>}
      {test && <div className={`plug-test-msg ${test.ok ? 'ok' : 'err'}`} style={{ display: 'flex', padding: '0 16px 14px', fontSize: 13, lineHeight: 1.5 }}>
        <Icon name={test.ok ? 'check-circle' : 'x-circle'} size={15} style={{ flex: 'none', marginTop: 2 }} /><span>{test.msg}</span>
      </div>}

      {info.models.some((m) => m.installed) && <Row label="Modelos descargados" desc="Se pueden borrar para liberar espacio.">
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {info.models.filter((m) => m.installed).map((m) => (
            <Button key={m.id} size="sm" variant="ghost" icon="trash" onClick={() => remove(m)} disabled={!!busy}>{m.label}</Button>
          ))}
        </div>
      </Row>}

      {info.bin && !info.ready && info.detail && <div className="t3" style={{ padding: '0 16px 14px', fontSize: 12.5 }}>{info.detail}</div>}
      {err && <div className="plug-test-msg err" style={{ padding: '0 16px 14px', fontSize: 13 }}><Icon name="x-circle" size={15} />{err}</div>}
      {dlg.element}
    </div>
  )
}
