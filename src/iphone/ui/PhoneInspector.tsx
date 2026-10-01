/**
 * La pestaña Timeline de la hoja del editor: los ajustes del clip elegido, como un inspector. Clip (inicio, fin,
 * dividir, duplicar, borrar), Animación (entrada y salida gradual) y Audio (volumen, silenciar).
 */
import { useEffect, useState } from 'react'
import { Clip, Timeline as TL, Track } from '../../api'
import { TYPE_COLOR, TYPE_ICON, trackRole } from '../../components/Timeline'
import { Icon, IconName } from '../../ui/icons'
import { Slider, Switch } from '../../ui/kit'
import { sceneThumb } from './PhoneTimeline'

const isImage = (src: string) => /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(src)
const clipName = (c: Clip) => c.name || c.src.split('/').pop()!.replace(/\.[^.]+$/, '')
/** 00:22.00 */
const clock = (x: number) => { const cs = Math.round(Math.max(0, x) * 100); return `${String(Math.floor(cs / 6000)).padStart(2, '0')}:${((cs % 6000) / 100).toFixed(2).padStart(5, '0')}` }
/** «1:05.5», «65,5» o «65» → segundos. */
const parseTime = (s: string) => { const m = s.trim().match(/^(?:(\d+):)?(\d+(?:[.,]\d*)?)$/); return m ? (m[1] ? +m[1] * 60 : 0) + parseFloat(m[2].replace(',', '.')) : null }

type Props = {
  projectId: string; tlId: string; tl: TL; sel: string[]; t: number; fps: number
  onSelect: (ids: string[]) => void
  onPatch: (id: string, p: Partial<Clip>, commit?: boolean) => void
  onSplit: () => void; onDuplicate: () => void; onDelete: () => void
}

export default function PhoneInspector(p: Props) {
  const [part, setPart] = useState<'clip' | 'anim' | 'audio'>('clip')
  let found: { c: Clip; tr: Track } | null = null
  for (const tr of p.tl.tracks) { const c = tr.clips.find((x) => p.sel.includes(x.id)); if (c) { found = { c, tr }; break } }
  if (!found) {
    // Sin clip elegido: el que está bajo el cursor (en la pista de más arriba) se puede elegir de un toque.
    const under = p.tl.tracks.flatMap((tr) => tr.clips.filter((c) => p.t >= c.start && p.t < c.start + c.duration))[0]
    return (
      <div className="ins ins-empty">
        <Icon name="film" size={28} stroke={1.4} />
        <span className="t3">Tocá un clip del timeline para ver sus ajustes.</span>
        {under && <button className="ins-btn" onClick={() => p.onSelect([under.id])}><Icon name="check" size={17} />Elegir «{clipName(under)}»</button>}
      </div>
    )
  }
  const { c, tr } = found
  const audio = tr.type === 'audio' || (tr.type === 'video' && !isImage(c.src))
  const role = tr.type === 'audio' ? trackRole(tr) : tr.type
  const thumb = tr.type === 'scene' ? sceneThumb(p.projectId, p.tlId, c) : ''
  const patch = (x: Partial<Clip>, commit = true) => p.onPatch(c.id, x, commit)
  const minDur = 1 / p.fps
  const maxDur = (c as any).srcDur ? (c as any).srcDur - (c.in || 0) : Infinity
  const maxFade = Math.max(0.1, Math.min(5, c.duration / 2))
  const vol = c.volume ?? 1
  const tab = part === 'audio' && !audio ? 'clip' : part
  return (
    <div className="ins">
      <div className="ins-head">
        <span className="ins-th" style={{ backgroundImage: thumb ? `url(${thumb})` : undefined, color: TYPE_COLOR[role] }}>{!thumb && <Icon name={(TYPE_ICON[role] || 'film') as IconName} size={20} />}</span>
        <b className="ellipsis">{clipName(c)}</b>
        <span className="ins-dur tabnum">{c.duration.toFixed(1).replace('.', ',')} s</span>
      </div>
      <div className="ins-seg" role="tablist">
        {([['clip', 'Clip'], ['anim', 'Animación'], ['audio', 'Audio']] as const).map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} disabled={k === 'audio' && !audio} onClick={() => setPart(k)}>{label}</button>
        ))}
      </div>
      {tab === 'clip' && <>
        <div className="ins-grid">
          <TimeField label="Inicio" value={c.start} onCommit={(v) => patch({ start: +Math.max(0, v).toFixed(3) })} />
          <TimeField label="Fin" value={c.start + c.duration} onCommit={(v) => patch({ duration: +Math.min(maxDur, Math.max(minDur, v - c.start)).toFixed(3) })} />
        </div>
        <div className="ins-acts">
          <button className="ins-btn" onClick={p.onSplit} disabled={!(p.t > c.start + 0.02 && p.t < c.start + c.duration - 0.02)}><Icon name="scissors" size={17} />Dividir</button>
          <button className="ins-btn" onClick={p.onDuplicate}><Icon name="copy" size={17} />Duplicar</button>
          <button className="ins-btn danger" onClick={p.onDelete}><Icon name="trash" size={17} />Eliminar</button>
        </div>
      </>}
      {tab === 'anim' && <div className="ins-rows">
        <label className="ins-row"><span>Entrada gradual</span><b className="tabnum">{(c.fadeIn || 0).toFixed(1).replace('.', ',')} s</b>
          <Slider value={c.fadeIn || 0} min={0} max={maxFade} step={0.1} onChange={(v) => patch({ fadeIn: +v.toFixed(2) }, false)} onCommit={() => patch({}, true)} /></label>
        <label className="ins-row"><span>Salida gradual</span><b className="tabnum">{(c.fadeOut || 0).toFixed(1).replace('.', ',')} s</b>
          <Slider value={c.fadeOut || 0} min={0} max={maxFade} step={0.1} onChange={(v) => patch({ fadeOut: +v.toFixed(2) }, false)} onCommit={() => patch({}, true)} /></label>
      </div>}
      {tab === 'audio' && <div className="ins-rows">
        <label className="ins-row"><span>Volumen</span><b className="tabnum">{Math.round(vol * 100)} %</b>
          <Slider value={vol} min={0} max={2} step={0.01} onChange={(v) => patch({ volume: +v.toFixed(2) }, false)} onCommit={() => patch({}, true)} /></label>
        <div className="ins-row inline"><span>Silenciar el clip</span><Switch checked={!!c.muted} onChange={(v) => patch({ muted: v })} /></div>
      </div>}
    </div>
  )
}

/** Un tiempo editable (00:22.00): se aplica al salir del campo o con Intro. */
function TimeField({ label, value, onCommit }: { label: string; value: number; onCommit: (v: number) => void }) {
  const [text, setText] = useState(clock(value))
  useEffect(() => setText(clock(value)), [value])
  const commit = () => { const v = parseTime(text); if (v != null && Math.abs(v - value) > 1e-3) onCommit(v); else setText(clock(value)) }
  return (
    <label className="ins-field">
      <span>{label}</span>
      <input className="tabnum" inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} onFocus={(e) => e.target.select()} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
    </label>
  )
}
