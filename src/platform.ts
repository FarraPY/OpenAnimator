/**
 * Plataforma donde corre la interfaz: la PC (Electron, window.oa del preload) o Android
 * (WebView, window.oa lo instala src/android/main.tsx). La interfaz es la misma; esto sólo
 * resuelve las diferencias (direcciones de los archivos y funciones que existen en una sola).
 */
type PlatformInfo = { platform?: 'android' | 'electron'; projectOrigin?: string; appOrigin?: string }

const oa = () => (typeof window !== 'undefined' ? ((window as any).oa as PlatformInfo | undefined) : undefined)

/** true en la app de Android (tablet o teléfono). */
export const isAndroid = () => oa()?.platform === 'android'

/** Pantalla táctil principal (Android): controles más grandes y gestos. */
export const isTouch = () => isAndroid()

/**
 * Android volvió a crear la página porque su motor web se cerró (casi siempre por falta de memoria):
 * la app vuelve al proyecto que estaba abierto y retoma las conversaciones de Claude en Termux.
 * Se lee al cargar (la interfaz después limpia la dirección).
 */
export const recoveredBoot = typeof location !== 'undefined' && /[?&]recovered=1\b/.test(location.search)

const enc = (s: string) => s.split('/').map(encodeURIComponent).join('/')

/** Carpeta de un proyecto: oa://p/<id>/ en la PC, https://oaproject…/p/<id>/ en Android. */
export function projectBase(projectId: string) {
  const o = oa()
  return (o?.platform === 'android' ? `${o.projectOrigin}/p/` : 'oa://p/') + encodeURIComponent(projectId) + '/'
}

/** Archivo de un proyecto (escenas, medios, miniatura). */
export const projectUrl = (projectId: string, rel: string) => projectBase(projectId) + enc(rel)

/** Archivo de una plantilla del usuario (vista previa, referencia del análisis). */
export function userTemplateUrl(templateId: string, rel: string) {
  const o = oa()
  return (o?.platform === 'android' ? `${o.projectOrigin}/ut/` : 'oa://ut/') + encodeURIComponent(templateId) + '/' + enc(rel)
}

/** Compositor del timeline (vista previa y exportación: el mismo renderizador). */
export const compositorUrl = (projectId: string, query: Record<string, string>) =>
  `${projectBase(projectId)}__oa/compositor.html?${new URLSearchParams(query)}`
