# OpenAnimator

Alternativa open source a CoAnimator: estudio de escritorio para crear videos animados con
HTML/SVG/JS generados por IA, timeline, voz y exportación con GPU (NVENC).

- Stack elegido: **Electron + React + TypeScript**.
- MVP: render/exportación GPU, editor con timeline, generación de escenas con Claude.
- El usuario tiene RTX 5070 (NVENC H.264/HEVC/AV1, 10-bit, 4:2:2, 4:4:4) y FFmpeg 9 instalado vía winget.

## Antes de trabajar, leé
- `docs/investigacion/coanimator-analisis.md` — análisis completo de CoAnimator (arquitectura,
  formatos, export, agentes, plugins, plantillas, licencias) y lista de mejoras.

## Reglas
- **Sala limpia**: no copiar código, prompts, motores, plantillas ni textos de CoAnimator.
  Sólo reimplementar funciones desde cero.
- No leer `%APPDATA%\CoAnimator\plugin-secrets.json` ni otros archivos de claves.
- `referencia-exportador/coanimator_gpu_export.py` es el exportador GPU previo (Python/Tk) y sirve de referencia para el módulo de export.

## Interfaz
- Kit propio en `src/ui/` (`kit.tsx`: Button, Select, Menu/useMenu, Switch, Segmented, Slider, NumberInput,
  Tabs, Badge, Empty…; `icons.tsx`: íconos SVG propios). Usarlo siempre; no `<select>` ni emojis como íconos.
- Diálogos con `useDialogs()` (`components/Dialogs.tsx`): `window.prompt` NO existe en Electron.
- Tooltips: atributo `data-tip` (+ `data-kbd` para el atajo). Tokens de color/medidas en `src/styles.css`.
- Ajustes: esquema en `electron/settings.ts`; `DEFAULTS` + merge profundo en `electron/settings-defaults.ts` (sin Node:
  lo comparte Android); en la interfaz `useApp().updateSettings`.

## Plugins, plantillas y análisis de video
- `electron/plugins.ts`: ChatGPT vía Codex CLI (cuenta del usuario, `codex exec --json`; las imágenes quedan en
  `~/.codex/generated_images/<thread_id>/`), OpenAI, Gemini, OpenRouter, ElevenLabs, Fish Audio, yt-dlp,
  y Whisper local (primero para transcribir): `app/whisper/transcribe.py` con el Python del usuario (torch +
  transformers), sólo modelos ya presentes en la caché de Hugging Face (`HF_HUB_OFFLINE=1`, nunca descarga);
  la app le pasa PCM float32 16 kHz hecho con su FFmpeg y lee el JSON de la última línea de stdout.
  Claves cifradas con safeStorage en `data/secrets.json` (`electron/secrets.ts`); nunca en settings ni en la interfaz.
- La IA los usa por MCP (`oa_generar_imagen`, `oa_generar_voz`, `oa_generar_sfx`, `oa_transcribir`, `oa_consultar_ia`,
  `oa_plugins`, `oa_voces`) → API local (`electron/api.ts`, sin límite de tiempo por pedido).
- Plantillas del usuario en `data/templates/u-*` (servidas como `oa://ut/…`); `saveProjectAsTemplate` en projects.ts.
- `electron/analyzer.ts`: video/YouTube → métricas FFmpeg + fotogramas → Claude Code headless escribe
  `_analisis/analisis.json`, `brief.md`, `scenes/estilo.html` en un proyecto oculto `data/projects/.analisis-*`.
- Adjuntos del chat → `<proyecto>/adjuntos/`. Visor a pantalla completa con la API Fullscreen (tecla F).
- Verificación de la interfaz: `electron . --remote-debugging-port=9333` + `.tools/cdp.mjs`; `OA_TEST_PICK` responde
  los diálogos de archivo.

## Trampas aprendidas
- **No** usar `disable-frame-rate-limit` / `disable-gpu-vsync`: acelera la captura ~1,4× pero `capturePage`
  devuelve cuadros viejos (11 de 900 incorrectos). Verificar exportaciones con PSNR por cuadro contra una referencia.
- Los segmentos de exportación se achican para repartir videos cortos entre workers (`segFrames` en exporter.ts).
- Mezcla de audio: limitar cada entrada con `-ss/-t` y usar `apad=whole_dur`; si no, FFmpeg a veces se cuelga.
- Modelos verificados con Claude Code: claude-opus-5-5, claude-sonnet-5, claude-haiku-4-5 (Fable 5.1 pide créditos).

## Chat, consumo y medios
- `electron/claude.ts` lanza el proceso; el protocolo (mensajes, permisos, opciones en caliente) está en
  `electron/claude-session.ts` (sin Node, lo usa también la tablet). `stats()` mide el contexto con el `usage` de cada `message_start`
  (input + cache) y la ventana con `modelUsage[].contextWindow` del `result`; `compact()` manda `/compact`
  y el `system/compact_boundary` avisa. Modo ahorro (`settings.claude.saver`, activado por defecto) agrega
  reglas `SAVER` al system prompt. `oa_ver_fotogramas` usa 960 px por defecto (las imágenes son lo más caro).
