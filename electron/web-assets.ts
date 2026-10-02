/**
 * Íconos (Iconify: más de 200 mil, de unas 150 colecciones abiertas) y tipografías (Fontsource: las de Google Fonts y
 * otras libres) para las escenas, gratis y sin clave. Sin Node: lo usan la PC (electron/api.ts) y el iPhone y la tablet
 * (src/android/backend/tools.ts), cada uno con su red (`Net`: en la PC fetch; en el teléfono y la tablet el http.request
 * del puente, que en la tablet esquiva la CSP de la página) y su forma de guardar. Lo que se baja queda en el proyecto
 * (assets/iconos, assets/fuentes): la escena no depende de internet al exportar.
 */
export type Net = {
  /** GET de texto; error si no responde 2xx. */
  text: (url: string) => Promise<string>
  /** GET directo a un archivo del proyecto (ruta relativa); devuelve los bytes. */
  download: (url: string, rel: string) => Promise<number>
  /** Guarda un archivo de texto del proyecto. */
  save: (rel: string, text: string) => Promise<unknown> | unknown
}

const ICONIFY = 'https://api.iconify.design'
const FONTS = 'https://api.fontsource.org/v1/fonts'
const kb = (n: number) => `${Math.max(1, Math.round(n / 1024))} KB`

// ── íconos ─────────────────────────────────────────────────────────────────────

type IconSearch = { icons: string[]; total: number; collections?: Record<string, { name: string; license?: { title?: string; spdx?: string }; palette?: boolean }> }

/** Busca íconos (en inglés anda mejor): nombres «colección:ícono», agrupados por colección. */
export async function searchIcons(net: Net, query: string, o: { limite?: number; coleccion?: string } = {}) {
  const u = new URL(ICONIFY + '/search')
  u.searchParams.set('query', query)
  u.searchParams.set('limit', String(Math.min(Math.max(o.limite || 64, 32), 200))) // la API no da menos de 32
  if (o.coleccion) u.searchParams.set('prefixes', o.coleccion)
  const j = JSON.parse(await net.text(u.toString())) as IconSearch
  if (!j.icons?.length) return `Ningún ícono para «${query}»${o.coleccion ? ` en ${o.coleccion}` : ''}. Probá en inglés o con otra palabra.`
  const by = new Map<string, string[]>()
  for (const n of j.icons) { const p = n.split(':')[0]; by.set(p, [...(by.get(p) || []), n]) }
  const lines = [...by].map(([p, ns]) => {
    const c = j.collections?.[p]
    const lic = c?.license?.spdx || c?.license?.title
    return `- ${c?.name || p} (${p}${lic ? ', ' + lic : ''}${c?.palette ? ', a color' : ''}): ${ns.join(', ')}`
  })
  return [`${j.total} íconos para «${query}»${j.total > j.icons.length ? ` (van los primeros ${j.icons.length})` : ''}:`, ...lines,
    'Guardalos con oa_guardar_iconos. Usá una sola colección en todo el video para que el estilo sea parejo (p. ej. lucide, tabler, ph, material-symbols; logos de marcas: simple-icons, de un color, o logos, a color; emoji: fluent-emoji, noto).'].join('\n')
}

/** Baja íconos a assets/iconos/ como SVG. `color` (#hex) para los de un color; si no, usan currentColor. */
export async function saveIcons(net: Net, names: string[], o: { color?: string } = {}) {
  const out: string[] = []
  const inline: string[] = []
  for (const name of names.slice(0, 30)) {
    const m = /^([a-z0-9-]+):([a-z0-9-]+)$/.exec(String(name).trim())
    if (!m) { out.push(`- ${name}: nombre inválido (tiene que ser «colección:ícono», como lo da oa_buscar_iconos)`); continue }
    const u = new URL(`${ICONIFY}/${m[1]}/${m[2]}.svg`)
    u.searchParams.set('height', 'auto') // ancho y alto del dibujo, no 1em
    if (o.color && /^#[0-9a-f]{3,8}$/i.test(o.color)) u.searchParams.set('color', o.color)
    try {
      const svg = await net.text(u.toString())
      if (!svg.startsWith('<svg')) throw new Error('no existe')
      const rel = `assets/iconos/${m[1]}-${m[2]}.svg`
      await net.save(rel, svg)
      const vb = /viewBox="([^"]+)"/.exec(svg)?.[1]?.split(/\s+/)
      out.push(`- ${rel}${vb ? ` (${vb[2]}×${vb[3]})` : ''}`)
      if (svg.length <= 1500 && inline.join('').length < 6000) inline.push(`${rel}:\n${svg}`)
    } catch (e: any) { out.push(`- ${name}: no se pudo bajar (${e.message})`) }
  }
  return ['Íconos guardados:', ...out,
    'Desde una escena en scenes/: <img src="../assets/iconos/…svg"> (el color queda fijo), o pegá el SVG en la escena para animar sus trazos y cambiar el color con CSS (fill/stroke currentColor).',
    ...(inline.length ? ['', ...inline] : [])].join('\n')
}

