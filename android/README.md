# OpenAnimator para Android (tablets)

La misma app de la PC, adaptada a una tablet: editor con timeline táctil, **Claude en su propia
pantalla**, fotogramas y exportación a MP4 con el codificador de hardware del equipo. Pensada para
tablets grandes (probada en tamaño de Galaxy Tab S8+), funciona en Android 8 o más nuevo.

## Instalar

1. Descargá `OpenAnimator.apk` (de la sección *Actions* o *Releases* del repositorio, o el que te pasaron).
2. Abrilo en la tablet. La primera vez Android pide permiso para *instalar apps desconocidas* desde el
   navegador o la app de Archivos: aceptalo para esa app.
3. Las versiones nuevas se instalan encima y conservan tus proyectos (están firmadas con la misma clave).

> Tus proyectos viven dentro de la app. **Si la desinstalás, se borran**: compartilos como .zip antes.

## Conectar Claude

En **Ajustes › Claude (IA)** elegís cómo trabaja Claude en la tablet:

### Con tu plan de Claude (Pro o Max)

Claude Code no tiene versión oficial para Android, pero corre en **Termux** (una terminal Linux
gratuita) con un instalador de la comunidad. OpenAnimator lo maneja por detrás: la conversación, las
herramientas y los permisos son los mismos que en la PC, y la sesión de tu plan queda en Termux (la app
nunca la ve). La pantalla de ajustes te guía y muestra el estado de cada paso:

