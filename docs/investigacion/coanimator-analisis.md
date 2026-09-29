# CoAnimator — análisis técnico completo

> Investigación hecha el 2026-09-26 sobre **CoAnimator 0.7.3** instalado en esta PC
> (`%LOCALAPPDATA%\Programs\coanimator`, datos en `%APPDATA%\CoAnimator`).
> Fuentes: documentación interna que trae la app (`resources/docs`, `resources/guides`),
> skills/agentes/plugins empaquetados, estructura del `app.asar`, y los archivos del
> proyecto real del usuario (*Medicina Interna*).
>
> **Regla de sala limpia para OpenAnimator:** este documento describe *qué hace* y *cómo
> está organizado* CoAnimator, en palabras propias. **No copiar código, prompts, motores,
> plantillas ni textos de CoAnimator** al proyecto nuevo. Las ideas/funciones sí se pueden
> reimplementar desde cero.

### Cobertura de la investigación (checklist)
- [x] Documentación interna completa (`resources/docs`, 19 archivos) y guías de usuario (`resources/guides`, 8)
- [x] Estructura del `app.asar`: ~70 módulos Electron (encabezado de cada uno), 282 canales IPC, 14 rutas de UI, etiquetas de pantallas, 118 dependencias
- [x] Código clave leído directamente: selección de encoder/escalera de calidad, CLI, servidor MCP, prompts de agentes (Coa `SYSTEM`, contexto, spawn de Claude)
- [x] Skills/agentes/workflow sembrados en `APP_ROOT/.claude` y los 8 plugins (incl. el drop-in Fish del usuario)
- [x] Las 9 plantillas oficiales: manifiestos, info.md, 8 skills + referencias, lista de 36 case studies y samples
- [x] Proyecto del usuario (motor, build, DSL, voz) y sus 2 conversaciones completas + memoria
- [x] Prueba práctica: render headless por tramos, límite Free 720p, NVENC en la RTX 5070
- [ ] No leído en detalle (bajo valor): cuerpo de `main.cjs` (495 KB; cubierto vía docs/IPC), bundle React minificado,
  contenido interno de los samples `.coa` y de cada case study (sólo títulos), secretos (excluidos a propósito)

---

## 1. Qué es, en una frase

Un estudio de escritorio (Electron + React/Vite) donde **las animaciones son páginas HTML
que son función del tiempo**, un **timeline** en JSON agrega voz/música/SFX/video, y un
**agente de IA** (Claude Code, Codex, Gemini, Grok, OpenCode o su agente propio) escribe y
edita los archivos del proyecto directamente. Todo se exporta a MP4 capturando Chromium
fotograma a fotograma y codificando con FFmpeg.

La "magia" no es un modelo especial: es **la combinación de un contrato simple
(HTML controlable por tiempo) + motores/plantillas prearmadas + sincronía con la voz +
herramientas para que el agente edite y reciba feedback + un pipeline de agentes**.

---

## 2. Arquitectura

| Capa | Tecnología | Notas |
|---|---|---|
| Shell | Electron (Chromium + Node) | `electron/main.cjs` es el proceso principal; ~70 módulos `.cjs/.mjs` |
| UI | React + Vite + TypeScript (compilado en `dist/`) | 14 pantallas/rutas |
| Terminal embebida | `node-pty` + xterm | PowerShell/cmd en Windows |
| Agentes | CLI `claude` (stream-json), protocolo **ACP** (JSON-RPC propio), agente propio con `@yourgpt/llm-sdk` | ver §9 |
| MCP | `@modelcontextprotocol/sdk` | servidor propio con operaciones del proyecto |
| Video | FFmpeg/FFprobe **del sistema** (no lo incluyen) | detectan NVENC/QSV/AMF/VideoToolbox |
| IA local | transformers.js (Whisper ONNX, WebGPU o wasm) | solo para subtítulos |
| Updates | electron-updater + feed propio | canales stable/beta |
| Dependencias directas | `@anthropic-ai/sdk`, `openai`, `@google/generative-ai`, `@modelcontextprotocol/sdk`, `@yourgpt/llm-sdk`, `node-pty`, `electron-updater`, `zod`, `js-yaml`, `semver` | 118 paquetes en total |

### Rutas de la UI
`/` (Home/launcher), `/project/:id` (editor), `/templates`, `/plugins`, `/skills`,
`/settings`, `/archive`, `/guides`, `/terminal`, `/tools`, `/captions`, `/convert`, `/gif`, `/mockup`.

### Superficie IPC (main ⇄ renderer): 282 canales
Agrupados por dominio (conteo): `agent` (32), `export` (15), `captions` (17), `tools` (12),
`workspace` (11), `mockup` (10), `templates` (10), `plugins` (9), `skills` (9), `gif` (9),
`pty` (9), `update` (8), `onboarding` (8), `convert` (7), `media-setup` (7), `coa` (6),
`timelines` (5), `dubbing` (5), `schedule` (5), `license` (4), `stage` (4), `telemetry` (4),
`elevenlabs` (4), `cli` (3), más ~40 sueltos de proyectos (`create-project`, `save-timeline`,
`validate-timeline`, `repair-timeline`, `compute-waveform`, `probe-duration`, etc.).
El renderer los usa vía `window.coa.*` (preload).

