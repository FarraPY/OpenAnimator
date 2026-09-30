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
- Salir del editor NO corta a Claude: ChatPanel manda `chat:leave` (la conversación queda "estacionada" por
  proyecto, sigue el turno) y al volver `chat:forProject` la retoma; sin uso, se cierra a los 30 min. Mientras
  un chat del proyecto trabaja, `project:close` no cierra el compositor de fotogramas. Si no hay una abierta, se
  retoma la última del historial (`settings.claude.continueChat`, activado por defecto; el + empieza una nueva).
- Rendimiento del chat: `ChatRow` memoizado (re-dibujar y re-leer el markdown de toda la conversación con cada
  palabra trababa la tablet) y el texto que llega de a poco se manda agrupado cada 100 ms (`patchLater`). El editor
  junta las ráfagas de `project:changed` y recarga una vez (400 ms).
- Razonamiento oculto (Opus 5.5 en Claude Code): los `thinking_delta` traen sólo `estimated_tokens` → `ChatItem.tokens`
  («Pensando… · N mil tokens»; `at` = cuándo empezó, así el tiempo no vuelve a 0 al reabrir el chat). `signalAt`
  (último mensaje de Claude Code) avisa "puede haberse trabado" a los 150 s sin señales, salvo mientras corre una
  herramienta (`streamed` = entrada de la herramienta que va llegando). Todo mensaje entra por `received()` (la
  tablet los recibe ya leídos): llamar a `onMessage` directo no cuenta como señal y el aviso salta en falso.

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
  La app instala y arranca por `RUN_COMMAND` (`TermuxLink.java`) un puente (`android/termux/bridge.mjs`, node directo,
  token en `~/.openanimator/token`, 127.0.0.1:47821) que lanza `claude -p` stream-json con `--tools ""` y sólo el MCP
  `openanimator` (`oa-mcp.mjs` → puente → app → `tools.ts`): los proyectos viven en la app. El protocolo del chat es el
  de la PC (`electron/claude-session.ts`, compartido); `code.ts` es el transporte. Nunca leer credenciales de Claude.
  Si el puente no arranca, el error trae la salida de Termux y `~/.openanimator/bridge.log`. Trampa vista en la
  tablet: Node.js nuevo con OpenSSL viejo no enlaza (`CANNOT LINK EXECUTABLE`) → la preparación hace `yes | pkg upgrade`.
- Claude Code en Termux arranca con `--setting-sources ""`: sin hooks, complementos ni permisos de la configuración
  del usuario (un complemento suyo le metía instrucciones a la conversación). Lo que el instalador de Termux pone ahí
  (`autoUpdates: false`) lo cubre `DISABLE_AUTOUPDATER=1`.
- Memoria del WebView: con escenas pesadas el motor web se cerraba (Android reinicia la página). En la pestaña de
  Claude el visor del editor se desmonta, la vista previa lateral no se redibuja mientras Claude trabaja y
  `onTrimMemory` → evento `memory` → `trimFramePool()`. Si igual se cierra, Java recarga con `?recovered=1`
  (`recoveredBoot` en platform.ts): la interfaz vuelve al proyecto y a la pestaña (`localStorage` oa.openProject,
  oa.editorTab) y el puente, en vez de cerrar las conversaciones (`fresh`), se las pasa a la app (`adopt`: historia,
  permisos pendientes; retiene lo nuevo hasta `flush`) y code.ts las retoma (`TermuxChat.adopt` + `replay`).
- Whisper en la tablet: whisper.cpp 1.9.4 compilado en Termux por `android/termux/whisper-install.sh` (commit y
  SHA-1 de los modelos fijados; base/small/large-v3-turbo-q5_0). El audio viaja como PCM 16 kHz por el puente
  (`whisper.put`), `whisper.run` corre `whisper-cli -ojf --dtw <modelo> -nfa -bs 1 -sns -pp` y arma las palabras con
  `t_dtw`. Trampas de 1.9.4: sin `-l` asume inglés (usar `auto`); flash attention (por defecto) desactiva DTW; si no
  puede leer el audio termina con 0 sin JSON; el JSON no escapa caracteres de control (`lenientJson`).
- Tarjeta SD: `Fs.java` (una instancia por proceso, `Fs.get`) junta en `projects/<id>/…` los proyectos de la tablet
  (`files/data/projects`) y de la tarjeta (`getExternalFilesDirs()[1+]/projects`, sin permisos; se borra con la app);
  `@sd/…` es la carpeta de la app en la tarjeta. Lo nuevo va donde elige el usuario (SharedPreferences `storage`);
  un `rename` a un proyecto que no existe queda del mismo lado que el origen. Papelera y exportaciones van del lado
  del proyecto (`.trash`/`@sd/.trash`, ids `sd~…`; `exports`/`@sd/exports`) para no llenar la tablet. Mover
  (`storage.move`): copia a `.moving-<id>`, verifica bytes y archivos, renombra el original a `.moved-<id>` y
  recién ahí borra; `recover()` arregla un corte. Sin la tarjeta, los nombres de sus proyectos siguen ocupados
  (`cardProjects`). Poner/sacar la tarjeta → evento `storage`. Probar: `server.mjs --sd <carpeta>` y
  `POST /__dev/sd {present}`; la lógica de Java se probó en la PC con el android-all de Robolectric.
