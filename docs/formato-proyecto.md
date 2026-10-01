# Formato de proyecto de OpenAnimator

Un proyecto es una carpeta dentro de `data/projects/<id>/`. Todo es texto plano (JSON + HTML) para que
se pueda editar a mano, versionar con git o modificar desde Claude.

```
<id>/
  project.json            ← metadatos (formato openanimator/1)
  timelines/<id>.json     ← un archivo por timeline (formato oa-timeline/1)
  scenes/                 ← escenas HTML/SVG/Canvas (+ motor/, vendor/, guion.js en plantillas)
  assets/                 ← audio, video, imágenes
  scripts/                ← guiones hablados, diccionario de pronunciación
  renders/                ← exportaciones (por defecto)
  thumbnail.jpg           ← miniatura de la pantalla de inicio (se genera sola)
  .oa-cache/              ← segmentos de exportación reanudable (se puede borrar)
```

## project.json

```json
{
  "format": "openanimator/1",
  "id": "mi-video", "name": "Mi video",
  "width": 1920, "height": 1080, "fps": 30,
  "background": "#000000",
  "timelines": [ { "id": "main", "name": "Principal", "file": "timelines/main.json" } ],
  "activeTimeline": "main",
  "template": "documental",
  "createdAt": "…", "updatedAt": "…",
  "importedFrom": "C:/…/CoAnimator/projects/…"   // sólo si vino de CoAnimator
}
```

## Timeline (`timelines/*.json`)

```json
{
  "format": "oa-timeline/1",
  "duration": 30,
  "tracks": [
    { "id": "escenas", "name": "Escenas", "type": "scene", "clips": [
      { "id": "c1", "src": "scenes/documental.html", "start": 0, "duration": 30, "in": 0 } ] },
    { "id": "voz", "name": "Voz", "type": "audio", "volume": 1, "clips": [
      { "id": "v1", "src": "assets/voz/parte-1.mp3", "start": 0.4, "duration": 6.2, "in": 0, "volume": 1,
        "fadeIn": 0, "fadeOut": 0.3 } ] }
  ],
  "notes": [ { "id": "n1", "t": 12.5, "text": "Este título entra muy tarde" } ]
}
```

| Campo | Significado |
|---|---|
| `track.type` | `scene` (HTML), `video` (video o imagen) o `audio` |
| orden de `tracks` | la **primera** pista visual se dibuja **adelante** |
| `track.muted / solo / hidden / locked / volume` | controles de pista |
| `clip.start` | segundo del timeline donde empieza |
| `clip.duration` | cuánto dura en el timeline |
| `clip.in` | desde qué segundo del archivo/escena se reproduce (recorte inicial) |
| `clip.fadeIn / fadeOut` | fundidos en segundos (opacidad en visuales, volumen en audio) |
| `clip.opacity` | opacidad del clip visual (0-1, por defecto 1), multiplica a los fundidos |
| `clip.speed` | sólo escenas: velocidad del tiempo interno (1 = normal); videos y audio van siempre a 1 |
| `clip.fit` | encuadre de video/imagen: `contain`, `cover`, `fill` |
| `notes` | notas del usuario ancladas al tiempo, para la IA (`oa_resolver_nota` las borra) |

Las rutas `src` son relativas a la carpeta del proyecto (se aceptan absolutas).

## Escenas

Una escena es un HTML que, idealmente, expone `window.__oa = { duration, render(t) }`. Ver la skill
`escenas-html` (`app/ai/skills/escenas-html/SKILL.md`) para el contrato completo y el runtime que
congela el tiempo, lo que permite capturar también animaciones CSS, `requestAnimationFrame` y GSAP.

## Importado desde CoAnimator

`Importar de CoAnimator` copia la carpeta entera (el original no se toca), renombra su `project.json` a
`coanimator-project.json` y convierte cada timeline a `timelines/oa-<id>.json`: la pista de animación pasa
a ser una pista `scene` con el HTML del capítulo y las pistas de audio/video conservan clips, recortes y
volúmenes.