### Carpetas en disco
```
%APPDATA%\CoAnimator\            ← "APP_ROOT" (userData)
  projects\<id>\                 ← un proyecto = una carpeta
  projects.json                  ← índice derivado (lo reescribe la app)
  project-collections.json       ← árbol de colecciones (metadatos)
  archive\  templates\  plugins\  docs\  guides\  models\ (Whisper)
  .claude\skills|agents|workflows ← se siembran ahí; Claude los encuentra "subiendo" desde projects\<id>
  CLAUDE.md / AGENTS.md / GEMINI.md ← instrucciones para agentes (idénticas)
  plugin-secrets.json            ← secretos cifrados (safeStorage/DPAPI)  ⚠ no leer
  telemetry.log, export-sessions\, agent-chats\, agent-media\
```

---

## 3. Formato de proyecto

```
<proyecto>/
  project.json           metadatos: id, name, duration, videoFile, schemaVersion:2,
                         timelines:[{id,name,file,animation}], activeTimelineId, template:{id,kind,version}
  timelines/<id>.json    un archivo por timeline (par "animación HTML + pistas")
  timeline.json          espejo autogenerado del timeline activo (clave "_mirrorOf")
  index.html, *.html     animaciones (players)
  assets/ voice/ renders/ research/ scripts/ thumbnails/ metadata/ brief.md
```

- **Multi-timeline (schema v2):** un proyecto puede tener N timelines, cada uno con su HTML.
  El proyecto del usuario usa 24 (uno por capítulo).
- **Migraciones perezosas**: al abrir, con backup en `.migration-backup/` y log en `migrations.log`.
- **Escritura segura**: escribir a un `.tmp` y renombrar (el watcher ignora `.tmp`).
- **Revisión**: la app estampa `rev` monótono; los agentes lo conservan y pueden poner `basedOnRev`.
- **Checkpoints**: antes de aplicar una edición externa guarda `timelines/.checkpoints/<iso>-pre-agent.json` (últimos 50).

### Esquema del timeline
```json
{ "version":1, "duration":100, "fps":30, "animationStart":0, "animationDuration":100,
  "annotations":[{ "id":"…", "time":14.2, "text":"hacé más lento el zoom acá" }],
  "tracks":[ Track… ] }
```
- **Track**: `id, name, type, color, clips[], muted, volume, locked, solo`.
  Tipos: `video` (la animación, `track-video`, bloqueada, única), `videoclip` (MP4 superpuestos),
  `audio`, `text`, `subtitle`.
- **Orden de pistas = orden de capas** (la primera se dibuja arriba). Visuales siempre antes que audio.
- **Clip**: `id, name, src (relativo), startTime, duration, sourceDuration, volume, trimIn, muted, text`.
  Restricciones: `trimIn+duration ≤ sourceDuration`, ids únicos globales, `startTime+duration ≤ duration`.
- **Segmentos de animación**: clips en `track-video` (con `src:""`) = "este rango del timeline
  reproduce este rango del tiempo de la animación". Permite cortar/reordenar/repetir la
  animación **sin tocar su código**, porque la animación es función pura del tiempo.
- **Notas para la IA** (`annotations`): el usuario marca un instante con un pedido; el agente lo
  resuelve y borra la nota en la misma escritura.
- Paleta fija de colores por pista; atajos tipo NLE (S cortar, B cuchilla, ripple con Shift, snapping 8 px).

### Contrato del player (`window.__kcControl`)
La página HTML debe exponer: `seek(t)`, `seekAndPause(t)`, `play()`, `pause()`,
`hoverPreview(t|null)`, `getTime()`, `getDuration()`, `isPlaying()`, opcional `interactive`,
`setRate(rate)` y **`async renderFrame(t, {fps})`** (el exportador espera a que resuelva:
estado + texturas + videos listos). Videos internos se "estampan" con
`data-kc-desired-time` para que el exportador espere el fotograma decodificado correcto.
Flags de URL: `kcembed=1` (dentro del editor/export: silenciar audio interno, el timeline
es la única fuente de audio) y `kcui=0` (ocultar controles propios).

---

## 4. Editor

- Layout: rail de íconos | **panel Media** (timelines, video/audio/imágenes/docs, librería de SFX
  del plugin de audio, drag&drop que copia a `assets/`) | **Stage** (webview con la animación) +
  **Timeline** | panel de **Agentes** a la derecha (chats y terminales en pestañas).
- Modos: **Studio** (construir) y **Research** (pestañas Brief → Research → Hooks & Scripts →
  Thumbnails → Keywords, renderizando los archivos del pipeline). Página **Publish** sobre Build.
- **Hot reload**: un `fs.watch` por ventana; `project.json` 150 ms, timelines 200 ms,
  workspace 120 ms, resto 400 ms. Se silencian las escrituras propias para no romper el undo.
- **Recovery view**: si un JSON se rompe nunca queda en blanco; muestra archivo + error y un
  **prompt "Fix with Claude"** listo para copiar.
