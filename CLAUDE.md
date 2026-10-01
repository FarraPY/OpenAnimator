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
- Animaciones CSS en el runtime (`syncAnimations`): leer `playState` de una `CSSAnimation` recalcula los estilos de
  todo el documento, y el `currentTime` anterior los deja sucios: era cuadrático (1600 animaciones: ~1,2 s por
  fotograma). Se pausan una sola vez (`cssPaused`) y queda en ~50 ms, con los mismos fotogramas; a las del script
  (`el.animate`) sí se les pregunta (no recalcula nada). `document.getAnimations()` sigue siendo lo caro (las ordena
  por su lugar en el árbol: 1600 hermanas, 30 ms) y pedirlas elemento por elemento es muchísimo peor.
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
- El chat está montado aunque no se vea (`display: none` en la otra pestaña o panel) y el navegador ignora el
  scroll de un elemento oculto: la lista recuerda si sigue al último mensaje (`stick` en ChatPanel) y lo aplica al
  mostrarse; si no, una conversación cargada con el chat oculto (al volver al proyecto) aparecía desde el principio.
  El contador de la pestaña Claude (tablet) guarda lo visto por proyecto y conversación (`seenChat` en Editor.tsx):
  el editor se monta de nuevo al volver y contaba como nuevas todas las respuestas.
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

## iPhone — app nativa `ios/` + interfaz `src/iphone/` (detalles en `ios/README.md` y `src/iphone/README.md`)
- App de iOS (Swift + WKWebView, `ios/`; proyecto con XcodeGen) que lleva todo adentro, sin servidores: la app sirve la
  interfaz, los proyectos y Claude Code con dos esquemas propios (`SchemeHandler.swift`: `oa://localhost` interfaz, `fs/`,
  `cc/`; `oaproj://localhost` proyectos, otro origen). GitHub Actions (`ios.yml`) la compila SIN FIRMAR (el usuario la
  firma con su cuenta de Apple) y corre en el simulador un diagnóstico (`-OADiag`) y una prueba de punta a punta
  (`-OATest e2e`: src/iphone/test/e2e.ts contra `ios/test/mock-anthropic.mjs`); los resultados quedan como anotaciones
  del run (API pública de check-runs). El navegador integrado y el WebKit de Windows no sirven para probarla.
- Interfaz propia del teléfono (`src/iphone/ui`) sobre el backend de Android con un puente de WebKit
  (`src/iphone/host`: WebFS con índice en memoria y el disco del iPhone por `Bridge.swift` en base64 —en Safari, OPFS—,
  WebCodecs + Mediabunny, Web Audio, fflate, WebCrypto). `isIphone()` en platform.ts; `host().kind === 'web'` en el
  backend; `isNative()` (src/iphone/host/native.ts) dentro de la app. También corre como app web (`npm run build:iphone`).
- Claude Code con el plan del usuario y sin PC: el instalador (Worker) baja `@anthropic-ai/claude-code-linux-arm64` de
  npm, saca los módulos del ejecutable de Bun y los adapta (`claude/transform.ts`); corre en un Worker con un "Node" de
  navegador (`claude/node/`). Cuenta → `CLAUDE_CODE_OAUTH_TOKEN`: «Iniciar sesión con Claude» hace lo mismo que
  `claude setup-token` con el código del propio Claude Code (`login` en worker.js: su clase de OAuth, que la app busca
  con `cc.find`, con inferencia sola y un año); iOS muestra la página (ASWebAuthenticationSession), la vuelta a
  `http://localhost:<puerto>/callback` la recibe un NWListener sólo de loopback que redirige a `openanimator://login/…`
  (Bridge.swift `login.open`) y el Worker la recibe por `http-request` (servidor emulado en sys.js, sólo en ese modo);
  el canje y el perfil van por la red de iOS. Trampa: con una cuenta del plan la API rechaza todo pedido de navegador
  («401 CORS requests are not allowed for this Organization»), así que en la app TODO lo de Anthropic sale por
  `http.stream` (NetStream.swift, URLSession; las partes vuelven como evento `net` y el Worker arma un ReadableStream:
  `appFetch` en worker.js); sin XMLHttpRequest, axios también usa fetch. También se puede pegar un token. MCP por HTTP (`http://oa.mcp/mcp`) atendido en la
  página (`backend/webclaude.ts`). El puente nativo sólo atiende al marco principal de `oa://` (las escenas, en
  iframes `oaproj://`, no).