1. Instalá **Termux** desde [F-Droid](https://f-droid.org/packages/com.termux/) o
   [GitHub](https://github.com/termux/termux-app/releases) (la de Google Play es experimental).
2. Copiá el **comando de preparación** que muestra la app, pegalo en Termux y esperá a que diga
   «Listo». Actualiza Termux (`yes | pkg upgrade`), instala Node.js y Claude Code (con
   [claude-code-termux](https://github.com/gtbuchanan/claude-code-termux), unos 250 MB) y activa
   `allow-external-apps` para que OpenAnimator le pueda mandar comandos.
3. Tocá **Permitir** (Android lo llama «ejecutar comandos en Termux»).
4. **Iniciar sesión en Claude**: se abre Termux con `claude auth login`; entrá con tu cuenta.
5. **Probar**: la app instala su puente en `~/.openanimator/` de Termux y lo conecta.

Para que Android no cierre Termux mientras Claude trabaja: en *Ajustes › Batería* dejá Termux y
OpenAnimator sin restricciones y, en *Opciones de desarrollador*, activá «Desactivar restricciones de
procesos secundarios». Como es un instalador de la comunidad, una actualización de Claude Code puede
romperlo por un tiempo (el instalador se actualiza con `claude-code-termux-update`).

Si al probar aparece `CANNOT LINK EXECUTABLE … cannot locate symbol`, a Termux le faltan
actualizaciones (Termux no admite actualizar paquetes a medias): ejecutá `yes | pkg upgrade` en Termux
y volvé a probar. Si falla otra cosa, el registro del puente está en `~/.openanimator/bridge.log`.

### Con una clave de la API

1. Entrá a [platform.claude.com](https://platform.claude.com/settings/keys), cargá crédito y creá una clave (`sk-ant-…`).
2. En **Ajustes › Claude (IA)** elegí *Con clave de API*, pegá la clave y tocá *Guardar* (y *Probar*).

La API se cobra por uso y es aparte de la suscripción de claude.ai. El chat muestra el costo aproximado
de cada respuesta; el **modo ahorro** (activado por defecto) y *Compactar* ayudan a gastar menos. La
clave se guarda cifrada con el almacén de claves de Android y sólo se envía a `api.anthropic.com`
(lo mismo con las claves de los plugins: cada una sólo viaja a su propio servicio).

Modelos: Opus 5.5 (por defecto), Sonnet 5.5, Haiku 4.5 y Fable 5.1.

## Whisper en la tablet (transcribir la narración)

Para sincronizar las animaciones con la voz, Claude necesita saber en qué segundo se dice cada
palabra. En la tablet eso lo hace **Whisper** con [whisper.cpp](https://github.com/ggml-org/whisper.cpp),
compilado en Termux: gratis, sin clave y sin mandar el audio a internet. Usa Termux igual que Claude
con tu plan, así que primero hacé los pasos 1 a 3 de arriba.

En **Ajustes › Plugins › Whisper**:

1. Elegí el modelo: **Base** (142 MB, el más rápido), **Small** (466 MB, recomendado) o **Large v3
   Turbo** (547 MB, el mismo de la PC comprimido: el más preciso y el más lento).
2. **Instalar Whisper**: se abre Termux, compila whisper.cpp 1.9.4 (la primera vez, unos 5 a 10
   minutos) y descarga el modelo, comprobando su suma SHA-1. Cuando diga «Listo», volvé a la app.
3. **Probar**: transcribe una muestra de voz de 11 segundos y te dice cuánto tardó en *tu* tablet.

Después, `oa_transcribir` usa Whisper antes que cualquier servicio pago. Los modelos se pueden borrar
desde la misma pantalla. El instalador queda en `~/.openanimator/whisper-install.sh` de Termux (se
puede correr a mano: `bash ~/.openanimator/whisper-install.sh small`) y todo lo de Whisper, en
`~/.openanimator/whisper/`.

## Cómo se usa

- **Inicio**: proyectos, plantillas, *Importar proyecto (.zip)* y la papelera. Mantener apretada una
  tarjeta (o tocar `⋯`) abre sus opciones: renombrar, duplicar, compartir como .zip, guardar como plantilla…
- **Editor**: arriba, las pestañas **Editor** y **Claude**. En el editor quedan el visor, los controles y
  el timeline; **Medios** y **Propiedades** se abren como paneles que se deslizan cuando los necesitás.
- **Timeline**: tocar un clip lo selecciona; con el clip seleccionado, arrastrarlo lo mueve y las
  manijas blancas lo recortan. Doble toque abre sus propiedades; mantener apretado, su menú. Deslizar
  desplaza el timeline, **pellizcar hace zoom** y la regla de arriba mueve el cursor.
- **Claude**: la conversación ocupa toda la pantalla, con una vista previa del video que se actualiza
  sola cuando Claude cambia algo y pedidos rápidos. Si Claude necesita permiso mientras estás en el
  editor, aparece un aviso arriba. Mientras razona se ve cuánto lleva (tiempo y tokens estimados) y,
  si Claude deja de dar señales por más de dos minutos y medio, un aviso para detenerlo. Ir a Ajustes o
  al inicio no lo corta: sigue trabajando y al volver al proyecto está donde iba. Al abrir un proyecto,
  Claude sigue con su última conversación (el botón + empieza una nueva; se puede cambiar en Ajustes ›
  Claude). Si Android cierra la página por falta de memoria, la app vuelve sola al proyecto y, con tu
  plan, retoma la conversación que siguió corriendo en Termux.
- **Exportar**: presets (Recomendado 1080p, 4K HEVC, Liviano 720p, Para editar), calidad, códec y
  audio. El video se guarda en *Galería › Movies/OpenAnimator* y se puede compartir o abrir.
- Con teclado físico (funda con teclado o Samsung DeX) funcionan los mismos atajos que en la PC.

### Pasar proyectos entre la PC y la tablet

- **Tablet → PC**: en la tablet, *Compartir (.zip)* o *Guardar en Archivos (.zip)*. En la PC,
  descomprimí el .zip dentro de la carpeta de proyectos (Inicio › *Carpeta de proyectos*).
- **PC → tablet**: comprimí la carpeta del proyecto (`data/projects/<id>`) en un .zip, pasalo a la
  tablet y abrilo con OpenAnimator (o usá *Importar proyecto (.zip)*).

### Diferencias con la PC

No están (dependen de programas de la PC): la terminal de Claude Code, la exportación NVENC con sus
ajustes avanzados, *Plantilla desde un video*, *Importar de CoAnimator*, ChatGPT vía Codex y yt-dlp.
Whisper corre en Termux (más lento que con la GPU de la PC). Los plugins por API (OpenAI, Gemini,
OpenRouter, ElevenLabs, Fish Audio) funcionan igual.

## Para desarrollar

La interfaz es la misma de la PC (`src/`); lo propio de Android está en:

| Parte | Dónde |
|---|---|
| App nativa (WebView, puente, servidor de archivos, codificador MediaCodec, claves) | `android/app/java/…` |
| "Proceso principal" en el WebView: los mismos canales que `electron/main.ts` | `src/android/backend/` |
| Chat con la API de Claude (SDK oficial, herramientas, permisos, historial) | `src/android/backend/agent.ts`, `tools.ts` |
| Chat con Claude Code en Termux (puente, MCP, permiso RUN_COMMAND) | `src/android/backend/code.ts`, `termux.ts`, `android/termux/`, `TermuxLink.java` |
| Exportación (Web Audio + compositor + `enc.*`) | `src/android/backend/exporter.ts` |
| Capa táctil y pantallas propias (Claude, exportar, ajustes) | `src/android/tablet.css`, `src/android/ui/` |

Dos orígenes separan la app de los proyectos: la interfaz se sirve desde
`https://appassets.androidplatform.net` y las escenas desde `https://oaproject.androidplatform.net`,
así el HTML de un proyecto no puede usar el puente nativo.

### Armar el APK

Sin Gradle: `aapt2 → javac → d8/dx → zipalign → apksigner`.

```bash
npm ci                       # (ELECTRON_SKIP_BINARY_DOWNLOAD=1 si no vas a correr la versión de PC)
bash android/build-apk.sh    # → android/build/OpenAnimator-<versión>.apk
```

Necesita Node 20+, un JDK 11+ y el Android SDK (`$ANDROID_HOME` con build-tools y `platforms;android-34`),
o bien las herramientas de Debian/Ubuntu (`aapt2 zipalign apksigner dalvik-exchange`) más
`ANDROID_JAR` apuntando a un `android.jar` de API 34. En GitHub, `.github/workflows/android.yml` lo
arma en cada cambio y lo adjunta a los releases.

**Firma**: `android/keystore/openanimator.jks` (contraseña `openanimator`) está en el repositorio a
propósito, para que cualquier build pueda actualizar la app instalada. Eso también significa que
cualquiera puede firmar un APK "compatible": instalá OpenAnimator sólo desde este repositorio. Para
firmar con una clave privada: `OA_KEYSTORE`, `OA_KEYSTORE_PASS` y `OA_KEY_ALIAS`.

### Ícono

Las fuentes están en `android/icon/` (capas del ícono adaptable y el ícono completo, en SVG). Después de
cambiarlas: `node android/scripts/icons.mjs` (usa el Chromium de Playwright) regenera los PNG de cada
densidad, el ícono temático y los de la PC (`build/icon.png`, `build/icon.ico`).

### Probar en la PC

`android/dev/server.mjs` imita el puente nativo (archivos, claves, red, codificador con ffmpeg), así la
app completa corre en un navegador de escritorio:

```bash
node android/scripts/build-web.mjs
node android/dev/server.mjs --port 5190 --mock-claude   # http://localhost:5190
```

Con `--mock-claude` los pedidos a la API los responde un Claude simulado con un guion fijo (crea una
escena, la pone en el timeline y mira fotogramas), para probar el chat sin gastar. Un mensaje con
`[rechazo]` simula que Claude declina el pedido y uno con `[error400]`, que la API lo rechaza.

Termux también se imita: `RUN_COMMAND` corre con el bash de la PC y un `HOME` propio, así el puente
de verdad (`android/termux/bridge.mjs`) arranca y lanza `android/dev/fake-claude.mjs`, un Claude Code
simulado que usa las herramientas de la app por MCP y pide permisos (con `--termux-claude real` usa el
Claude Code instalado en la PC). Un mensaje `[transcribir] assets/voz/x.mp3` lo hace llamar a
`oa_transcribir` y uno `[pensar]`, razonar con el texto oculto (sólo tokens estimados). Instalar Whisper
no compila nada: deja `android/dev/fake-whisper.mjs` como `whisper-cli` (lee el WAV, pone una palabra
por tramo con sonido y escribe el JSON como whisper.cpp).

El servidor escucha sólo en `127.0.0.1` (su puente no tiene token). El audio que en la tablet
decodifica Java (`AudioDecoder.java`: formas de onda, mezcla de la exportación, transcripción) acá
lo hace ffmpeg.