- **Herramientas de referencia visual** sobre el stage pausado: *Copy frame*, *Copy timestamp*,
  *Copy context for agent*, **Annotation capture** (congela el frame, hasta 8 rectángulos,
  copia recortes o una hoja numerada). Todo va al portapapeles para pegarle al agente.
- Panel específico por plantilla (p. ej. "Pose Studio" para drawing-animation).
- Timeline Health: valida y ofrece "Auto-fix safe" / relink de medios faltantes.

---

## 5. Exportación (el cuello de botella)

Pipeline común a UI y CLI:
1. Abre **ventanas Chromium ocultas/offscreen** ("workers", 1–20) que cargan la animación con `kcembed=1`.
2. Para cada fotograma: `seek`/`renderFrame(t)`, espera readiness (10 s; 15 s en warm-up),
   `capturePage()` → bitmap → JPEG/BGRA.
3. Lo manda por pipe a **FFmpeg** (`image2pipe mjpeg` o `rawvideo bgra`).
4. Composición final: audio mezclado (pistas + clips de videoclip), overlays por orden de pista,
   marca de agua (plan Free), etiquetas BT.709, `+faststart`.
5. **Validación** antes de reemplazar el destino: dimensiones, cantidad de frames, FPS, duración, audio.

**Motores:**
- `standard` (default): captura en paralelo en *chunks* intermedios → concat + encode final.
- `single-pass`: 1 ventana offscreen, 1 encoder.
- `experimental-1`: captura paralela → cola ordenada → **un solo encode** (sin chunks).

**Encoder:** prueba (0,2 s de encode nulo, luego 12 frames reales) `h264_nvenc` → `h264_amf` →
`h264_qsv` en Windows; si falla cae a `libx264` para el resto de la sesión. Solo **H.264 MP4**.
Calidad = "escalera" por encoder (low/standard/high/max ↔ CRF 30…18, NVENC `-cq` 33…19 con p5/p6 + spatial AQ).
Resoluciones: 720p / 1080p / 4K (lado corto), FPS 1–240 (incluye 23.976/29.97).

**Workers automáticos:** según núcleos y RAM física (reserva ≥ 50 % RAM), presión de memoria y
temperatura; mide una escena antes de abrir el resto. Timeouts: 60 s por captura, 30 s escritura
bloqueada, 120 s finalización, 180 s mux sin progreso. Reintento automático único con
1 worker + software. WebGL context-loss aborta en vez de exportar frames negros.

> **Por qué es lento en tu PC:** la codificación ya usa NVENC; lo que come CPU es
> dibujar + capturar + convertir a JPEG cada fotograma en Chromium.

---

## 6. CLI `coa`

`CoAnimator.exe --cli <comando>` (en Windows `resources\coa.cmd`; instalable en PATH desde Settings).
- `coa render <proyecto|carpeta|.coa> [--resolution 720p|1080p|4k] [--fps] [--quality low|standard|high|max]
  [--preset 1080p30…] [--start s] [--end s] [--engine standard|single-pass|experimental-1]
  [--workers auto|1|2|4|6|8|10|12|16|20] [--mode quick|efficient] [--software] [--timeline id|nombre] [--out ruta.mp4]`
- `coa pack <proyecto> [--out x.coa]`, `coa unpack <x.coa> [--out carpeta]`.
- Progreso en stdout: `[cli] capturing N%`, `[cli] encoding N%`, `[cli] verified: …`, `[cli] done: …`. Exit 0/1.
- Free: rechaza pedir más de 720p ("Free exports are limited to 720p…").
- Skill `coa-cli` para que Claude/Codex lo usen.

---

## 7. Paquetes `.coa`

ZIP sin compresión con todo el proyecto + `coa-package.json` (`format, version, minAppVersion,
appVersion, packedAt, template, project`). Excluye `renders/`, `node_modules`, `.git`, secretos.
Se comporta como documento: sidecar `.coa-state.json` liga la copia de trabajo al archivo;
matriz de apertura (sin cambios / copia sucia / paquete cambiado / conflicto) con prompts
Keep/Discard/Backup. Guardado = re-empaquetar (Cmd+S, al cerrar, al salir). Escritura atómica `.partial`.

---

## 8. Plantillas (catálogo remoto)

Se descargan de un registro (zip + sha256) al crear el proyecto; manifiesto `template.json`
(`coa-template/1`): `files/` copiado con sustitución `{{PROJECT_NAME}}` etc. solo en globs
declarados, `variants` ("looks": HTMLs alternativos), `samples` (.coa de ejemplo),
`starterSample`, `claude/skills` + `claude/agents` que se siembran en `APP_ROOT/.claude`.