- Verificado en el WebKit de iOS (simulador): los esquemas propios son contexto seguro (WebCodecs H.264/HEVC/AAC,
  WebCrypto), los Workers de módulos cargan desde el esquema, `fetch` con `Range` y `PUT` con Uint8Array (un Blob llega
  sin cuerpo).
- Modelos y versiones (webclaude.ts): la lista del selector la da el Claude Code instalado (pedido de control
  `initialize`, como el SDK: `models` con alias opus/sonnet/haiku que siguen al más nuevo; `claude/models.json`,
  evento `claude:models`); un modelo guardado con nombre completo pasa a su alias. Se actualiza solo (al abrir y cada
  6 h, con wifi o datos, sin conversaciones trabajando): `update()` instala, prueba que arranque (la misma consulta) y
  recién ahí la marca en uso (`oa.claudeVersion`); si falla, la borra y no la reintenta (`oa.claudeFailed`). Las
  versiones viejas se borran al próximo arranque (una conversación abierta puede estar usándolas).
- Liquid Glass (iOS 26): la página es transparente (`html.native-ui`) sobre `NativeChrome.swift`: el fondo azul noche y,
  debajo de la página, una `UIGlassEffect` por cada elemento con `data-glass` ("", "accent", "light", "clear"; también
  `.ph-top .tap` y el cuadro del chat en la hoja), que mide `src/iphone/host/glassUI.ts` y manda con `glass.layout`
  (cambios, desplazamientos, transiciones). Como va debajo, lo que la página pone encima (ventanas, menús) lo tapa, pero
  no refracta contenido de la página: no usarlo dentro de listas que se desplazan (iría un cuadro atrasado y sin recorte)
  ni dentro de algo opaco de la página (una hoja o ventana con fondo: el fondo lo tapa y el botón queda transparente).
  Sin iOS 26 (o en Safari) el vidrio es CSS. Editor (diseño del usuario): botones de vidrio, video redondeado, cápsula de
  reproducción, timeline compacto (escenas como tarjetas con miniatura de `frames:png`, onda rellena) y una hoja de
  vidrio con Claude / Timeline (inspector del clip, PhoneInspector) / Medios en tres alturas (`sheet` min/mid/max).
  La hoja sigue al dedo (manija y pestañas) y se acomoda con un resorte según dónde quedó y la velocidad; el tamaño
  del video, de la hoja y el timeline salen de variables de CSS (`--sheet-h`, `--pv`, `--tl-o`) que se cambian sin
  React, y `syncGlassNow()` manda el vidrio en el mismo cuadro (si no, queda un cuadro atrás). Menús «⋯»: `MenuButton`
  (PhoneApp) → `NativeMenus.swift` (un botón invisible de iOS encima con un UIMenu, submenús incluidos; lo elegido
  vuelve como evento `menu`); en lo que se desplaza con el dedo, `native={false}` (el botón de iOS no dejaría
  desplazar) y queda el menú de la página anclado. El audio de la vista previa suena con el iPhone en silencio:
  AVAudioSession `.playback` (AppDelegate) y `navigator.audioSession.type = 'playback'`. Trampa: iOS a veces deja
  trabada la salida de un AudioContext (dice «running» pero ni suena ni avanza `currentTime`; entrando y saliendo de
  pantalla completa, que gira la pantalla) y sólo uno nuevo vuelve a sonar: `PreviewAudio.unlock()` hace uno en cada ▶
  y, reproduciendo, si el reloj no avanza lo rehace y sigue (hasta 2 veces por ▶). La isla dinámica muestra
  `navigator.mediaSession.metadata` (nombre del proyecto e `icon.png`, que build-iphone.mjs copia también a ios/www;
  sin eso, un cuadrado gris) y sus botones van a `togglePlay`.