- El backend le devuelve a la interfaz copias (`copy` en events.ts, como el IPC de Electron): sin eso los
  objetos vivos (p. ej. la lista del chat) se duplicaban en pantalla.
- Captura de la exportación (`Capture.java`, compositor con `capture=1`: el escenario se escala a la vista;
  `__oaCap(t, n)` → `__oaCapDone`, pedidos en orden, sin interfaz JS). Se prueba en orden y, si uno falla a mitad,
  se sigue con el siguiente desde `enc.frames` (lo que ya está en el video):
  1. `gpu`: el WebView vive en una pantalla virtual privada (`Presentation`, 160 dpi) de W×(H+16) cuya Surface es
     una SurfaceTexture en el contexto EGL del codificador: la imagen nunca sale de la GPU. Con `marker=1` la página
     pinta el número del pedido en una franja de 8 celdas abajo (3 bits por celda; 0 = cambiando) y, antes del
     siguiente, espera rAF + una tarea. La cola de la pantalla virtual no espera (SurfaceFlinger la pone en modo
     asíncrono: una imagen que no se tomó se reemplaza), así que `Encoder.latch` toma cada imagen apenas llega, en
     el hilo del codificador y sin nada lento (la vista previa se lee chica y el JPEG se arma afuera): codifica la
     esperada (`gpuExpect`), ignora las viejas y, si llega una posterior, la esperada se perdió: no entra nada más
     hasta que Capture se entera (`gpuForget`) y la vuelve a pedir. Java pide hasta 2 fotogramas por adelantado
     (baja con cada pérdida, sube tras 90 sin) y sube la pantalla a su máxima frecuencia (`preferFastDisplay`).
     Antes de Android 11 la ventana necesita `TYPE_PRIVATE_PRESENTATION`. Antes, `__oaCapTest` (patrón de 6 colores) comprueba
     colores, orientación y recorte. Errores de la página: `__oaCapError` (queda aunque sigan pedidos).
  2. `draw`: un WebView del tamaño del video, detrás de la app; `postVisualStateCallback` y `WebView.draw` en un
     bitmap (dos que se turnan) → `Encoder.frameBitmap`. El motor dibuja por software (lento; los videos pueden salir
     negros). Si el primer fotograma sale vacío prueba `LAYER_TYPE_SOFTWARE`.
  3. compatible: modern-screenshot (era ~90 % del tiempo). La vista de captura nunca carga la página de la app
     (AppServer le daría otro token al puente). En la PC (server.mjs) el modo gpu se imita con capturas de pantalla.
- Fotogramas (miniaturas, Claude y el método compatible): el compositor rasteriza el DOM con modern-screenshot
  (`rasterAt`, mensaje `frame`) → JPEG a `enc.frame` (MediaCodec + EGL); el audio, mezclado con Web Audio, a `enc.audio`.
  El audio de los archivos lo decodifica Java por tramos (`audio.decode`, `audio.peaks` en `AudioDecoder.java`):
  nunca leer un video entero en el WebView. Pantalla encendida con `holdAwake()` (`wake.ts`, cuenta pedidos).
- Interfaz táctil: `html.touch` + `src/android/tablet.css`; editor con pestañas Editor | Claude y paneles
  (`drawer`), timeline con toques (seleccionar, arrastrar el seleccionado, pellizcar zoom); botón atrás con
  `useBack()` (`src/android/ui/back.ts`). En WebView no hay `window.confirm`/`prompt`: usar `useDialogs()`.
  Chrome marca `:active` ~100 ms tarde: `ui/press.ts` pone `[data-pressed]` en el pointerdown y el CSS táctil
  no anima colores (lo elegido cambia junto con la acción). En horizontal (≥ 1100 px) reproducción y herramientas
  del timeline van en una sola barra (`.tl-bar.merged`), los botones del visor flotan a los costados (`float-bar`)
  y Medios ocupa toda la altura; con un panel abierto el video se corre (`push-l`/`push-r`). En pantalla
  completa el video (iframe) se queda con los toques: `.fs-tap` encima los recibe.
- Los menús están en un portal pero React igual propaga sus eventos a los padres del disparador: `Menu` los corta
  (sin eso, «Duplicar» en el menú de una tarjeta también abría el proyecto).
- Probar sin tablet: `node android/scripts/build-web.mjs && node android/dev/server.mjs --mock-claude`
  (Termux se imita con el puente real, `android/dev/fake-claude.mjs` y, para Whisper, `fake-whisper.mjs`).
  APK: `bash android/build-apk.sh` (sin Gradle). Detalles en `android/README.md`.
- Ícono de la app: fuentes en `android/icon/*.svg` (fondo, frente y silueta del ícono adaptable, e `icon.svg`
  completo); `node android/scripts/icons.mjs` genera los mipmaps, `build/icon.png` y `build/icon.ico`. El `Logo`
  de la interfaz (src/ui/icons.tsx) es el mismo dibujo.