| id | Categoría | Qué hace | Archivo de datos que edita la IA |
|---|---|---|---|
| product-demo | Demos | Reel de producto, tipografía fuerte, estudio luminoso | `index.html` |
| studio-effects | Effects | 35 efectos sobre video real (texto detrás de persona, doodles, captions tipo podcast, montajes) | `index.html` |
| map-animation | Effects | Viaje sobre mapa acuarela, cámara entre coordenadas reales, postales | — |
| motion-graphics | Explainers | Títulos cinéticos, formas, transiciones (el default) | `index.html` |
| talking-head-tutorial-template | Explainers | Grabación de pantalla + presentador en esquina (cuadrado/burbuja/recorte con alpha) | `index.html` (objeto `CONFIG`) |
| drawing-animation | Explainers | Trazos que se dibujan, acuarela, letra manuscrita; looks ink/pencil/illustrated/watercolor | `assets/film-data.js` |
| scene-explainer | Explainers | PDF/manga/cómic → paneles detectados, narración TTS, Ken Burns | `scenes.json` |
| 3d-explainer | Explainers | Mundos low-poly Three.js, cámaras cinemáticas, subtítulos | `world-data.js` |
| ascii-terminal | Explainers | Estética terminal retro, tipeo, glitch | `index.html` |

Patrón clave: **la IA escribe datos declarativos y un motor prehecho produce lo visual.**
Skills de plantillas mencionadas: `motion-graphics`, `3d-explainer`, `drawn-animation`,
`scene-explainer`, `studio-video-effects`, `animation-audio-sync` (transcribe la voz y ajusta tiempos de escenas).

### 8-bis. Las skills de dirección artística (descargadas y leídas el 2026-09-26)

Bundles oficiales descargados de `assets.coanimator.com/templates/…` (autorizado por el usuario), leídos y
borrados. Cada skill SKILL.md declara `license: MIT` (motion-graphics, drawn-animation, 3d-explainer,
scene-explainer, ascii-terminal) — aun así OpenAnimator escribe las suyas desde cero.
Cada plantilla trae además **samples `.coa` terminados** que las skills mandan estudiar (few-shot real).

**Principios transversales (la verdadera "salsa"):**
1. **Todo frame = `render(t)` puro.** Nada se "reproduce"; sin tweens con estado, sin `Math.random`/`Date.now`
   (sólo `hash(i)` o semillas fijas). Habilita scrub, hot reload, `?t=` y export paralelo.
2. **Guion → audio → timestamps por palabra → beats.** Nunca al revés. "La tabla de palabras es la spec de
   cada beat". Cambiar voz/modelo invalida todos los tiempos (un cambio llevó un film de 30 s a 39 s).
3. **Tabla de beats escrita como comentario ANTES de codificar** (`0.00 → 5.20 S1 wght pulse …`), ventanas por beat,
   VO entra ~0.3 s después de su escena; el texto en pantalla adelanta a la voz un beat.
4. **Diseño con sistema:** unidad `--u` = 1 px de diseño 1080p (todo escala), tokens de color (nunca hex sueltos),
   una sola `render()`, `envelope()` de entrada/salida compartido, **nunca interpolar lineal** (outCubic/outBack/outExpo,
   smootherstep para movimientos grandes), escenas ocultas se resetean.
5. **Anti-monotonía deliberada:** cortes de fondo (blanco → tinta → flood de marca) para que 30 s no se aplanen.
6. **Lenguaje de cámara explícito** (3D): bajo y nivelado, un movimiento lento por plano y luego descanso,
   beats clave centrados y simétricos, capas foreground/mid/far, una locación ancla con **arco de luz** que cuenta el tiempo,
   "ghost keywords" en el mundo con opacidad 0.12. Cortes duros entre escenas.
7. **SFX derivados del schedule** (no a mano): `sfxEvents('pencil')` por cluster de trazos, brush en cada fill;
   volúmenes 0.12–0.25; disparar sólo al cruzar en reproducción, nunca al hacer seek; elegir SFX por medición
   (silencedetect/volumedetect) entre 3 candidatos; mezcla `amix=normalize=0`.
8. **QA doble obligatorio:** auditoría automática de layout (texto×texto, texto×tinta, fuera de cuadro barriendo
   cada 0.2 s) **y** capturas de 3+ beats — "un audit que comparte el bug del renderer lo confirma en vez de detectarlo".
   Scrub hacia atrás y adelante. Smoke export `coa render --preset 720p30`.
9. **Listas de bugs reales** documentados (fades que no aplican por `globalAlpha` sobrescrito, crash de Chrome por
   `feTurbulence` animado, SFX ametralladora al scrubear, Babel/JSX, tiles del mapa, saltos de cámara 1 frame, export negro).
10. **Datos separados del motor:** la IA edita `world-data.js` / `film-data.js` / `scenes.json` / `map-data.js` / `CONFIG`,
    nunca el motor. Estilo = piel intercambiable sobre el mismo timeline (drawing: ink SVG / pencil / illustrated / watercolor SVG / watercolor canvas).
11. **Reglas de costo:** assets de IA por *plano*, nunca por frame; animación local.