- Vista previa del editor en el iPhone: NO va en un iframe de la página. WebKit dibuja lo de adentro de un contenedor con
  `transform: scale()` a tamaño completo × la densidad (×3): sólo cuenta la escala de página (GraphicsLayerCA, bug 27684
  de WebKit); el video de 1920×1080 se dibujaba a 5760×3240 y la escena CSS 3D de «Prueba de render» pasaba los ~2 GB
  del motor web (JetsamEvent: per-process-limit) y se caía toda la app. Va en su propia vista web (`NativePreview.swift`,
  entre el fondo y el vidrio de NativeChrome; la página deja el hueco `.stage-native` en Stage.tsx, glassUI.ts lo ubica
  con `preview.layout` y los mensajes del compositor van por `preview.post` / evento `preview`; compositor.js con
  `native=1` contesta por `messageHandlers.oaPreview`). El compositor tiene viewport del ancho del video y escala de
  página = ancho de la vista ÷ ancho del video (iOS no aleja menos de 0,1: más chico se achica con una transformación;
  mientras la hoja se mueve también, y quieta 0,25 s se redibuja a la escala nueva). Las escenas ven devicePixelRatio 1
  (como al exportar) y sin el agrandado de letra de iOS. Medido en el iPhone 17 Pro Max con «Prueba de render» de punta a
  punta (memoria de cada proceso, interfaz + video): inicio 616 MB → 93 + 46, SVG ~1,3 GB → ~300 + 200, CSS 3D más de
  2 GB (se caía) → ~400 + 250, sin cierres. Es otro proceso: si iOS lo cierra se rehace sólo el video
  (tres veces en 30 s: se deja hasta que se mueva el cursor). Los controles de pantalla completa son vidrio de iOS sobre
  el video. La exportación hace lo mismo (`NativeCapture.swift`, `cap.*` del puente; en exporter.ts es el método 'gpu',
  «captura de iOS»): el compositor con `capture=1` en otra vista web de video ÷ densidad puntos (1920×1080 → 640×360) con
  escala de página 1/densidad, así WebKit dibuja justo a la resolución del video; `__oaCapReady/Done/Error` avisan por
  `messageHandlers.oaCap` y cada fotograma va de `takeSnapshot` directo a AVFoundation (`NativeEncoder.appendCaptured`;
  en la app el codificador siempre es AVFoundation). La vista va debajo de la página detrás de la ventana de exportar,
  achicada con una transformación (fuera de la pantalla WebKit no la dibuja). Antes, «captura compatible» iba a 1,3 fps y
  con «Prueba de render» la interfaz pasaba los 2 GB en el fotograma 78. Pendiente: los fotogramas para Claude siguen
  con el compositor de la página.
- iPhone por cable desde la PC (Windows, depuración): `Apple Devices` (Microsoft Store) para usbmux; en `.tools/`:
  go-ios (`go-ios/ios.exe`) y pymobiledevice3 (venv `pmd3/`). Pasos: `ios tunnel start --userspace` (sin administrador);
  montar la imagen de desarrollador con `pymobiledevice3 mounter mount-personalized <dmg> <trustcache> <BuildManifest>`
  (la de `ios image auto --basedir=go-ios/devimages`): go-ios no puede pedir la firma porque gs.apple.com usa la raíz de
  Apple que Windows no trae, pymobiledevice3 la pide por HTTP como las herramientas de Apple; WebDriverAgent de Appium
  (WebDriverAgentRunner-Runner.zip → IPA, firmado con Feather; anda aun con certificado de distribución):
  `ios runwda --bundleid=com.facebook.WebDriverAgentRunner.xctrunner --testrunnerbundleid=… --xctestconfig=WebDriverAgentRunner.xctest`
  y `ios forward 8100 8100` → `scripts/iphone-wda.py` (capturas, toques, deslizar, escribir, abrir apps). La interfaz se
  maneja con `ios webinspector eval 1 "<js>"` (no espera promesas: guardar en una global y leerla después; texto con
  acentos, en base64), `window.oa.call(canal, …)` llega al backend. Memoria por proceso en vivo:
  `.tools/pmd3/Scripts/python.exe scripts/iphone-mem.py`; informes de cierres: `ios crash ls` / `crash cp "JetsamEvent*"`.
  Instalar un IPA nuevo: `MSYS_NO_PATHCONV=1 ios file push --app=com.openanimator.app --local=x.ipa --remote=/Documents/x.ipa`
  (sin esa variable Git Bash convierte `/…` en una ruta de Windows) y en Feather: + › Import from Files › En mi iPhone ›
  OpenAnimator › Open, Sign, Start Signing, Abrir, Install (compartirlo desde OpenAnimator a Feather no lo importaba).
  La pantalla se bloquea fuera de OpenAnimator: para trabajar así, Bloqueo automático en Nunca (lo cambia el usuario).
