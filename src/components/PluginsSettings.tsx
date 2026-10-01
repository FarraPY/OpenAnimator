import { ReactNode, useEffect, useRef, useState } from 'react'
import { WhisperSetup } from '../android/ui/WhisperSetup'
import { call, on, PluginId, PluginStatus, Voice } from '../api'
import { useApp } from '../App'
import { isAndroid, isIphone } from '../platform'
import { Icon, IconName } from '../ui/icons'
import { Badge, Button, NumberInput, Progress, Select, Slider, Spinner, Switch, TextInput } from '../ui/kit'

const CAP: Record<string, { label: string; icon: IconName }> = {
  image: { label: 'Imágenes', icon: 'image' }, voice: { label: 'Voz', icon: 'mic' }, sfx: { label: 'Efectos', icon: 'wave' },
  ask: { label: 'Consultas', icon: 'message' }, transcribe: { label: 'Transcripción', icon: 'story' }, download: { label: 'YouTube', icon: 'youtube' },
}
const META: Record<PluginId, { color: string; mark: string; desc: string; keyUrl?: string; keyHint?: string; site?: string }> = {
  codex: { color: '#10a37f', mark: 'GPT', desc: 'Usa tu cuenta de ChatGPT a través de Codex CLI: Claude le puede pedir imágenes (el generador de imágenes de ChatGPT) y segundas opiniones, sin clave de API ni costo extra fuera de tu plan.', site: 'https://developers.openai.com/codex/cli' },
  openai: { color: '#6e7bff', mark: 'AI', desc: 'API de OpenAI con clave propia: imágenes gpt-image, consultas a modelos GPT y transcripción con tiempos por palabra (Whisper). Se cobra por uso.', keyUrl: 'https://platform.openai.com/api-keys', keyHint: 'sk-…' },
  gemini: { color: '#3d8bff', mark: 'G', desc: 'Google Gemini: consultas (texto e imágenes) y generación de imágenes. Tiene cuota gratuita.', keyUrl: 'https://aistudio.google.com/apikey', keyHint: 'AIza…' },
  openrouter: { color: '#8a63d2', mark: 'OR', desc: 'Una sola clave para cientos de modelos (GPT, Gemini, Llama, Mistral, DeepSeek…) para consultas.', keyUrl: 'https://openrouter.ai/keys', keyHint: 'sk-or-…' },
  elevenlabs: { color: '#e5e7eb', mark: 'XI', desc: 'Voces realistas con tiempos por palabra (sincronización automática), efectos de sonido a partir de texto y transcripción.', keyUrl: 'https://elevenlabs.io/app/settings/api-keys', keyHint: 'sk_…' },
  fish: { color: '#28b8e6', mark: 'FA', desc: 'Fish Audio S2.1 Pro: voces muy naturales en 83 idiomas, con dirección en lenguaje natural ([susurrando], [emocionado], pausas…) y diálogos de varias voces. El modelo S2.1 Pro Free es GRATIS con tu clave (uso justo, hasta el 30/11/2026; los pedidos pueden usarse para mejorar el modelo). También transcribe.', keyUrl: 'https://fish.audio/app/api-keys', keyHint: 'clave de Fish Audio' },
  whisper: { color: '#f5a524', mark: 'W', desc: 'Whisper de OpenAI corriendo en tu propia PC (con la GPU si hay CUDA): transcripción con tiempos por palabra, gratis, sin clave y sin enviar el audio a internet. Usa Python con torch y transformers y los modelos que ya estén descargados en la caché de Hugging Face. Es la opción preferida para transcribir.', site: 'https://huggingface.co/openai/whisper-large-v3-turbo' },
  ytdlp: { color: '#ff4e45', mark: 'YT', desc: 'Descarga videos de YouTube (y otros sitios) para analizarlos con la herramienta de plantillas. Programa libre y oficial.', site: 'https://github.com/yt-dlp/yt-dlp' },
}
const WHISPER_TABLET = 'Whisper de OpenAI corriendo en la propia tablet con whisper.cpp (en Termux): transcripción con tiempos por palabra, gratis, sin clave y sin enviar el audio a internet. Es más lento que en la PC, pero sirve para sincronizar las animaciones con la narración. Es la opción preferida para transcribir.'