**Por plantilla:**
| Skill | Líneas | Núcleo |
|---|---|---|
| motion-graphics | 164 | Reel de 6 beats en un HTML (wght pulse, stagger blur, spec rows, mask reveal, flood, smash impact); o arquitectura React Stage/Sprite con `animate()/interpolate()`; disciplina de tiempos por VO; "tres duraciones, una verdad" |
| drawn-animation (+ styles/qa/audio.md) | 53+refs | Trazos que crecen por longitud de arco con jitter por índice+semilla, washes con ≥ 8 blooms (una fill radial = vector plano), 5 looks, auditoría con `window.__AUDIT`, voz "Sarang" ElevenLabs con settings |
| 3d-explainer | 234 | Mundo low-poly Three.js declarativo (`WORLD`: SCENES con env/cam/subs, ENTITIES: ground/tree/character/coin/table/beam/text3d/custom/model/scatter), GLB con clipTrack determinista, poses por huesos (boneMap, poseTrack, boneAnim, jiggle, boneLimits), acrobacias (backflip, cartwheel), lenguaje de cámara |
| studio-video-effects | 293 | Efectos sobre video real: mattes (Vision macOS / RVM), tracking de cámara (LK + RANSAC), texto detrás de la persona, 36 case studies (textbehind, podcast, reel, doodle, Nano Banana, cine intro, UI card, matting), reglas de suavidad (gráficos a 50 fps, smootherstep, rampa de oscilaciones 0.4 s, light wrap) |
| map-animation | 171 | Cámara sobre un plano de tiles acuarela (Stamen CC-BY), coordenadas y km reales (haversine), beat zoom→film→morph→hold→fly, corte vertical 9:16, continuidad de cámara verificada numéricamente, 3 trampas de export |
| scene-explainer | 90 | Manga/PDF → paneles → Ken Burns acotado (escala 1–1.10, salida ≤ 6 %), fondo blur del mismo panel, manga derecha→izquierda, narración 1 párrafo = 1 escena, +0.4 s de respiro |
| ascii-terminal | 89 | Grilla 96×30 en 3 capas (dim/base/accent), helpers (boxOutline, typeLine, bigText que resuelve desde ruido), campos de densidad con rampa ` ·:░▒▓█`, ~2.6 palabras/s de VO |
| talking-head-tutorial | 137 | Grabación full-bleed + presentador en esquina (cuadrado/burbuja/recorte alpha), todo en `CONFIG` |
| product-demo | (sin skill) | info.md: un beat = una idea, pantallas vivas (cursor, toggles, charts que cuentan), callouts numerados, antes/después, fondo calmo + un solo acento |

---

## 9. Sistema de agentes

### Tres rutas
1. **Terminal de agente**: pty con `claude`, `codex`, `gemini` o shell. Dos terminales: raíz de la app o carpeta del proyecto.
2. **Chat GUI de agente del proveedor**:
   - Claude vía CLI: `claude --print --output-format stream-json --input-format stream-json
     --include-partial-messages --permission-mode <modo> --permission-prompt-tool stdio --verbose`
     (stdin abierto = una sesión; permisos vía `control_request can_use_tool`; slash commands con
     `initialize`; historial leído de `~/.claude/projects/<slug>/*.jsonl`; `--resume`).
   - Otros vía **ACP** (Agent Client Protocol, JSON-RPC por stdio): Codex (`codex-acp`),
     Grok Build (`grok agent stdio`), OpenCode (`opencode acp`), Gemini CLI (`gemini --acp`).
     Modos, modelos, permisos, planes, diffs y login vienen del agente.
3. **Agente propio "Coa"**: proceso ACP con loop propio sobre `@yourgpt/llm-sdk`; proveedores
   OpenAI/Anthropic/Google/xAI por API key o suscripción ChatGPT/Grok (OAuth device).
   Herramientas: `read, write, edit, glob, grep, bash` (confinadas a la carpeta, salida acotada),
   `media_info` y `view_media` (hasta 4 frames de un video/imagen, 1280 px, vía FFmpeg),
   `skill` (carga una skill bajo demanda), + herramientas MCP. Slash: `/compact /clear /context /model /tools`.
   Compactación automática al 70 % del contexto.
- Hand-off entre agentes (últimos N turnos ≤ 12 KB), recibos de archivos cambiados por turno.
- Inyecta claves por entorno a cada sesión (`ELEVENLABS_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY`, `SCREENSHOTONE_ACCESS_KEY`).
- Instrucciones: `CLAUDE.md`/`AGENTS.md`/`GEMINI.md` en APP_ROOT + "Agent Notes" editables en Settings.

### Servidor MCP propio (`coa-mcp`)
`project_info`, `timeline_read`, `timeline_annotations`, `annotation_resolve`,
`timeline_add_clip`, `timeline_remove_clip`, `assets_list`. No renderiza ni gasta dinero.
Configurable para cualquier agente vía `.mcp.json`.

### Cómo "ve" hoy el agente (corregido tras ver una sesión real del usuario)
CoAnimator **no trae** una herramienta dedicada para que el agente vea la animación, pero
Claude Code **sí puede ver** porque su herramienta `Read` abre imágenes (PNG/JPG). En la sesión
del usuario (`research/overlap-audit/`) Claude **improvisó** todo el circuito:
1. `run.py`: abre cada capítulo en **Chrome headless** (`--headless=new --virtual-time-budget=60000
   --dump-dom`, 1920×1080) con un `audit.js` inyectado.