- Interfaz del iPhone: los modelos para elegir (Ajustes y el chat) salen de `useModels()` (src/claudeModels.ts).
  Volver deslizando desde el borde: UIScreenEdgePanGestureRecognizer (WebViewController) → `window.__oaBack`
  (PhoneApp: cierra menú/ventana/hoja o toca el `Tap` con `back` de la pantalla). Ventanas y hojas miden `--vvh`
  (con el teclado abierto quedaban detrás) y en pantallas táctiles nada abre el teclado solo. Importar un .zip
  (`zip.import`, iphone/host/zip.ts) hace lo de Zip.java: saca la carpeta de arriba (`<id>/project.json`).
- Registro (Ajustes › Depuración): `AppLog.swift` escribe `Documentos/logs/app.log` (rota a los 4 MB; sin claves ni
  códigos de OAuth) con lo que manda la página (`src/iphone/host/applog.ts`: warn/error de la consola —todo con
  «Registro detallado»—, errores sin atrapar, Claude: pedidos, fin de turno, herramientas que fallan, stderr del
  Worker; la exportación: velocidad cada 2 s y el informe, con «Esperando al codificador») y lo del sistema (memoria,
  cierre del motor web, segundo plano, temperatura, ahorro de batería). «En vivo»: POST a
  `node scripts/registro-remoto.mjs` (clave en .tools/registro-remoto.key → registro-iphone.log): en la misma wifi cada
  1 s; desde cualquier red, con `--ntfy`, al tema fijo https://ntfy.sh/oa-<clave> en tandas de 30 s (ntfy.sh: 250
  mensajes por día y guarda 12 h; más de 4 KB va como adjunto). Los túneles gratis no sirvieron: esta red bloquea el
  DNS de trycloudflare/argotunnel y localhost.run cambia la dirección cada tanto. Con el registro en vivo por la wifi,
  «Enviar un proyecto a la computadora» manda su .zip (`log.upload` → `<dirección>/archivo`) a `.tools/del-iphone/`
  para ver uno que falla. La línea «Arranca» trae la versión de la interfaz (qué compilación está instalada) y el
  registro anota interrupciones y cambios de salida del audio de iOS.