// ── tipografías ───────────────────────────────────────────────────────────────

type FontInfo = { id: string; family: string; subsets: string[]; weights: number[]; styles: string[]; defSubset: string; variable: boolean; category: string; license: string; type: string }
type FontDetail = FontInfo & { unicodeRange: Record<string, string>; variants: Record<string, Record<string, Record<string, { url: { woff2: string } }>>> }

// Las más usadas, primero en la lista (Fontsource no dice cuáles son populares). Algunas de títulos (Bebas Neue, Anton,
// Oswald) son «sans-serif» para Google: la categoría filtra y el orden sale de todas las listas.
const PICKS = [
  'Inter', 'Montserrat', 'Poppins', 'Roboto', 'Open Sans', 'Lato', 'Nunito', 'Raleway', 'Work Sans', 'DM Sans', 'Outfit', 'Manrope', 'Plus Jakarta Sans', 'Space Grotesk', 'Sora', 'Archivo', 'Barlow', 'Rubik', 'Figtree', 'Urbanist',
  'Bebas Neue', 'Anton', 'Oswald', 'Archivo Black', 'Abril Fatface', 'Righteous', 'Bungee', 'Alfa Slab One', 'Russo One', 'Staatliches', 'Lobster', 'Monoton', 'Black Ops One', 'Bowlby One',
  'Playfair Display', 'Merriweather', 'Lora', 'EB Garamond', 'Libre Baskerville', 'Cormorant Garamond', 'DM Serif Display', 'Fraunces', 'Source Serif 4', 'Crimson Pro', 'Bitter', 'Noto Serif',
  'Caveat', 'Dancing Script', 'Pacifico', 'Permanent Marker', 'Kalam', 'Shadows Into Light', 'Indie Flower', 'Satisfy', 'Great Vibes', 'Patrick Hand', 'Gochi Hand', 'Amatic SC',
  'JetBrains Mono', 'Fira Code', 'Space Mono', 'IBM Plex Mono', 'Roboto Mono', 'Source Code Pro', 'DM Mono', 'Courier Prime',
].map((n) => n.toLowerCase())
const CATS: Record<string, string> = { sans: 'sans-serif', 'sans-serif': 'sans-serif', serif: 'serif', display: 'display', titulo: 'display', titulos: 'display', handwriting: 'handwriting', manuscrita: 'handwriting', mono: 'monospace', monospace: 'monospace' }

let fontList: Promise<FontInfo[]> | null = null
function fonts(net: Net) {
  fontList ||= net.text(FONTS).then((t) => JSON.parse(t) as FontInfo[]).catch((e) => { fontList = null; throw e })
  return fontList
}
const describe = (f: FontInfo) => {
  const w = f.weights.length > 1 ? `${f.weights[0]}–${f.weights[f.weights.length - 1]}` : String(f.weights[0])
  return `- ${f.family} (${f.category} · pesos ${w}${f.styles.includes('italic') ? ' · cursiva' : ''})`
}