2. `audit.js`: recorre la línea de tiempo, mide `getBoundingClientRect` de elementos etiquetados
   (`data-c="chip|figure|node|label"`) y reporta **solapamientos/desbordes** en JSON
   (~330 incidencias → 0 tras los arreglos).
3. Renderiza clips de prueba (`coa render` de tramos cortos) y arma una **hoja de contacto**
   (`sheet.png`) que lee con `Read` para verificar visualmente.
4. Aplica arreglos con scripts `fix*.py` de reemplazo exacto (con `assert` de conteo) sobre `engine.js`.

O sea: la capacidad existe, pero es **ad hoc** — el agente tiene que reinventar el auditor, el
render de frames y la hoja de contacto en cada proyecto, gastando tiempo y tokens.

### Qué le falta a CoAnimator (oportunidad)
- Herramientas **integradas** de `render_frame` / `contact_sheet` / auditoría de layout
  (lo que Claude tuvo que construir a mano arriba).
- El MCP no expone crear escenas, render de preview, ni sincronía con voz.

---

## 10. Pipeline de producción `/video-plan`

Skill + workflow JS (`.claude/workflows/video-plan.js`) + 7 agentes:
1. **Intake** (5 preguntas: tema, codebase, duración 15s/30s/60s/2-3min, audiencia, tipo) → `brief.md`.
2. **Research** en paralelo: `feature-analyst` (lee un codebase → `feature-spec.md`) +
   `yt-researcher` (top 20 de YouTube vía MCP de mcp360: transcripts, hooks, keywords, miniaturas).
3. **Script**: `script-writer` genera 3–5 variantes por ángulo (hook/problem/demo/vs), prosa pura para TTS + frontmatter (títulos, tags, keywords, descriptionHook).
4. **Judge**: por variante, 3 `script-judge` (claridad / gancho / fluidez TTS) con JSON schema → `SCORES.json` (ship/revise/drop).
5. **Thumbnail**: `thumbnail-strategist` → 6 conceptos con brief de diseño.
6. **Voice** (confirmado por el usuario): `voice-renderer` → `voice/<variante>/part-N.mp3` + `manifest.json`; botón "Place on timeline".
7. **Metadata**: `social-writer` → títulos, descripción, tags, capítulos, posts X/LinkedIn; `youtube-publish` escribe `metadata/youtube.json`.
Fases re-ejecutables por separado (`/video-plan research --force`, etc.), cache por archivos.

---

## 11. Plugins (`plugin.json`, `coa-plugin/1`)

Acciones `claude-spawn` (lanza `claude --print` con prompt templado `{{VAR}}`) o `builtin`.
Estado: sólo se guarda `enabled`; `configured` se deriva; `active = enabled && configured`.
Secretos cifrados con safeStorage, nunca en el proyecto.

| Plugin | Tipo | Función |
|---|---|---|
| audio-elevenlabs | audio | TTS, SFX (librería incluida), música; skill `text-to-speech` externa |
| audio-fish *(drop-in del usuario)* | audio | TTS Fish Audio (S2.1 Pro…), clonación de voz, `FISH_API_KEY` |
| gemini-images | image-gen | Nano Banana (generar/editar imágenes) |
| grok-imagine | video-gen | Imágenes y **clips de video** xAI (con confirmación y límites de costo) |
| screenshotone | web-capture | Capturas de sitios, página completa, elemento, scroll MP4/GIF |
| youtube | publishing | OAuth Google, subir, miniatura, playlist |
| youtube-research | research | Requiere MCP mcp360 de YouTube |
| postiz | scheduling | Publicación multi-red programada |

Reglas de costo en skills de generación: confirmar antes de video, nunca regenerar en bucle,
generar assets **por plano** y animarlos localmente (nunca por frame).
Assets de stock en CDN público: fondos (33 packs), modelos 3D GLB de dispositivos
(CC-BY, requieren crédito) y marcos 2D, con receta para poner medios en la pantalla 3D.

---

## 12. Herramientas sueltas (menú Tools)

- **Auto Captions**: Whisper local (tiny/base/large-v3-turbo, WebGPU o wasm), timestamps por
  palabra, edición de cues (merge/split/retime), estilos = **Look × Motion × Emphasis**
  (9 looks, 7 movimientos, 5 énfasis tipo karaoke), exporta SRT/VTT o quemado en video.
- **Dub**: doblaje con ElevenLabs (API Studio v1 con voz elegida, $0,50/min; o Project v2 clonando, $2,20/min).
- **Quick Convert**, **GIF** (paleta, dithering, estimación de tamaño), **Mockup Motion**
  (dispositivos 2D/3D con movimientos y export MP4).
- **Tools Library**: salidas en `~/Videos/CoAnimator/<fuente>-<hash>/` con índice `.coa-library.json`.

---

## 13. Licencia, planes y telemetría

- **Pro = US$99 licencia perpetua**, incluye 1 año de actualizaciones. Activación por dispositivo
  (id derivado de la máquina, hasheado). Validación al iniciar y cada 24 h; gracia offline 14 días.