- Trampas del WebKit de iOS 26: no entiende `using`/`await using` (Claude Code los usa) → `lowerUsing` (transform.ts, al
  instalar; envuelve TODO el bloque para no cambiar el alcance; prueba: `scripts/check-lower-using.mjs`) con
  `$oaUse`/`$oaDispose` de claude/node/inject.js. El User-Agent de WKWebView quedó en «iPhone OS 18_7» (la versión real
  la da `info` del puente). El VideoEncoder de WebKit en el simulador de CI toma 2–4 fotogramas y no devuelve nada (a
  veces ni con flush): Mediabunny esperaba `dequeue` para siempre (la exportación se trababa en el fotograma 8).
  `PatientVideoEncoder` (encoder.ts) mira la cola, la vacía con flush() y, si igual no responde, falla; entonces la
  exportación se repite con AVFoundation (`NativeEncoder.swift`: JPEG + PCM por el puente, video y audio aparte y
  juntados sin recodificar) y las siguientes van directo por ahí (`enc.fallback`). En el simulador de CI
  `<video>`/`<audio>` dan error 4 aun desde blob:.

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
- Por qué se cerró (`Exits.java`): el registro de Android de cómo terminó el proceso de la app (Android 11+,
  `ApplicationExitInfo`: sin memoria, error de Java o nativo, no responde —con la pila del hilo principal—…; sólo
  los que el usuario llamaría un cierre), el motor web que se cerró (`onRenderProcessGone`, con memoria libre y si
  se estaba exportando) y los errores de Java sin atrapar con su pila (`files/exits.jsonl`). La página nueva pide
  `app.exits` después de pintar y muestra cada cierre una vez (AndroidIntegration) con «Copiar detalles»; eso
  reemplaza el aviso de `recoveredBoot` cuando hay registro. Probar: `POST /__dev/exits {records}` en server.mjs.
- Costo de las escenas para Claude: con los fotogramas de `oa_ver_fotogramas` y `oa_hoja_contactos` (hasta 4 por
  pedido) el compositor mide lo que tarda el hilo principal en pasar al fotograma siguiente (3 pasos: JS de la
  escena + recalcular estilos y maquetar; uno solo si pasa de 150 ms) y cuenta lo caro de lo visible (elementos,
  animaciones, `filter: blur` grandes, `backdrop-filter`, `mix-blend-mode`, sombras grandes, capas de GPU, MB de
  imágenes y canvas, Babel). `costNote` (frames.ts) se lo resume con el presupuesto (~10 ms a 30 fps) y le pide
  simplificar si pasa; la guía está en la skill escenas-html («Rendimiento»). Pintar no se puede medir ahí (el
  compositor oculto está escalado casi a cero).
