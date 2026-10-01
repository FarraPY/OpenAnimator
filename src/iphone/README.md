# OpenAnimator en el iPhone

Una app web que se instala desde Safari (Compartir › Agregar a pantalla de inicio) y corre entera en el teléfono:
proyectos, vista previa, timeline, exportación con el codificador de hardware y **Claude Code con el plan del usuario**,
sin PC, sin servidores propios y sin clave de la API. Requiere **iOS 26** (Safari 26: `createWritable()` en OPFS).

## Cómo está armada

```
src/iphone/
  main.tsx            arranque: Service Worker → puente web (host/) → backend de Android (window.oa) → interfaz
  sw.ts               Service Worker: app sin conexión, archivos de los datos (fs/, p/, ut/) y Claude Code (cc/)
  host/               el "puente nativo" de Android hecho con APIs de Safari
    webhost.ts        métodos del puente (fs.*, enc.*, audio.*, zip.*, pick.files, file.share, http.request…)
    webfs.ts          carpeta de datos sobre OPFS, con índice y archivos chicos de texto en memoria (sincrónico)
    encoder.ts        exportación: WebCodecs (VideoToolbox) + Mediabunny, el MP4 se escribe por partes en OPFS
    audio.ts          decodificar por tramos (Mediabunny) y mezclar en ventanas de 30 s (OfflineAudioContext)
    zip.ts, secrets.ts  .zip por streaming (fflate) · claves cifradas con WebCrypto (llave no exportable en IndexedDB)
  claude/             Claude Code dentro de la app
    installer.worker.ts  baja @anthropic-ai/claude-code-linux-arm64 de npm, saca los módulos del ejecutable de Bun
                         (bunfs.ts), los adapta (transform.ts) y los guarda en Cache Storage "oa-claude-<versión>"
    node/             un "Node" para el navegador (fs en memoria, process, crypto, net…, Bun mínimo) en un Worker
  ui/                 la interfaz del teléfono (inicio, editor, timeline, medios, exportar, ajustes)
src/android/backend/webclaude.ts   el chat: Worker por conversación, MCP de OpenAnimator atendido en la página
```

El backend es el de Android (`src/android/backend`): lo que en la tablet hace Java, acá lo hace `host/`.

## Claude Code en el teléfono

1. **Instalar** (Ajustes › Claude): el instalador baja el paquete oficial de npm (~110 MB), extrae del ejecutable de Bun
   los 2352 módulos de Claude Code, cambia los `import.meta.require` y los módulos de Node por importaciones que el
   navegador entiende y los guarda por versión (`cc/<versión>/…`, servidos por el Service Worker). OpenAnimator no
   publica nada de Anthropic: cada teléfono lo baja de npm.
2. **Cuenta**: el token de larga duración de `claude setup-token` (se corre una vez en la PC o en la tablet, en Termux).
   El inicio de sesión normal no se puede hacer desde una página (el servidor de OAuth no admite pedidos de navegadores).
   Va cifrado y sólo al Worker, como `CLAUDE_CODE_OAUTH_TOKEN`.
3. **Chat**: un Worker por conversación corre `claude -p --input-format stream-json …` con las mismas opciones que en la
   tablet (`--setting-sources ""`, `--tools ""`, sólo el MCP `openanimator`). El MCP es HTTP (`http://oa.mcp/mcp`): el
   `fetch` del Worker lo manda a la página, que ejecuta `tools.ts` sobre el proyecto. A `api.anthropic.com` le agrega
   `anthropic-dangerous-direct-browser-access` (CORS). Lo que Claude Code guarda en `~` (configuración y
   conversaciones) se copia a `claude/home/` de la carpeta de datos.

## Trampas

- **Mismo origen**: en GitHub Pages las escenas comparten origen con la app (en Android van en otro). Una escena podría
  leer los datos de la app: importar proyectos sólo de fuentes confiables.
- **Service Worker**: iOS lo cierra cuando no se usa; al volver no recuerda qué página es la dueña de los archivos
  (`fs-owner`) y la busca por URL (`isApp`). Los iframes de escenas también son "ventanas".
- **Audio de la vista previa**: Safari no deja sonar un `<audio>` que no arrancó con un toque y no respeta su volumen.
  El compositor va con `?audio=0` y suena `ui/previewAudio.ts` (Web Audio, activado en el toque de ▶, tramos de 8 s).
- **Rasterizar en Safari**: modern-screenshot redibuja 100 ms por imagen (6 imágenes: ~660 ms por fotograma); el
  compositor espera más sólo en el primer fotograma de cada escena y después redibuja una vez (~30 ms).
- **Guardar en Fotos / Compartir** es la hoja de iOS: sólo se abre con un toque (botones al terminar de exportar).
- **Conversaciones** (`.jsonl`): no se cargan en memoria al arrancar (crecen); se leen por partes.

## Probar en la PC

```bash
npm run build:iphone
```

Servir `dist-iphone/` en `http://localhost:<puerto>/OpenAnimator/` (los Service Workers andan en localhost sin HTTPS). En
localhost, `localStorage['oa.claudeDev'] = '{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:8899","ANTHROPIC_API_KEY":"sk-ant-api03-x"},"tarball":"http://localhost:<puerto>/claude.tgz"}'`
usa una API de mentira y un paquete local (nunca en el dominio publicado).

- El navegador integrado de Claude Code no registra Service Workers: usar Playwright (Edge y WebKit).
- El WebKit de Playwright para Windows no trae WebCodecs, `AudioContext` ni `OffscreenCanvas`, y su OPFS no escribe
  (sí con un contexto persistente y un OPFS en memoria inyectado): sirve para la interfaz, Claude Code y el MCP, no para
  exportar.
