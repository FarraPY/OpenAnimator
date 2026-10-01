---
name: voz-y-tiempos
description: Narración (TTS), tiempos por palabra, música y efectos de sonido sincronizados para OpenAnimator. Usala cuando haya que generar o cambiar la voz, sincronizar la animación con lo que se dice, agregar música o SFX, o arreglar que "la voz dice otra cosa que la pantalla".
---

# Voz, tiempos y sonido

## Orden de trabajo (no lo inviertas)

1. **Guion hablado** en `scripts/<nombre>.md`: prosa natural, un párrafo por beat, frases cortas.
   Sin marcas de edición. Excepción: con Fish Audio S2/S2.1 las indicaciones de actuación van entre
   `[corchetes]` y no se leen (skill `voz-fish-audio`).
2. **Normalizá para el oído** antes de enviar al TTS (ver tabla abajo). Guardá la versión normalizada aparte:
   la pantalla muestra la versión escrita, el TTS recibe la hablada.
3. **Generá la voz por párrafo** (un archivo por parte: `assets/voz/<nombre>/parte-N.mp3`). Si una parte sale mal,
   se regenera sólo esa.
4. **Obtené tiempos por palabra** (con timestamps del TTS o transcribiendo el audio con `oa_transcribir`, que usa
   Whisper en el equipo del usuario: gratis y preciso). Guardalos en
   `assets/voz/<nombre>/tiempos.json` como `[{ "parte": 1, "palabra": "lupus", "ini": 3.42, "fin": 3.81 }]`.
5. **Ubicá las partes en el timeline** (pista `Voz`), una detrás de otra con 0,3–0,4 s de aire.
6. **Recién ahora** poné los tiempos de cada beat/elemento = inicio de la parte + tiempo de la palabra ancla.
   Si cambiás la voz o el modelo, **todos** los tiempos cambian: recalculá.

## Proveedores (usá el que el usuario tenga; preguntá antes de gastar)

Primero usá las herramientas de la app: `oa_plugins` (qué hay configurado), `oa_generar_voz`, `oa_voces`,
`oa_generar_sfx` y `oa_transcribir`. Las claves las pone la app; nunca las pidas ni las escribas en archivos.
Fish Audio **S2.1 Pro Free** es gratis: si el usuario tiene Fish configurado, es la opción sin costo
(detalles en la skill `voz-fish-audio`).

**Transcripción = Whisper local.** `oa_transcribir` sin `proveedor` corre Whisper en el equipo del usuario: en la
PC, large-v3-turbo con la GPU; en la tablet, whisper.cpp en Termux; en el iPhone, WhisperKit en el Neural Engine (si el
usuario lo instaló: `oa_plugins` lo dice).
Tiempos por palabra precisos, gratis, sin enviar el audio a internet. Usalo siempre que necesites tiempos o control
de calidad; pasá `idioma: "es"` si lo sabés (es más rápido y evita que detecte otro idioma). En la tablet tarda más:
transcribí cada parte una vez, no el video entero de nuevo por cada cambio. En el iPhone es rápido (10 minutos de audio
en menos de un minuto).
No uses ElevenLabs/OpenAI/Fish para transcribir salvo que el usuario lo pida o que no haya Whisper. Ni escribas
scripts propios de Whisper: la herramienta ya lo hace.

Lo de abajo es la referencia de las APIs por si hiciera falta.

**ElevenLabs** (voz + tiempos por carácter en una llamada):
```
POST https://api.elevenlabs.io/v1/text-to-speech/<voice_id>/with-timestamps
headers: xi-api-key: $ELEVENLABS_API_KEY
body: { "text": "...", "model_id": "eleven_multilingual_v2",
        "voice_settings": { "stability": 0.5, "similarity_boost": 0.75, "style": 0, "use_speaker_boost": true } }
→ { audio_base64, alignment: { characters[], character_start_times_seconds[], character_end_times_seconds[] } }
```
Agrupá caracteres en palabras. Música: `POST /v1/music` (con `composition_plan` por secciones que coincidan
con los beats). SFX: `POST /v1/sound-generation` (`duration_seconds` ≥ 0.5).