- Whisper en la tablet: whisper.cpp 1.9.4 compilado en Termux por `android/termux/whisper-install.sh` (commit y
  SHA-1 de los modelos fijados; base/small/large-v3-turbo-q5_0). El audio viaja como PCM 16 kHz por el puente
  (`whisper.put`), `whisper.run` corre `whisper-cli -ojf --dtw <modelo> -nfa -bs 1 -sns -pp` y arma las palabras con
  `t_dtw`. Trampas de 1.9.4: sin `-l` asume inglés (usar `auto`); flash attention (por defecto) desactiva DTW; si no
  puede leer el audio termina con 0 sin JSON; el JSON no escapa caracteres de control (`lenientJson`). Velocidad: el
  codificador (lo más caro) trabaja sobre una ventana de 30 s aunque el audio dure 5, y con `-l auto` escucha la
  primera ventana dos veces (detectar el idioma y transcribir): un clip de 10 s sin idioma tardaba ~3 veces lo que
  dura. Para menos de 27 s se pasa `-ac` (lo que dura + 3 s, ≥ 512, múltiplo de 64: con DTW tiene que cubrir todo el
  audio o aborta, `n_frames <= n_audio_ctx * 2`) y `oa_transcribir` le pide a Claude el `idioma`. `whisper.run`
  devuelve lo que midió whisper.cpp (`whisper_print_timings`: cargar, escuchar y sus pasadas, escribir, reintentos).
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
- Cambiar de pantalla rápido (había ~1 s al entrar a un proyecto, a Ajustes o al inicio): tras un toque React corre
  los efectos antes de pintar y los canales del backend corren en microtareas, así que cada llamada sincrónica a Java
  demoraba la pantalla nueva. Los datos de una pantalla se cargan con `afterPaint` (src/api.ts) y el inicio se
  muestra con la última lista mientras tanto; el chat se retoma después de pintar. Recorrer carpetas (`fs.du`) va en
  Java en segundo plano (`fs.duAsync`); `storage:info` ya no mide nada (lo que ocupa cada cosa es `storage:usage`,
  sólo en Ajustes). Al cerrar un proyecto la miniatura se rehace sólo si cambió (`thumbStale`: `touched` por Claude o
  un plugin, o project.json/timelines más nuevos). Medir con la CPU 4× más lenta (CDP) y Event Timing (toque → pintado).
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
     hasta que Capture se entera (`gpuForget`) y la vuelve a pedir (la segunda vez, solo: así no se puede perder).
     Con OpenGL ES 3, `latch` no espera a la GPU: copia la imagen a una textura del anillo (1/64 de la memoria del
     equipo, hasta 100 MB: 12 a 1080p en la Tab S8+) y su marca a un PBO con una fence, y la juzga cuando la GPU
     terminó (en la imagen siguiente o en un sondeo cada 2 ms).
     Trampa de Adreno: el PBO sólo se llena sin esperar a la GPU si la fila mide un múltiplo de 64 píxeles (256 bytes,
     `MARK_W`); con 8 píxeles la copia esperaba 3,9 ms, como la lectura directa. Con el anillo se reordena
     (`gpuReorder`): en la Tab S8+ el motor web a veces nunca muestra un fotograma cuando la página dibuja otro enseguida
     (13 % pidiendo 2 por adelantado; los detalles dicen de cada pérdida si el hilo estaba ocupado —se reemplazó— o
     libre —la pantalla no la mostró—: casi todas, libre). Lo que llega después de uno perdido queda guardado en el
     anillo, sólo el perdido se pide otra vez y el codificador los pone en el video por su clave (el tiempo, `byKey`);
     si no queda lugar se descarta el guardado más adelantado. Qué se pide y cuándo está en `GpuFrames.java` (sin
     vistas: se probó en la PC contra el código real con GPU, EGL y pantalla virtual simuladas; con 15 % de fotogramas
     que la pantalla junta, en orden 52 fps y reordenando ~93; en la tablet, 70 antes del control de lo que va en
     camino). Reordenando se puede pedir hasta los lugares del anillo menos 2, pero sólo unos pocos van en camino a la
     vez (pedidos cuya imagen no llegó; se ajusta por la velocidad de cada tanda de 60) y lo perdido va primero: la
     página dibuja en el orden en que se le pide, así que con la cola corta lo que se vuelve a pedir se dibuja enseguida
     (al final de la cola costaba ~25 ms por pérdida). Lo guardado entra al video de a un fotograma por turno del hilo
     (`scheduleEncode`): de a 7 seguidos el hilo quedaba ~20 ms ocupado y la pantalla reemplazaba imágenes. Si algo del
     anillo falla sigue sin él (`ringFailed`: se pierde todo, se olvida y sigue en orden); la prueba del patrón pasa por el anillo y, si no coincide, se repite sin él. Las imágenes chicas
     se sueltan después del JPEG (la historia de pedidos queda para los detalles: con ellas eran ~0,5 MB por segundo).
     En orden, Java pide hasta 4 fotogramas por adelantado (por tandas de 60: baja si se pierde el 10 %, sube si casi nada;
     en la Tab S8+ de a uno daba 20 fps: cada fotograma tarda ~3 refrescos en dar la vuelta), sube la pantalla a su
     máxima frecuencia (`preferFastDisplay`, y `VirtualDisplayConfig.setRequestedRefreshRate` desde Android 14) y el
     MP4 se escribe en otro hilo (`writer`): una escritura lenta en la tarjeta SD no puede demorar al que toma imágenes.
     Antes de Android 11 la ventana necesita `TYPE_PRIVATE_PRESENTATION`. Antes, `__oaCapTest` (patrón de 6 colores) comprueba
     colores, orientación y recorte. Errores de la página: `__oaCapError` (queda aunque sigan pedidos).
     Memoria de mosaicos: el motor le da a un WebView 20 × 4 bytes por píxel de su tamaño (con pre-raster; ~165 MB a
     1080p). Con cientos de capas 3D no alcanzaba (TileManager: `had_enough_memory_to_schedule_tiles_needed_now: false`)
     y se dibujaban cuadros con mosaicos faltantes: la marca ilegible cuenta como «cambiando» (cada uno, un dibujo tirado)
     y los que pasaban salían sin partes (el HUD de «Prueba de render» faltaba en ~22 % de la escena CSS 3D), a 2,7 fps.
     La vista es más alta que la pantalla virtual (`memViews`: 4× con 8 GB; con 3× un fundido entre dos escenas pesadas
     dejó 1 cuadro incompleto de 3600) y la página se acomoda arriba (`vh`): 16–17 fps y cuadros completos (dos
     exportaciones iguales dan 60 dB); el video de 2:00 de «Prueba de render» pasó de 404 a 149 s (137 s con lo de abajo,
     empezando con la tablet fría; dentro de esos 2 minutos ya la estrangula la temperatura). En la Tab S8+ no hay ADPF (PerformanceHintManager:
     `getPreferredUpdateRateNanos` = -1) y la prioridad alta del contexto EGL no cambió nada.
     Todo lo que se anima en la app durante la exportación le quita a la captura: los WebView comparten el hilo del
     motor web, el compositor (VizWebView) y el RenderThread de Android, y cada cuadro de la app recompone toda la
     ventana. Por eso el visor del editor se desmonta con el diálogo de exportar abierto (y la reproducción se detiene),
     la barra de progreso no tiene transición (se animaba sin parar a 120 Hz; desde el editor, 191 → 141 s) y
     exportando (`html.exporting`, exporter.ts) las animaciones CSS de la app quedan en pausa: un solo punto que late
     (Claude trabajando) bajaba la escena CSS 3D de 16,2 a 11,1 fps. WebGL pesado: la página entregaba el cuadro siguiente antes de que se mostrara el anterior, el
     motor lo reemplazaba y la GPU lo había dibujado en vano; `gpuSync` (oa-runtime.js, sólo al capturar) lee un píxel de
     cada contexto WebGL para esperar a la GPU (`finish()` en Chromium es sólo un flush) si eso tarda más de 12 ms
     (raymarching 14,3 → 17 fps y 0 pérdidas; los WebGL livianos no se frenan: se vuelve a medir cada 60 cuadros). La
     escena CSS 3D (360 capas con preserve-3d) está limitada por Viz: ~36 ms de CPU por cuadro en
     `DirectRenderer::DrawRenderPass` (trazas con CDP Tracing desde la página principal; la de captura no devuelve eventos).
     Probado sin resultado: llevar VizWebView y RenderThread al núcleo X2 (`taskset` desde la app; el X2 suele estar
     pausado por core_ctl y la afinidad sólo a él falla, y sólo núcleos grandes dio lo mismo). Al medir: después de unos
     minutos exportando, Samsung baja los topes a ~60 % (A710 1,55 GHz, X2 1,84 GHz, GPU 492 MHz) con «Thermal Status: 0»;
     comparar sólo con la tablet fría (`scaling_max_freq` de cada policy, `kgsl-3d0/max_gpuclk`).
  2. `draw`: un WebView del tamaño del video, detrás de la app; `postVisualStateCallback` y `WebView.draw` en un
     bitmap (dos que se turnan) → `Encoder.frameBitmap`. El motor dibuja por software (lento; los videos pueden salir
     negros). Si el primer fotograma sale vacío prueba `LAYER_TYPE_SOFTWARE`.
  3. compatible: modern-screenshot (era ~90 % del tiempo). La vista de captura nunca carga la página de la app
     (AppServer le daría otro token al puente). En la PC (server.mjs) el modo gpu se imita con capturas de pantalla.