- **Free**: exporta máx. **720p** (lado corto) con **marca de agua**, aplicado en el proceso principal
  (también en el quemado de subtítulos). Nunca bloquea abrir proyectos.
- Telemetría de uso y errores (opt-out en Settings → Privacy), `telemetry.log` local.
- Anuncios remotos (`app-announcements.json`), updates con canales stable/beta.

---

## 14. El proyecto del usuario (*Medicina Interna*) — pipeline propio

**No es una plantilla de CoAnimator** (no tiene sello `template`). Es un pipeline construido a
medida en sesiones con agente, a partir de `C:\Users\Emilio\Downloads\guion_completo.txt`:

- `assets/engine/build.py`: por capítulo → texto normalizado → **Fish TTS** por párrafo/segmento
  (con reintentos, cache por clave) → **ASR de Fish** (`/v1/asr`) para **tiempos por palabra** →
  arma escenas → escribe HTML + timeline + mezcla de SFX.
- `tts_norm.py`: normalización del español médico hablado (siglas → palabras: "IECA/ARA-II" → "IECA o ARA dos", etc.).
- `assets/chapters/<cap>.cfg.json` (título, bloque, héroe), `<cap>.cur.txt` (**DSL de curación**:
  `párrafo | h:ícono | t:título | c:chip @palabra-clave #ícono`), `<cap>.sfx.json` (cues de SFX),
  `<cap>.js` (`window.CHAPTER` con `sections` y `beats` con tiempos absolutos).
- `engine.js` (~53 KB): motor documental: paletas temáticas (paper, sand, mint, navy, plum, teal),
  parallax, cámara con recorridos, 8 plantillas de escena, barra de progreso por capítulo.
  Beats: `opener`, `map`, `board`; tarjetas `concept`, `drug`, `matrix`, `quiz`, `sub`, `versus`.
  `icons.js`: biblioteca de íconos SVG médicos. Escenario SVG vectorial **1920×1080**.
- 24 timelines, ~2 h 48 min en total, 30 fps.

→ Es un buen caso de prueba y referencia de lo que el usuario necesita. Confirmar con el usuario
que ese código lo generó su propio agente antes de reutilizarlo en OpenAnimator.

---

## 14-bis. Por qué el resultado NO es "slop" (análisis de las sesiones reales del usuario)

Fuente: las 2 conversaciones de Claude Code en `~/.claude/projects/C--Users-Emilio-AppData-Roaming-CoAnimator-projects-medicina-interna/`
(~23 MB) y su memoria. **Conclusión: CoAnimator no aportó ninguna plantilla ni dirección de arte a este
proyecto.** La calidad salió de un *proceso* que Claude siguió dentro de un *medio* que CoAnimator hace posible.

### ¿Qué prompt le da CoAnimator a Claude? (verificado en código y en el transcript)
- Chat "Claude Code CLI" (`entrypoint: coanimator-chat`): lanza el `claude` normal en la carpeta del proyecto
  **sin `--append-system-prompt` ni texto inyectado** en los mensajes (el mensaje del usuario llega tal cual).
  Claude recibe: el system prompt estándar de Claude Code + el `CLAUDE.md` de `APP_ROOT` (cargado por
  "walk-up"; son notas técnicas del modelo de la app, archivos que no tocar y docs a leer — incluso restos
  de notas internas del desarrollador) + la lista de skills (`video-plan`, `coa-cli`, generación de imágenes…)
  y los agentes del pipeline. **Nada de dirección de arte.**
- Agente propio "Coa": `SYSTEM` corto con reglas técnicas (leer antes de editar, no tocar archivos de la app,
  usar `view_media`) + `AGENTS.md`/`CLAUDE.md` + lista de skills. Tampoco dirección de arte.
- La dirección artística de CoAnimator vive en las **skills de cada plantilla** (motion-graphics, 3d-explainer,
  drawn-animation, scene-explainer, studio-video-effects), que sólo se instalan al usar esa plantilla.
  El proyecto del usuario no usó ninguna.

### Lo que aporta el medio (CoAnimator)
- **El video es código**: HTML/SVG/JS vectorial en función de `t`. Es el terreno donde Claude es
  realmente fuerte (diseñar con código), en vez de generar píxeles con IA (la fuente típica del slop).
- **Loop corto**: el editor recarga en ~200 ms, el timeline une voz/música/SFX, y `coa render` exporta tramos de prueba.
- **Contexto**: docs (`timeline.md`, contrato `__kcControl`) que le enseñan el formato al agente; claves de APIs inyectadas por entorno.

### El proceso que hizo la diferencia (paso a paso, tal como pasó)
1. **Referencia visual concreta**: el usuario adjuntó un video de estilo. Claude sacó fotogramas con FFmpeg,
   armó **hojas de contacto** (`ref/sheet_01.jpg`) y las miró → definió el estilo: papel + tinta,
   **cámara continua con zooms entre escenas** (célula → sol → galaxia → ojo), nada de slides.
2. **Audio primero**: guion hablado → TTS **con timestamps por palabra** (ElevenLabs `with-timestamps`,
   luego Fish TTS + Fish ASR). **Cada elemento visual entra cuando el narrador dice esa palabra.**
   Esto es lo que da la sensación de documental profesional.
