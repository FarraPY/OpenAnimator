# OpenAnimator — guía para agentes de IA

Estás dentro de **OpenAnimator**, un estudio de video donde cada escena es una página
HTML/SVG/JS que es **función del tiempo**. Un timeline (JSON) ordena escenas, video y audio,
y la app exporta a MP4 con la GPU. Tu trabajo es crear y editar esos archivos: el editor
recarga solo cuando guardás.

@NOTAS-IA.md

## Mapa de un proyecto (`data/projects/<id>/`)

| Archivo | Qué es | ¿Lo editás? |
|---|---|---|
| `project.json` | nombre, resolución (`width`/`height`), `fps`, lista de `timelines` | sólo nombre/resolución si te lo piden; nunca cambies `id` |
| `timelines/<id>.json` | pistas y clips (formato abajo) | **sí** |
| `scenes/*.html` | escenas (y sus datos, p. ej. `scenes/guion.js`) | **sí** |
| `scenes/motor/*.js` | motores de plantilla | sólo para cambiar el estilo global |
| `assets/` | medios (voz, música, imágenes, video) | agregá archivos acá |
| `scripts/` | guiones de narración | sí |
| `renders/`, `.oa-cache/` | exportaciones y caché | **no** |
| `brief.md` | objetivo, público, estilo | leelo primero |

## Formato del timeline

```json
{ "format": "oa-timeline/1", "duration": 30,
  "tracks": [
    { "id": "escenas", "name": "Escenas", "type": "scene", "clips": [
      { "id": "c1", "src": "scenes/intro.html", "start": 0, "duration": 8, "in": 0, "fadeIn": 0, "fadeOut": 0.4 } ] },
    { "id": "video", "name": "Video", "type": "video", "clips": [ { "id": "v1", "src": "assets/toma.mp4", "start": 8, "duration": 5, "in": 2, "fit": "cover" } ] },
    { "id": "voz", "name": "Voz", "type": "audio", "clips": [ { "id": "a1", "src": "assets/voz/parte-1.mp3", "start": 0.4, "duration": 6.2, "in": 0, "volume": 1 } ] }
  ],
  "notes": [ { "id": "n1", "t": 12.5, "text": "pedido del usuario anclado a este segundo" } ] }
```

- Tiempos en **segundos**. `in` = desde qué segundo de la fuente arranca el clip (para escenas: tiempo interno de la escena).
- Pistas visuales: la **primera del array se dibuja adelante**. Tipos: `scene` (HTML), `video` (mp4/webm/imágenes), `audio`.
- Ids únicos en todo el archivo. `duration` del timeline ≥ fin del último clip.
- Rutas `src` **relativas al proyecto**. Probá duraciones reales con la herramienta `oa_info_medio` (o `ffprobe`, está en el PATH).
- Escribí el JSON completo y válido (el editor muestra un error si lo rompés). Varias escenas en fila en la pista `scene` = cortes; usá `fadeIn`/`fadeOut` para fundidos. Opcionales: `opacity` (0-1, la del clip visual, por encima de los fundidos) y, sólo en escenas, `speed` (1 = normal, 2 = el doble de rápido: el tiempo interno avanza `speed` segundos por segundo del timeline, desde `in`).
- `notes`: pedidos del usuario, anclados a un momento. Resolvé cada uno y, apenas terminás ese cambio, borralo con `oa_resolver_nota` (no deben quedar notas ya resueltas en el timeline; las que no resolviste, dejalas).

## Contrato de escena (resumen — detalle en la skill `escenas-html`)

- Exponé `window.__oa = { duration, render(t) }` (o `async renderFrame(t)`); `render(t)` **pura**.
- Diseñá en 1920×1080 y escalá al viewport. Sin CDN: todo local (la exportación corre offline).
- Si usás CSS/rAF/timers igual funciona: OpenAnimator congela y controla el reloj.

## Herramientas para VER tu trabajo (MCP `openanimator`)

| Herramienta | Para qué |
|---|---|
| `oa_proyecto` | resumen: timelines, pistas, clips, notas |
| `oa_ver_fotogramas` | renderiza instantes exactos y te devuelve las imágenes |
| `oa_hoja_contactos` | una grilla de N fotogramas con su hora: ritmo, variedad, consistencia |
| `oa_auditar_layout` | barre el timeline y lista textos superpuestos o fuera de cuadro |
| `oa_medios`, `oa_info_medio` | archivos del proyecto y duración de un audio/video |

**Regla de oro:** después de cada cambio visual, MIRÁ (fotogramas o hoja de contactos) y corré la
auditoría. Un audit en 0 no alcanza: también hay que mirar. No digas "listo" sin haber visto.

## Exportar / previsualizar desde la terminal

`%OA_EXE% --cli render <id-proyecto> [--timeline id|all] [--res 720p|1080p|4k] [--start s --end s] [--out archivo.mp4]`
(la ruta del ejecutable está en la variable `OA_EXE`). Para revisar movimiento real, exportá un tramo corto a 720p.

## Skills disponibles (leé la que corresponda antes de trabajar)

- `direccion-artistica` — cómo lograr un video profesional y no genérico (proceso, reglas, QA). **Siempre.**
- `escenas-html` — cómo escribir escenas deterministas y sus trampas.
- `voz-y-tiempos` — narración, tiempos por palabra, música y efectos sincronizados.
- `voz-fish-audio` — narrar con Fish Audio: modelo, voz, dirección con `[corchetes]`, diálogos, texto para el oído. **Siempre que generes voz con Fish.**
- `plantilla-documental`, `plantilla-cinetico` — formatos de datos de cada plantilla.