- Fotogramas (miniaturas, Claude y el método compatible): el compositor rasteriza el DOM con modern-screenshot
  (`rasterAt`, mensaje `frame`) → JPEG a `enc.frame` (MediaCodec + EGL). Los de Claude se sacan primero con la GPU
  (`Snap.java`, `snap.*`: la misma página de captura en otra pantalla virtual, ImageReader, marca y un rato de calma;
  una hoja de 12 pasó de 143 a 3,8 s) y, si falla, con el compositor oculto. Canvas → base64 con `canvasBase64`
  (toDataURL): en este WebView `toBlob`/`convertToBlob` esperan siempre ~4 s (codifican en tareas de tiempo libre
  que no llegan). Una capa que recién se muestra se hace visible (oculta) antes de dibujar: con display:none la escena
  mide 0×0 y su primer cuadro salía en 1×1 o vacío; al capturar se esperan dos cuadros más (`newlyShown`). El audio de la exportación lo mezcla Java
  (`AudioMix.java`, `enc.mix`: ventanas de 30 s, sinc a 48 kHz, volumen y fundidos lineales en el tiempo del clip)
  directo al codificador; con JS (ida y vuelta por el puente) tardaba ~30 s por minuto. Se probó en la PC contra una
  mezcla de ffmpeg (68 dB): `Decoder`/`Out` son interfaces para eso. La mezcla corre en paralelo con la captura de los
  fotogramas; el AAC se codifica a medida que llega (`appendAudio` → `feedAac`, en el hilo que mezcla), el MP4 espera
  su formato en el hilo que escribe (`awaitAudioFormat`: la captura nunca espera) y se cierra al terminar. Trampa:
  sacar en cada vuelta todas las salidas listas del codificador AAC (sólo libera una entrada cuando se tomaron sus
  salidas); una por espera de 10 ms dejaba el primer fotograma ~40 s congelado en un video de 1:15. El codificador de
  video se abre con `KEY_OPERATING_RATE` (lo que admita a ese tamaño, hasta 240) y `KEY_PRIORITY` 1: sin eso se prepara
  para los fps del video (FFmpeg agregó lo mismo en 2024); pedir `Integer.MAX_VALUE`, como Media3, hizo que
  c2.qti.avc.encoder no arranque en una Galaxy Tab A9+ (androidx/media#2362). Si no lo acepta al configurarlo o al
  arrancarlo, sigue sin el aviso (y sin el perfil High, si hace falta). Al terminar, el diálogo muestra «Detalles»
  para copiar y pegar (queda en `logs/ultima-exportacion.txt` y en el diálogo de exportar): tiempos por etapa,
  método, estado del equipo (temperatura, ahorro, memoria, Hz) y, con la GPU, la línea de tiempo de cada fotograma
  uniendo `__oaCapLog` de la página (llegó, empezó, listo, entregado + rAF, en ms de reloj) con Java (`Want`: pedido,
  imagen, codificado; `Encoder.wallMs`), qué era cada imagen (la esperada, cambiando, vieja, posterior) y una muestra.
  El audio de los archivos lo decodifica Java por tramos (`audio.decode`, `audio.peaks` en `AudioDecoder.java`):
  nunca leer un video entero en el WebView. Pantalla encendida con `holdAwake()` (`wake.ts`, cuenta pedidos): exportar,
  Whisper, el chat (API en `run`, el plan en `TermuxChat.state()` según `busy`: sin eso un turno largo de Opus se
  pausaba a los 2 min), mover proyectos y los .zip; con un proyecto abierto, `holdWhileEditing` hasta 10 min sin tocarla.
- Pool de compositores ocultos (frames.ts): se cierra a los 90 s *sin uso* (`usedAt`), no a los 90 s de pedirlo; en la
  tablet una hoja de contactos con escenas pesadas tarda más (~12 s por fotograma) y perdía el compositor a mitad
  («cancelado», o 120 s esperando a uno ya cerrado). `trimFramePool` no cierra uno usado en los últimos 10 s.
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
  (Termux se imita con el puente real, `android/dev/fake-claude.mjs` y, para Whisper, `fake-whisper.mjs`; al Claude
  de mentira, «[herramienta] nombre {json}» le hace llamar sólo a esa herramienta).
  APK: `bash android/build-apk.sh` (sin Gradle). Detalles en `android/README.md`.
- Ícono de la app: fuentes en `android/icon/*.svg` (fondo, frente y silueta del ícono adaptable, e `icon.svg`
  completo); `node android/scripts/icons.mjs` genera los mipmaps, `build/icon.png` y `build/icon.ico`. El `Logo`
  de la interfaz (src/ui/icons.tsx) es el mismo dibujo.