function Row({ label, desc, children, stack }: { label: ReactNode; desc?: ReactNode; children?: ReactNode; stack?: boolean }) {
  return (
    <div className={`set-row ${stack ? 'stack' : ''}`}>
      <div className="set-text"><div className="set-label">{label}</div>{desc && <div className="set-desc">{desc}</div>}</div>
      {children && <div className="set-ctrl">{children}</div>}
    </div>
  )
}

export default function PluginsSettings() {
  const { settings: s, updateSettings: up, toast } = useApp()
  const [st, setSt] = useState<PluginStatus[] | null>(null)
  const [open, setOpen] = useState<PluginId | null>(null)
  const refresh = (force = false) => call<PluginStatus[]>('plugins:status', force).then(setSt).catch((e) => toast(e.message, true))
  useEffect(() => { refresh(true) }, [])
  if (!s) return null
  const P = s.plugins
  const ready = (id: string) => !!st?.find((x) => x.id === id)?.ready
  const provSel = (cap: 'image' | 'voice' | 'ask' | 'transcribe', ids: PluginId[]) => (
    <Select value={P[cap] as string} width={250} menuWidth={300} onChange={(v) => up({ plugins: { [cap]: v } as any })}
      options={[{ value: 'auto', label: 'Automático', desc: 'El primero que esté listo' }, ...ids.map((id) => ({ value: id, label: st?.find((x) => x.id === id)?.name || id, desc: ready(id) ? 'Listo' : 'Sin configurar', icon: (ready(id) ? 'check-circle' : 'dot') as IconName }))]} />
  )
  const readyCount = st?.filter((x) => x.ready).length ?? 0

  return (
    <>
      <div className="plug-hero">
        <div className="plug-hero-icon"><Icon name="plug" size={22} /></div>
        <div className="grow">
          <div style={{ font: '600 15px var(--font-display)' }}>Otros modelos y servicios para Claude</div>
          <div className="t3" style={{ marginTop: 3, lineHeight: 1.5 }}>Con un plugin listo, Claude puede generar imágenes, narraciones y efectos de sonido, transcribir voces o pedirle una segunda opinión a otro modelo mientras arma tu video. Las claves se guardan <b className="t2">cifradas en {isAndroid() ? 'la tablet' : isIphone() ? 'el iPhone' : 'esta PC'}</b> y nunca se muestran completas.</div>
        </div>
        <Badge tone={readyCount ? 'ok' : 'neutral'} icon={readyCount ? 'check' : undefined}>{st ? `${readyCount} listo${readyCount === 1 ? '' : 's'}` : '…'}</Badge>
      </div>

      <section className="set-group">
        <h3 className="set-group-title"><Icon name="sliders" size={15} style={{ color: 'var(--t3)' }} />Qué usar para cada cosa</h3>
        <div className="set-card">
          <Row label="Imágenes" desc="Cuando Claude necesita una ilustración, fondo, ícono o foto.">{provSel('image', ['codex', 'openai', 'gemini'])}</Row>
          <Row label="Voz" desc="Narraciones del guion.">{provSel('voice', ['elevenlabs', 'fish'])}</Row>
          <Row label="Consultas" desc="Segunda opinión de otro modelo.">{provSel('ask', ['codex', 'openai', 'gemini', 'openrouter'])}</Row>
          <Row label="Transcripción" desc="Tiempos por palabra de una voz grabada y análisis de videos.">{provSel('transcribe', ['whisper', 'elevenlabs', 'openai', 'fish'])}</Row>
        </div>
      </section>

      <section className="set-group">
        <h3 className="set-group-title"><Icon name="plug" size={15} style={{ color: 'var(--t3)' }} />Plugins<div className="grow" /><Button size="xs" variant="ghost" icon="refresh" onClick={() => refresh(true)}>Actualizar</Button></h3>
        <div className="plug-list">
          {!st && <div className="row t3" style={{ padding: 16 }}><Spinner />Revisando plugins…</div>}
          {st?.map((p) => <PluginCard key={p.id} p={p} open={open === p.id} onToggle={() => setOpen(open === p.id ? null : p.id)} onChanged={() => refresh(true)} />)}
        </div>
      </section>
    </>
  )
}