## Subagentes: trabajar en paralelo

Con la herramienta Agent (Task en versiones viejas) lanzás otros Claude que trabajan al mismo tiempo que vos. Para un
video de varias escenas usá el subagente `escena` (subagent_type "escena"; ya conoce las reglas de OpenAnimator):

1. Primero definí lo común: guion, tiempos (voz o música) y dirección de arte en `brief.md`.
2. Lanzá un subagente por escena, todos en el mismo mensaje, cada uno con un pedido completo: qué archivo escribe
   (`scenes/<nombre>.html`), duración, textos, momentos clave y qué tomar del estilo.
3. Cada uno toca sólo su escena: el timeline, las voces, la música y `brief.md` los manejás vos (dos agentes editando
   el mismo archivo se pisan).
4. Siguen en segundo plano y te avisan al terminar: cuando tengas todos los resúmenes, revisá todo junto con
   `oa_hoja_contactos` y armá el timeline.

Cada subagente gasta como una conversación aparte: usalos cuando el trabajo se reparte de verdad (varias escenas), no
para cambios chicos ni para una sola escena.

## Normas

- Respondé en el idioma del usuario. Explicá qué cambiaste en pocas líneas.
- Antes de gastar dinero en APIs (voz, música, imágenes, video) preguntá; nunca regeneres en bucle.
- Guardá cada decisión de estilo del usuario en `brief.md` (sección Notas) para no olvidarla.
- No toques `renders/`, `.oa-cache/` ni archivos fuera del proyecto salvo que te lo pidan.

## Plugins del usuario (imágenes, voz, sonido, otros modelos)

Si el usuario configuró plugins (Ajustes → Plugins), tenés estas herramientas. Pueden costar créditos: usalas
cuando aporten, no en cada paso. Consultá `oa_plugins` para saber cuáles están listos.

| Herramienta | Para qué |
|---|---|
| `oa_generar_imagen` | imagen con ChatGPT (cuenta vinculada), OpenAI o Gemini → `assets/ia/*.png`. Fondo transparente para recortes. Pasá `referencia` para mantener un personaje/estilo |
| `oa_generar_voz` | narración con ElevenLabs (devuelve tiempos por palabra) o Fish Audio (S2.1 Pro Free es **gratis**; dirección con `[corchetes]`, diálogos con `voces`; skill `voz-fish-audio`) → `assets/voz/*.mp3` |
| `oa_voces` | voces disponibles de cada proveedor |
| `oa_generar_sfx` | efectos de sonido (ElevenLabs) → `assets/sfx/*.mp3`. Generá cada sonido una vez y colocá **un clip por efecto** en la pista SFX, en su momento exacto (nunca premezclados en un solo archivo) |
| `oa_transcribir` | tiempos por palabra de una voz ya grabada. Usa **Whisper local** (en el equipo del usuario, gratis, sin internet): es la opción por defecto, no pases `proveedor` |
| `oa_consultar_ia` | segunda opinión de GPT/Gemini/otros (texto e imágenes) |

- Después de generar una imagen, MIRALA (la herramienta devuelve una vista previa) antes de usarla.
- Desde una escena en `scenes/`, las rutas a medios son relativas: `../assets/ia/fondo.png`.

## Recursos libres (gratis, sin clave)

| Herramienta | Para qué |
|---|---|
| `oa_buscar_iconos`, `oa_guardar_iconos` | íconos SVG de Iconify (buscá en inglés) → `assets/iconos/`. Una sola colección por video (lucide, tabler, ph, material-symbols…); logos de marcas: `simple-icons` o `logos` |
| `oa_buscar_fuentes`, `oa_usar_fuente` | cualquier tipografía libre (las de Google Fonts) → `assets/fuentes/<id>.css`; en la escena, `<link rel="stylesheet" href="../assets/fuentes/<id>.css">`. Mejor que las del sistema: se ve igual en todos los equipos y al exportar |
| `WebSearch` | datos, cifras y referencias para el guion; anotá en `brief.md` de dónde sale lo que uses |
| `oa_quitar_fondo` | (sólo en el iPhone) recorta personas, animales u objetos de una imagen → PNG transparente en `assets/recortes/` |
| `oa_borrar` | (teléfono y tablet; en la PC tenés la terminal) borrar archivos o carpetas del proyecto: van a la papelera de la app y el usuario los puede recuperar. Limpiá las pruebas y versiones que no sirven |
| `oa_ejecutar_js` | (teléfono y tablet, donde no hay terminal) JavaScript aislado que guarda en el proyecto: sintetizar efectos de sonido con Web Audio (whoosh, pop, impacto, riser, bip: `OfflineAudioContext` → `wav()` → `guardar`), dibujar imágenes con canvas o calcular. Sin plugin de sonido, es la forma de tener efectos gratis |

## Archivos adjuntos y plantillas

- Lo que el usuario adjunta en el chat se copia a `adjuntos/` del proyecto (PDF, imágenes, guiones, audio…).
- Si el proyecto tiene `PLANTILLA.md`, viene de una plantilla (guardada por el usuario o creada analizando un
  video): respetá ese estilo y el `brief.md`.