/** Busca tipografías por nombre o estilo (sans-serif, serif, display, handwriting, monospace). */
export async function searchFonts(net: Net, query?: string, categoria?: string) {
  const all = (await fonts(net)).filter((f) => f.subsets.includes('latin'))
  const cat = categoria ? CATS[categoria.toLowerCase().trim()] || categoria.toLowerCase().trim() : ''
  const q = (query || '').toLowerCase().trim()
  const rank = (f: FontInfo) => { const i = PICKS.indexOf(f.family.toLowerCase()); return (q && f.family.toLowerCase() === q ? -1000 : 0) + (i >= 0 ? i : 500) }
  const list = all.filter((f) => (!cat || f.category === cat) && (!q || f.family.toLowerCase().includes(q) || f.id.includes(q)))
    .sort((a, b) => rank(a) - rank(b) || a.family.localeCompare(b.family))
  if (!list.length) return `Ninguna tipografía${q ? ` con «${query}»` : ''}${cat ? ` de estilo ${cat}` : ''}.`
  return [`${list.length} tipografías${cat ? ` ${cat}` : ''}${q ? ` con «${query}»` : ''} (las más usadas primero):`, ...list.slice(0, 40).map(describe),
    'Bajá la elegida con oa_usar_fuente: queda en el proyecto, así se ve igual en la vista previa, al exportar y en cualquier equipo.'].join('\n')
}

/** Baja una tipografía a assets/fuentes/<id>/ con su CSS (latin y latin-ext: alcanza para español y portugués). */
export async function saveFont(net: Net, family: string, o: { pesos?: number[]; cursiva?: boolean } = {}) {
  const all = await fonts(net)
  const key = family.toLowerCase().trim()
  const f = all.find((x) => x.family.toLowerCase() === key || x.id === key)
  if (!f) {
    const near = all.filter((x) => x.family.toLowerCase().includes(key)).slice(0, 8).map((x) => x.family)
    throw new Error(`No encontré la tipografía «${family}».${near.length ? ` Parecidas: ${near.join(', ')}.` : ' Buscala con oa_buscar_fuentes.'}`)
  }
  const d = JSON.parse(await net.text(`${FONTS}/${f.id}`)) as FontDetail
  const want = (o.pesos?.length ? o.pesos : [400, 700]).map(Number)
  let weights = d.weights.filter((w) => want.includes(w))
  if (!weights.length) weights = [d.weights.reduce((a, b) => (Math.abs(b - want[0]) < Math.abs(a - want[0]) ? b : a))]
  const styles = ['normal', ...(o.cursiva && d.styles.includes('italic') ? ['italic'] : [])]
  const subsets = ['latin', 'latin-ext'].filter((s) => d.subsets.includes(s))
  if (!subsets.length) subsets.push(d.defSubset)
  const css: string[] = [`/* ${d.family} (${d.license}) · Fontsource · bajada por OpenAnimator */`]
  let bytes = 0, files = 0
  for (const w of weights) for (const st of styles) for (const sub of subsets) {
    const url = d.variants[String(w)]?.[st]?.[sub]?.url?.woff2
    if (!url) continue
    const name = `${sub}-${w}-${st}.woff2`
    bytes += await net.download(url, `assets/fuentes/${d.id}/${name}`)
    files++
    css.push(`@font-face { font-family: '${d.family}'; font-style: ${st}; font-weight: ${w}; font-display: block; src: url('${d.id}/${name}') format('woff2');${d.unicodeRange?.[sub] ? ` unicode-range: ${d.unicodeRange[sub]};` : ''} }`)
  }
  if (!files) throw new Error(`«${d.family}» no tiene archivos para esos pesos.`)
  const rel = `assets/fuentes/${d.id}.css`
  css.push('')
  await net.save(rel, css.join('\n'))
  const fallback = ({ 'sans-serif': 'sans-serif', serif: 'serif', monospace: 'monospace', handwriting: 'cursive' } as Record<string, string>)[d.category] || 'sans-serif'
  return `«${d.family}» guardada en ${rel} (pesos ${weights.join(', ')}${styles.length > 1 ? ', con cursiva' : ''}; ${files} archivos, ${kb(bytes)}; licencia ${d.license}).` +
    `\nEn la escena (scenes/): <link rel="stylesheet" href="../${rel}"> y font-family: '${d.family}', ${fallback};` +
    (d.weights.length > weights.length ? `\nTiene también los pesos ${d.weights.filter((w) => !weights.includes(w)).join(', ')}: pedilos si los necesitás.` : '')
}