function PluginCard({ p, open, onToggle, onChanged }: { p: PluginStatus; open: boolean; onToggle: () => void; onChanged: () => void }) {
  const { settings: s, updateSettings: up, toast } = useApp()
  const m = META[p.id]
  const [key, setKey] = useState('')
  const [show, setShow] = useState(false)
  const [test, setTest] = useState<{ busy?: boolean; ok?: boolean; msg?: string } | null>(null)
  const [install, setInstall] = useState<number | null>(null)
  const P = s!.plugins as any
  const cfg = P[p.id] || {}
  const enabledSw = p.id !== 'ytdlp'
  // En la tablet Whisper se instala en Termux y trae su propia prueba (velocidad con una muestra de voz).
  const tabletWhisper = p.id === 'whisper' && isAndroid()

  useEffect(() => on('plugins:progress', (e: { id: string; p: number }) => { if (e.id === p.id) setInstall(e.p) }), [p.id])

  const runTest = async () => {
    setTest({ busy: true })
    try { setTest({ ok: true, msg: await call('plugins:test', p.id) }) } catch (e: any) { setTest({ ok: false, msg: e.message }) }
  }
  const saveKey = async () => {
    if (!key.trim()) return
    await call('plugins:setKey', p.id, key.trim()); setKey(''); setShow(false); onChanged(); toast(`Clave de ${p.name} guardada`)
    setTimeout(runTest, 50)
  }
  const removeKey = async () => { await call('plugins:setKey', p.id, ''); setTest(null); onChanged(); toast('Clave quitada') }
  const doInstall = async () => {
    setInstall(0)
    try { await call('plugins:installYtdlp'); toast('yt-dlp instalado'); onChanged(); runTest() } catch (e: any) { toast(e.message, true) } finally { setInstall(null) }
  }

  const state = !p.enabled ? { tone: 'neutral' as const, text: 'Desactivado' } : p.ready ? { tone: 'ok' as const, text: 'Listo' } : { tone: 'warn' as const, text: p.needsKey ? 'Falta la clave' : p.id === 'codex' ? 'Sin sesión' : p.id === 'whisper' && !tabletWhisper ? 'No disponible' : 'No instalado' }
  return (
    <div className={`plug-card ${open ? 'open' : ''} ${p.ready ? 'ready' : ''}`}>
      <div className="plug-head" onClick={onToggle}>
        <div className="plug-mark" style={{ ['--pc' as any]: m.color }}>{m.mark}</div>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 8 }}><span className="plug-name">{p.name}</span><Badge tone={state.tone} icon={p.ready ? 'check' : undefined}>{state.text}</Badge></div>
          <div className="plug-caps">{p.caps.map((c) => <span key={c} className="plug-cap"><Icon name={CAP[c].icon} size={11.5} />{CAP[c].label}</span>)}</div>
        </div>
        {enabledSw && <span onClick={(e) => e.stopPropagation()}><Switch checked={p.enabled} onChange={(v) => { up({ plugins: { [p.id]: { enabled: v } } as any }); setTimeout(onChanged, 80) }} /></span>}
        <Icon name="chevron-down" size={15} className="plug-chev" />
      </div>
      {open && (
        <div className="plug-body">
          <p className="plug-desc">{tabletWhisper ? WHISPER_TABLET : m.desc}</p>

          {p.needsKey && (
            <div className="plug-key">
              <div className="grow">
                <TextInput type={show ? 'text' : 'password'} mono icon="key" value={key} onChange={setKey} onEnter={saveKey}
                  placeholder={p.masked ? `Clave guardada ${p.masked} · pegá otra para reemplazarla` : `Pegá tu clave (${m.keyHint})`}
                  suffix={key ? <button type="button" className="input-clear" data-tip={show ? 'Ocultar' : 'Mostrar'} onClick={() => setShow(!show)}><Icon name={show ? 'eye-off' : 'eye'} size={13} /></button> : undefined} />
              </div>
              <Button variant="primary" icon="check" onClick={saveKey} disabled={!key.trim()}>Guardar</Button>
              {p.masked && <Button variant="ghost" icon="trash" tip="Quitar la clave" onClick={removeKey} />}
            </div>
          )}

          {p.id === 'codex' && (
            <div className="plug-key">
              <div className="grow t2" style={{ fontSize: 12.5 }}>{p.detail}</div>
              {!p.ready && <Button icon="terminal" onClick={() => call('plugins:loginCodex')}>{/no está instalado/i.test(p.detail) ? 'Instalar Codex' : 'Iniciar sesión'}</Button>}
            </div>
          )}
          {p.id === 'whisper' && !tabletWhisper && (
            <div className="plug-key"><div className="grow t2" style={{ fontSize: 12.5 }}>{p.detail}</div></div>
          )}
          {p.id === 'ytdlp' && (
            <div className="plug-key">
              <div className="grow t2 mono ellipsis" style={{ fontSize: 12 }}>{p.ready ? p.detail : 'Se descarga el ejecutable oficial (≈18 MB) desde github.com/yt-dlp a la carpeta data/tools.'}</div>
              {install != null ? <div style={{ width: 160 }}><Progress value={install} /></div>
                : <Button variant={p.ready ? 'secondary' : 'primary'} icon="download" onClick={doInstall}>{p.ready ? 'Actualizar' : 'Instalar'}</Button>}
            </div>
          )}

          {!tabletWhisper && <div className="plug-test">
            <Button size="sm" icon="zap" onClick={runTest} loading={test?.busy} disabled={p.needsKey && !p.masked}>Probar conexión</Button>
            {test && !test.busy && <span className={`plug-test-msg ${test.ok ? 'ok' : 'err'}`}><Icon name={test.ok ? 'check-circle' : 'x-circle'} size={14} />{test.msg}</span>}
            <div className="grow" />
            {(m.keyUrl || m.site) && <Button size="sm" variant="ghost" iconRight="external" onClick={() => call('shell:openExternal', m.keyUrl || m.site)}>{m.keyUrl ? 'Conseguir una clave' : 'Sitio oficial'}</Button>}
          </div>}

          {p.id === 'codex' && <div className="set-card plug-opts">
            <Row label="Modelo" desc="Vacío = el predeterminado de tu cuenta."><TextInput mono width={220} value={cfg.model} placeholder="predeterminado" onChange={(v) => up({ plugins: { codex: { model: v } } })} /></Row>
            <Row label="Ruta de Codex CLI" desc="Vacío = detectar automáticamente."><TextInput mono width={300} value={cfg.path} placeholder="codex.exe" onChange={(v) => up({ plugins: { codex: { path: v } } })} clearable /></Row>
          </div>}
          {p.id === 'openai' && <div className="set-card plug-opts">
            <Row label="Modelo de imágenes"><Select value={cfg.imageModel} width={220} onChange={(v) => up({ plugins: { openai: { imageModel: v } } })} options={['gpt-image-1', 'gpt-image-1-mini', 'gpt-image-1.5'].map((x) => ({ value: x, label: x }))} /></Row>
            <Row label="Calidad de imagen" desc="Más calidad = más costo por imagen."><Select value={cfg.imageQuality} width={220} onChange={(v) => up({ plugins: { openai: { imageQuality: v as any } } })} options={[{ value: 'low', label: 'Baja' }, { value: 'medium', label: 'Media' }, { value: 'high', label: 'Alta' }, { value: 'auto', label: 'Automática' }]} /></Row>
            <Row label="Modelo para consultas"><TextInput mono width={220} value={cfg.chatModel} onChange={(v) => up({ plugins: { openai: { chatModel: v } } })} /></Row>
          </div>}
          {p.id === 'gemini' && <div className="set-card plug-opts">
            <Row label="Modelo para consultas"><TextInput mono width={240} value={cfg.chatModel} onChange={(v) => up({ plugins: { gemini: { chatModel: v } } })} /></Row>
            <Row label="Modelo de imágenes"><TextInput mono width={240} value={cfg.imageModel} onChange={(v) => up({ plugins: { gemini: { imageModel: v } } })} /></Row>
          </div>}
          {p.id === 'openrouter' && <div className="set-card plug-opts">
            <Row label="Modelo" desc="Formato proveedor/modelo, p. ej. openai/gpt-5, google/gemini-2.5-pro, deepseek/deepseek-chat."><TextInput mono width={260} value={cfg.chatModel} onChange={(v) => up({ plugins: { openrouter: { chatModel: v } } })} /></Row>
          </div>}
          {p.id === 'whisper' && (tabletWhisper ? <WhisperSetup onChanged={onChanged} /> : <WhisperOptions onChanged={onChanged} />)}
          {(p.id === 'elevenlabs' || p.id === 'fish') && <VoiceOptions provider={p.id} ready={p.ready} />}
        </div>
      )}
    </div>
  )
}