**Fish Audio** (voz) + su ASR para tiempos:
```
POST https://api.fish.audio/v1/tts   headers: Authorization: Bearer <clave>, model: s2.1-pro-free (gratis)
body: { "text": "...", "reference_id": "<voz>", "format": "mp3", "mp3_bitrate": 192, "temperature": 0.7,
        "top_p": 0.7, "prosody": { "speed": 1 } }
POST https://api.fish.audio/v1/asr   (multipart: audio, language=es, ignore_timestamps=false) → segments por frase
```

Reintentá sólo errores de red/5xx/429 (con espera creciente); nunca regeneres porque "no te gusta" sin preguntar.

## Normalización "voz = pantalla" (español)

| Escrito | Hablado |
|---|---|
| `10-9`, `15-25 mg` | "10 a 9", "15 a 25 miligramos" (nunca como fecha) |
| `120/80` | "120 sobre 80" |
| `6/10`, `3:1`, `1:80` | "6 de 10", "3 a 1", "uno en ochenta" |
| `1.000`, `0,5`, `50+` | "mil", "cero coma cinco", "50 o más" |
| `CD4+`, `x/día` | "CD4 positivos", "x por día" |
| siglas (LES, IECA, ARA-II) | nombre completo o como se dicen ("lupus", "IECA o ARA dos") |
| `Título: contenido` | pausa real después del título (generá el título y el contenido como segmentos con 0,35 s de silencio) |

Mantené un diccionario del proyecto (`scripts/pronunciacion.json`) y aplicalo siempre. Después de generar,
transcribí y compará: si el ASR no reconoce una palabra clave, probablemente se pronunció mal.

## Música y efectos

- Música: una cama por sección, entra y sale con fundidos de 1–2 s, volumen de pista 0,15–0,3 bajo la voz.
  Medí niveles (`ffmpeg -i x.mp3 -af volumedetect -f null -`); voz ≈ −16 LUFS integrados, música 15–20 dB por debajo.
- SFX: derivalos de los eventos visuales (cada aparición de chip → pop 0,12; cada cambio de escena → whoosh 0,3).
  **Un clip por efecto** en la pista `SFX`, con `start` = el momento exacto del evento. Así el usuario ve cada
  sonido en su lugar y puede moverlo, borrarlo o cambiarle el volumen sin rehacer nada.
  - **Reusá archivos**: generá cada sonido distinto una sola vez (`assets/sfx/pop.mp3`, `whoosh.mp3`…) y
    colocalo tantas veces como haga falta (clips distintos, mismo `src`). No generes 10 pops iguales.
  - Ids descriptivos (`sfx-pop-esc2-chip3`, `sfx-whoosh-esc4`) para ubicarlos después.
  - Si dos efectos se pisan en el tiempo, usá una segunda pista de audio (`SFX 2`) en vez de mezclarlos.
  - Si cambian los tiempos de una escena o de la voz, mové sólo los clips afectados.
  - **No premezcles** los SFX en un único archivo. Única excepción: si pasan de ~50 en un timeline y el usuario
    está de acuerdo; ahí premezclá por escena (no el timeline entero) con ffmpeg (`adelay` + `amix=normalize=0`).
- Elegí entre candidatos midiendo (`silencedetect` para continuidad, `volumedetect` para nivel), no sólo "de oído".

## Colocar audio en el timeline (JSON)

```json
{ "id": "voz-1", "src": "assets/voz/cap1/parte-1.mp3", "start": 0.4, "duration": 6.21, "in": 0, "volume": 1 }
```
`duration` = duración real del archivo (usá `oa_info_medio`). Actualizá `duration` del timeline si el audio termina después.