- Los eventos del chat se mandan a todas las ventanas (`send` en main.ts). El chat separado es otra
  BrowserWindow con `?chat=<proyecto>&session=<id>` que se conecta con `chat:get`; el editor le pasa el
  cursor con `chat:setCtx`. Terminal: `shell:terminal` abre `claude --mcp-config … --resume <id> --fork-session`
  con `windowsVerbatimArguments` (sin eso Node escapa las comillas y cmd.exe no arranca).
- `.chat-list > * { flex-shrink: 0 }`: sin eso las tarjetas se aplastaban a 10 px con el chat lleno.
- Medios: tipo `doc` (md, txt, pdf, json, srt…) para los guiones que escribe la IA; borrar = `shell.trashItem`
  (Papelera, recuperable); vista previa abajo del panel y ampliada en un modal. `@` en el chat busca en
  `project:files`. Colores de pista por rol (`trackRole`: voz, música, sfx) en Timeline.tsx.
- Cambiar opciones NO debe cortar el turno: `setOptions` usa `control_request` `set_permission_mode` y
  `set_model` en caliente; esfuerzo/modo ahorro relanzan el proceso con `--resume` recién al terminar el turno
  (`restartWhenIdle`). El `close` de un proceso viejo no pisa `this.proc` del nuevo.
- Historial: `listSessions`/`loadTranscript` leen `~/.claude/projects/<ruta con [^a-zA-Z0-9]→->/*.jsonl`
  (título = último `aiTitle`); retomar = `chat:create` con `resume`.

## Android (tablet) — `android/`, `src/android/`
- Misma interfaz React; `src/android/backend/` implementa los canales de `electron/main.ts` sobre el puente
  nativo (`window.AndroidBridge`, `src/android/host.ts`). `src/platform.ts` (`isAndroid`, `projectUrl`,
  `compositorUrl`) resuelve las diferencias: nunca escribir `oa://` a mano en la interfaz.
- Orígenes: interfaz `https://appassets.androidplatform.net` (+ `/fs/` datos, con CSP sandbox; `/app/` recursos)
  y proyectos `https://oaproject.androidplatform.net/p/<id>/` (escenas, `__oa/` compositor).
  El puente pide un token nuevo por carga, que Java mete en el documento principal
  (`<meta name="oa-bridge">`, `AppServer.page`): los iframes de los proyectos también ven el puente, no el token.
- Claves: sólo en Java (Keystore). La interfaz manda `{{secret:NOMBRE}}` y Java lo reemplaza **sólo en
  cabeceras** y sólo hacia el host de ese servicio (`SECRET_HOSTS` en `Bridge.java`).
- Chat: `agent.ts` usa `@anthropic-ai/sdk` con `fetch` nativo (`nativeFetch`: eventos head + chunk). Historial
  sólo-agregar; sistema y herramientas congelados por conversación y guardados en `<proyecto>/.oa-chat/`
  (imágenes aparte en `img/`); los cambios de opciones van como notas en el próximo mensaje. Un 400 o un
  rechazo antes de responder deshace el mensaje (`rollback` en `run`); `block_binding: drop_block` por si el
  historial cambia (imágenes quitadas por tamaño: `trimImages`). Imágenes a Claude ≤ 1920 px por lado. Streaming ansioso
  de herramientas → validar entrada (`__json_buf` estricto + `validateInput`). `fallbacks: 'default'`.
- Claude con el plan (por defecto, `settings.claude.backend = 'termux'`): el Claude Code oficial corre en Termux.
  La app instala y arranca por `RUN_COMMAND` (`TermuxLink.java`) un puente (`android/termux/bridge.mjs`, token por
  stdin, 127.0.0.1:47821) que lanza `claude -p` stream-json con `--tools ""` y sólo el MCP `openanimator`
  (`oa-mcp.mjs` → puente → app → `tools.ts`): los proyectos viven en la app. El protocolo del chat es el de la PC
  (`electron/claude-session.ts`, compartido); `code.ts` es el transporte. Nunca leer credenciales de Claude.
- El backend le devuelve a la interfaz copias (`copy` en events.ts, como el IPC de Electron): sin eso los
  objetos vivos (p. ej. la lista del chat) se duplicaban en pantalla.
- Fotogramas/exportación: el compositor rasteriza el DOM con modern-screenshot (`rasterAt`, mensaje `frame`);
  la exportación manda JPEG a `enc.frame` (MediaCodec + EGL) y el audio mezclado con Web Audio a `enc.audio`.
  El audio de los archivos lo decodifica Java por tramos (`audio.decode`, `audio.peaks` en `AudioDecoder.java`):
  nunca leer un video entero en el WebView. Pantalla encendida con `holdAwake()` (`wake.ts`, cuenta pedidos).
- Interfaz táctil: `html.touch` + `src/android/tablet.css`; editor con pestañas Editor | Claude y paneles
  (`drawer`), timeline con toques (seleccionar, arrastrar el seleccionado, pellizcar zoom); botón atrás con
  `useBack()` (`src/android/ui/back.ts`). En WebView no hay `window.confirm`/`prompt`: usar `useDialogs()`.
- Probar sin tablet: `node android/scripts/build-web.mjs && node android/dev/server.mjs --mock-claude`
  (Termux se imita con el puente real y `android/dev/fake-claude.mjs`).
  APK: `bash android/build-apk.sh` (sin Gradle). Detalles en `android/README.md`.
