# OpenAnimator para iPhone (app nativa)

Una app de iOS (Swift + WKWebView) que lleva todo adentro: la interfaz del teléfono (`src/iphone`), el compositor,
las plantillas y el "Node" en el que corre Claude Code. No usa servidores: los archivos los sirve la propia app
(`SchemeHandler.swift`) y los proyectos viven en el iPhone (Documentos: se ven en la app **Archivos**). Internet sólo
hace falta para hablar con Claude y para bajar Claude Code de npm la primera vez.

## Cómo está armada

```
ios/
  project.yml                 proyecto de Xcode (lo genera XcodeGen)
  OpenAnimator/
    AppDelegate.swift         arranque (escenas de UIKit)
    WebViewController.swift   el WKWebView, navegación, alert/confirm, eventos para la página (pause, resume, memory)
    SchemeHandler.swift       sirve oa://localhost (interfaz, fs/, cc/) y oaproj://localhost (proyectos, otro origen)
    Bridge.swift              lo nativo que pide la interfaz: archivos en disco, Claude Code instalado, Fotos y Archivos
                              (elegir), Compartir, guardar en Fotos, vista previa, pantalla encendida
    NativeEncoder.swift       exportación con AVFoundation (venc.*) si el WebCodecs de WebKit no anda en el equipo
    NetStream.swift           la red de iOS (con streaming) para lo que Claude Code manda a Anthropic y los plugins de IA
    AppLog.swift              el registro de la app (logs/app.log) y su envío en vivo a la computadora
    Keychain.swift            claves de los servicios en el Llavero de iOS
    Storage.swift             dónde vive cada cosa (app, Documentos, Application Support/claude-code)
    diag/                     diagnóstico del WebKit de iOS (-OADiag)
  test/mock-anthropic.mjs     API de mentira para la prueba de punta a punta en el simulador
  www/                        la interfaz armada (`npm run build:ios`; no va al repositorio)
```

- Los dos esquemas propios son "potencialmente confiables" para WebKit (`schemeIsHandledBySchemeHandler`): hay
  WebCodecs (H.264, HEVC, AAC), WebCrypto, Workers de módulos que cargan desde el esquema, `fetch` con `Range`.
- La interfaz guarda su índice en memoria (`src/iphone/host/webfs.ts`) y escribe en el disco por el puente (base64);
  los archivos grandes se leen por URL (`oa://localhost/fs/…`, con `Range`).
- Claude Code: el instalador (Worker) lo baja de npm y lo adapta; la página guarda los módulos con `cc.write` en
  Application Support y la app los sirve en `oa://localhost/cc/<versión>/…`.

## Compilar

GitHub Actions (`.github/workflows/ios.yml`, en una Mac de la nube):
1. `npm run build:ios` → `ios/www`
2. `xcodegen generate` → `ios/OpenAnimator.xcodeproj`
3. Simulador: diagnóstico (`-OADiag`) y prueba de punta a punta (`-OATest e2e`, `src/iphone/test/e2e.ts`): instala
   Claude Code de npm, lo arranca contra `test/mock-anthropic.mjs`, Claude escribe una escena por MCP, se exporta un
   video y AVFoundation lo revisa. Los resultados quedan como anotaciones del run.
4. `.ipa` **sin firmar**: artefacto del run (y pre-release `ios-latest` en master/main).

## Instalar en el iPhone

El `.ipa` no está firmado: se firma con tu cuenta de Apple al instalarlo. Desde Windows, por ejemplo con
[Sideloadly](https://sideloadly.io) (necesita iTunes y iCloud de apple.com, no los de la Microsoft Store):
1. Conectá el iPhone por cable, abrí Sideloadly, arrastrá `OpenAnimator.ipa`, poné tu Apple ID y tocá Start.
2. En el iPhone: Ajustes › General › VPN y gestión de dispositivos › confiar en tu Apple ID.
3. iOS 16 o más nuevo: Ajustes › Privacidad y seguridad › Modo de desarrollador (una vez).

Con una cuenta gratis la firma dura 7 días (después se vuelve a instalar; tus proyectos quedan); con el programa de
desarrolladores de Apple, un año.