function WhisperOptions({ onChanged }: { onChanged: () => void }) {
  const { settings: s, updateSettings: up } = useApp()
  const [models, setModels] = useState<Array<{ id: string; size: number }> | null>(null)
  useEffect(() => { call<Array<{ id: string; size: number }>>('plugins:whisperModels').then(setModels).catch(() => setModels([])) }, [])
  const w = s!.plugins.whisper
  const gb = (n: number) => (n / 1e9 >= 1 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`)
  const set = (patch: any) => { up({ plugins: { whisper: patch } }); setTimeout(onChanged, 120) }
  return (
    <div className="set-card plug-opts">
      <Row label="Modelo" desc="Los más grandes son más precisos. large-v3-turbo es el mejor equilibrio entre precisión y velocidad.">
        {models == null ? <Spinner /> : models.length ? (
          <Select value={models.find((m) => m.id === w.model) ? w.model : models[0].id} width={280} menuWidth={320} onChange={(v) => set({ model: v })}
            options={models.map((m) => ({ value: m.id, label: m.id.replace(/^openai\//, ''), desc: gb(m.size) }))} />
        ) : <span className="t3" style={{ fontSize: 12 }}>No hay modelos descargados</span>}
      </Row>
      <Row label="Procesador" desc="Automático usa la GPU (CUDA) si está disponible.">
        <Select value={w.device} width={200} onChange={(v) => set({ device: v })} options={[{ value: 'auto', label: 'Automático' }, { value: 'cuda', label: 'GPU (CUDA)' }, { value: 'cpu', label: 'CPU' }]} />
      </Row>
      <Row label="Python" desc="Vacío = detectar automáticamente. Necesita torch y transformers.">
        <TextInput mono width={300} value={w.python} placeholder="python.exe" onChange={(v) => set({ python: v })} clearable />
      </Row>
    </div>
  )
}

function VoiceOptions({ provider, ready }: { provider: 'elevenlabs' | 'fish'; ready: boolean }) {
  const { settings: s, updateSettings: up, toast } = useApp()
  const [voices, setVoices] = useState<Voice[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [q, setQ] = useState('')
  const audio = useRef<HTMLAudioElement | null>(null)
  const cfg = s!.plugins[provider] as any
  const load = async (query = '') => { setLoading(true); try { setVoices(await call('plugins:voices', provider, query)) } catch (e: any) { toast(e.message, true) } finally { setLoading(false) } }
  const play = (url?: string) => { if (!url) return; audio.current?.pause(); audio.current = new Audio(url); audio.current.play().catch(() => toast('No se pudo reproducir la muestra', true)) }
  const cur = voices?.find((v) => v.id === cfg.voiceId)
  return (
    <div className="set-card plug-opts">
      <Row label="Voz por defecto" desc={cfg.voiceId ? <span className="mono">{cfg.voiceName || ''} · {cfg.voiceId}</span> : 'Elegí la voz que Claude va a usar para narrar.'}>
        {voices
          ? <Select value={cfg.voiceId} width={260} menuWidth={360} onChange={(v) => { const x = voices.find((z) => z.id === v); up({ plugins: { [provider]: { voiceId: v, voiceName: x?.name || '' } } as any }) }}
            options={voices.length ? voices.map((v) => ({ value: v.id, label: v.name, desc: v.desc })) : [{ header: 'Sin voces' }]} placeholder="Elegir voz…" />
          : <Button icon="mic" onClick={() => load()} loading={loading} disabled={!ready}>Cargar voces</Button>}
        {cur?.preview && <Button variant="ghost" icon="play" tip="Escuchar muestra" onClick={() => play(cur.preview)} />}
      </Row>
      {provider === 'fish' && voices && (
        <Row label="Buscar en la biblioteca" desc="Voces públicas de Fish Audio, ordenadas por uso. Código de idioma (es), título o ambos (es: narrador).">
          <TextInput icon="search" width={260} value={q} onChange={setQ} onEnter={() => load(q)} placeholder="es · narrador · es: documental" />
        </Row>
      )}
      <Row label="Id de voz manual" desc="Pegá el id si ya lo conocés (desde el sitio del proveedor).">
        <TextInput mono width={260} value={cfg.voiceId} onChange={(v) => up({ plugins: { [provider]: { voiceId: v.trim(), voiceName: '' } } as any })} clearable />
      </Row>
      {provider === 'elevenlabs' ? <>
        <Row label="Modelo"><Select value={cfg.modelId} width={260} menuWidth={320} onChange={(v) => up({ plugins: { elevenlabs: { modelId: v } } })} options={[
          { value: 'eleven_multilingual_v2', label: 'Multilingual v2', desc: 'La mejor calidad, 29 idiomas' }, { value: 'eleven_v3', label: 'Eleven v3', desc: 'La más expresiva' },
          { value: 'eleven_turbo_v2_5', label: 'Turbo v2.5', desc: 'Más rápida y barata' }, { value: 'eleven_flash_v2_5', label: 'Flash v2.5', desc: 'La más rápida' }]} /></Row>
        <Row label="Estabilidad" desc={`${Math.round(cfg.stability * 100)} % · menos = más expresiva`}><Slider value={cfg.stability} min={0} max={1} step={0.05} width={180} onChange={(v) => up({ plugins: { elevenlabs: { stability: v } } })} /></Row>
        <Row label="Parecido a la voz" desc={`${Math.round(cfg.similarity * 100)} %`}><Slider value={cfg.similarity} min={0} max={1} step={0.05} width={180} onChange={(v) => up({ plugins: { elevenlabs: { similarity: v } } })} /></Row>
        <Row label="Estilo" desc={`${Math.round(cfg.style * 100)} % · exagera la entonación`}><Slider value={cfg.style} min={0} max={1} step={0.05} width={180} onChange={(v) => up({ plugins: { elevenlabs: { style: v } } })} /></Row>
        <Row label="Velocidad"><NumberInput value={cfg.speed} min={0.7} max={1.2} step={0.05} decimals={2} suffix="×" width={110} onChange={(v) => up({ plugins: { elevenlabs: { speed: v } } })} /></Row>
      </> : <>
        <Row label="Modelo" desc={cfg.model === 's2.1-pro-free' ? <span><Badge tone="ok">Gratis</Badge> Misma calidad que S2.1 Pro, sin garantías de latencia.</span> : cfg.model === 's1' ? 'Heredado: 13 idiomas y etiquetas (entre paréntesis).' : 'Se cobra por uso (US$ 15 por millón de bytes de texto).'}>
          <Select value={cfg.model} width={260} menuWidth={340} onChange={(v) => up({ plugins: { fish: { model: v } } })} options={[
            { value: 's2.1-pro-free', label: 'S2.1 Pro Free', desc: 'Gratis · 83 idiomas · [corchetes] en lenguaje natural', hint: 'recomendado' },
            { value: 's2.1-pro', label: 'S2.1 Pro', desc: 'Igual pero pago, con garantías de latencia para producción' },
            { value: 's2-pro', label: 'S2 Pro', desc: 'Generación anterior · 80+ idiomas' },
            { value: 's1', label: 'S1 (heredado)', desc: '13 idiomas · etiquetas (entre paréntesis)' },
            { value: 'drama-3-preview', label: 'Drama 3 (preview)', desc: 'Dirección de actuación · acceso por solicitud a Fish Audio' }]} />
        </Row>
        <Row label="Expresividad (temperature)" desc={`${cfg.temperature.toFixed(2)} · más alto = más variada; más bajo = más estable`}><Slider value={cfg.temperature} min={0.3} max={1} step={0.05} width={180} onChange={(v) => up({ plugins: { fish: { temperature: v } } })} /></Row>
        <Row label="Diversidad (top_p)" desc={cfg.topP.toFixed(2)}><Slider value={cfg.topP} min={0.3} max={1} step={0.05} width={180} onChange={(v) => up({ plugins: { fish: { topP: v } } })} /></Row>
        <Row label="Velocidad"><NumberInput value={cfg.speed} min={0.5} max={2} step={0.05} decimals={2} suffix="×" width={110} onChange={(v) => up({ plugins: { fish: { speed: v } } })} /></Row>
        <Row label="Volumen" desc="Ajuste en dB; la sonoridad se normaliza igual."><NumberInput value={cfg.volume} min={-12} max={12} step={1} suffix="dB" width={110} onChange={(v) => up({ plugins: { fish: { volume: v } } })} /></Row>
        <Row label="Latencia" desc="«Normal» da la mejor calidad; las otras sólo sirven para tiempo real."><Select value={cfg.latency} width={180} onChange={(v) => up({ plugins: { fish: { latency: v as any } } })} options={[{ value: 'normal', label: 'Normal (calidad)' }, { value: 'balanced', label: 'Equilibrada' }, { value: 'low', label: 'Baja' }]} /></Row>
      </>}
    </div>
  )
}