3. **Música compuesta a medida**: tras el pedido "estilo Kurzgesagt", música con ElevenLabs `/v1/music`
   usando un `composition_plan` cuyas **secciones coinciden con los tiempos de las escenas**
   (builds en cada cambio). Medición de niveles y mezcla por debajo de la voz (0.3 → 0.18).
4. **SFX por evento**: pop cuando aparece un chip, whoosh en transiciones, boom/rise en aperturas; premezclados en una pista.
5. **Aprobación por tramos**: minuto 1 → aprobación → minuto 2… Cada decisión del usuario quedó en la memoria
   del proyecto (voz, música, volumen, un clip por párrafo, etc.) y se aplicó en adelante.
6. **Autorevisión visual constante**: después de cada cambio, render de fotogramas clave → `Read` de la imagen →
   corrige solapamientos, textos cortados, tiempos. Más tarde lo sistematizó en un **auditor automático**
   (Chrome headless + `audit.js` midiendo bounding boxes; ~330 incidencias → 0) que debe quedar en 0 tras cada cambio.
7. **Escalar con un motor + DSL**: cuando el trabajo manual no escalaba a 2 h 48 min, Claude escribió un motor
   (`engine.js`) y un mini-lenguaje de curación (`cur.txt`: ícono, título, chips, palabras ancla) → `build.py`
   genera los 24 capítulos. Claude anota el contenido; el motor garantiza consistencia visual.
8. **Anti-monotonía explícita** (tras "hacelo 10 veces más profesional, es monótono"): motor v2 con
   **8 tipos de escena que se alternan sin repetir dos seguidas** (figura humana que enciende órganos al
   nombrarlos, cifra gigante con anillo, mosaico, línea de pasos, etc.), 6 paletas de fondo, parallax,
   cámara siempre en movimiento que se **auto-encuadra** a la caja medida de cada tarjeta, transiciones entre capítulos.
9. **Voz = pantalla**: normalizador del texto hablado (siglas médicas, "10-9" → "10 a 9", "120/80" → "120 sobre 80",
   pausas tras cada "Título:" renderizando por segmentos con silencios fijos). Auditoría de todos los guiones.
10. **Honestidad y verificación**: medir niveles de audio, verificar con ASR que las pausas existen,
    reportar qué se verificó y qué no (p. ej. "no escuché el audio").

### Lecciones para OpenAnimator (lo que hay que convertir en producto)
- Tratar **referencia de estilo → hojas de contacto → guía de estilo escrita** como el primer paso de todo proyecto.
- **Pipeline audio-first nativo**: TTS/ASR con tiempos por palabra y "anclas" (palabra → aparición visual) como dato de primera clase.
- Música por secciones sincronizada a escenas; SFX automáticos por tipo de evento.
- **Motores de escena data-driven con reglas de variedad** (no repetir tipo, rotar paletas, cámara siempre viva).
- **Auditor de layout + hojas de contacto + render de frames** integrados y ejecutados automáticamente después de cada cambio.
- Memoria de preferencias del usuario por proyecto y aprobación por tramos.
- Normalizador "voz = pantalla" por idioma/dominio.

---

## 15. Oportunidades para OpenAnimator (mejor que CoAnimator)

1. **Feedback visual integrado**: herramientas MCP `render_frame(t)`, `contact_sheet(n)`, `preview_clip(a,b)`
   listas para usar (hoy Claude las improvisa con Chrome headless + `Read` de PNG; ver §9).
2. **Linter de layout integrado**: inspección del DOM en N instantes (overflow, solapamientos, contraste,
   texto ilegible, safe areas) — generalizar lo que hizo el `audit.js` de la sesión del usuario,
   con convención de etiquetas `data-*` en los componentes del motor.
3. **Reloj virtual inyectado**: capturar cualquier HTML (CSS animations, rAF, `Date`, `performance.now`) sin exigir el contrato; `renderFrame` opcional.
4. **Export rápido**: render paralelo con GPU, NVENC H.264/HEVC/AV1, 10-bit, 4:2:2/4:4:4, capítulos, segmentos reanudables, sin límites de resolución ni marca de agua (ya prototipado en `coanimator_gpu_export.py`).
5. **Voz y tiempos gratis/local**: TTS local (Kokoro/Piper) + alineación Whisper/WhisperX para *cualquier* audio, incluida voz grabada; normalizador de texto por dominio.
6. **Motores/plantillas open source**: documental (tipo el del usuario), motion graphics, explicador 3D, dibujo, captions; todos data-driven y documentados para la IA.
7. **DSL de curación** como el del usuario (texto → escenas) como formato de primera clase.
8. **MCP más rico**: crear/editar escenas, generar voz, sincronizar, renderizar preview, gestionar assets.
9. **Formato abierto y versionado** + CLI + importador de proyectos CoAnimator (interoperabilidad, sin usar su código).
10. Mantener lo que funciona: hot reload, recovery view con prompt de arreglo, notas para la IA ancladas al tiempo, checkpoints, pipeline de agentes con jueces.
