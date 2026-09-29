---
name: direccion-artistica
description: Dirección artística y proceso de trabajo para crear videos animados profesionales en OpenAnimator (no "slop" genérico). Usala SIEMPRE que el usuario pida crear, mejorar, rehacer o revisar un video, una escena o una sección, o cuando diga que algo se ve monótono, amateur, aburrido o poco profesional.
---

# Dirección artística — de "animación con IA" a video profesional

El salto de calidad no viene de un truco visual: viene de un **proceso** y de **reglas** que
se cumplen siempre. Seguilos en orden.

## 1. Antes de tocar código

1. **Leé `brief.md`** y las notas del usuario. Si falta tema, público, duración, voz o estilo, preguntá
   (una pregunta a la vez, con opciones).
2. **Pedí o buscá una referencia visual.** Si el usuario adjunta un video/imágenes de referencia:
   sacá fotogramas (`ffmpeg -i ref.mp4 -vf fps=1/3,scale=480:-1,tile=4x3 ref-hoja.jpg`), miralos y escribí
   en `brief.md` una **guía de estilo** concreta: paleta (hex), tipografías, tipo de ilustración, lenguaje
   de cámara, ritmo de cortes, qué NO hacer. Esa guía manda sobre tus gustos.
3. **Escribí la tabla de beats como comentario** antes de programar: tiempo, qué se ve, qué se dice.
   Un beat = una idea. Si un beat tiene tres ideas, son tres beats.
4. **Trabajá por tramos con aprobación**: primer minuto (o primera escena) → mostrarlo → ajustar →
   recién ahí escalar al resto. Las preferencias aprobadas se aplican a todo lo que sigue.

## 2. Audio primero (lo que más "profesionaliza")

Guion → voz → **tiempos por palabra** → beats. Nunca al revés (skill `voz-y-tiempos`).
- Cada elemento visual aparece **cuando el narrador lo nombra** (±0,15 s). El texto en pantalla puede
  adelantarse ~0,2 s a la palabra; nunca atrasarse.
- La música acompaña la estructura: cambia o crece en los cortes de sección, siempre ~15–20 dB debajo de la voz.
- Efectos sutiles (pop, whoosh, trazo) **derivados de los eventos visuales**, volumen 0,1–0,25.

## 3. Reglas visuales

**Sistema, no ocurrencias**
- Diseñá sobre una grilla de 1920×1080 con márgenes seguros de 96 px. Nada importante fuera de ellos.
- Colores como tokens (fondo, tinta, acento, secundario, peligro). **Un solo color de acento** por video.
- Máximo 2 familias tipográficas (títulos + texto) + 1 manuscrita opcional para notas. Jerarquía clara:
  título ≥ 2× el cuerpo. Cuerpo ≥ 40 px en 1080p. Máx. ~8 palabras por línea, ~3 líneas por bloque.
- Contraste de texto ≥ 4.5:1.

**Movimiento con intención**
- Nunca interpolar lineal: `outCubic`/`outExpo` para entradas, `inOutCubic` para cámara, `outBack`
  (sobrepaso leve) para cosas que "aparecen". Movimientos grandes: smootherstep.
- Duraciones: entradas 0,4–0,7 s; cámara 0,9–1,4 s; nada más rápido que 0,25 s salvo cortes.
- Escalonado (stagger) 0,08–0,15 s entre elementos hermanos.
- Todo lo que aparece debe **salir** o quedar justificado; limpiá antes de cada beat nuevo.
- La cámara nunca está 100 % quieta (deriva/zoom de 2–4 % por beat) pero tampoco marea.
- Oscilaciones idle: arrancarlas con rampa de ~0,4 s (encenderlas de golpe parece un salto).

**Anti-monotonía (lo que el usuario nota como "aburrido")**
- No repitas el mismo tipo de escena dos veces seguidas. Rotá: título, lista, cifra grande, comparación,
  pasos/línea de tiempo, cita, diagrama, figura que se ilumina, mapa, zoom a detalle.
- Alterná el fondo (claro / oscuro / color de marca) cada 2–3 beats para marcar secciones.
- Variá el encuadre: plano general → detalle → general. Un "respiro" visual cada ~45 s.
- Cada sección arranca con una apertura (título de sección) y el video tiene cierre.

**Continuidad**
- Transiciones que continúan el movimiento (la cámara viaja al siguiente lugar, el elemento se expande
  y se convierte en el siguiente) antes que cortes secos. Si hay corte, que sea en un cambio de idea.
- Entre escenas/capítulos: terminar y empezar en el mismo color de fondo o con fundido de 0,6–1 s.

## 4. Control de calidad (obligatorio antes de decir "listo")

1. `oa_auditar_layout` en todo el tramo tocado → **0 incidencias** (textos que se pisan o salen de cuadro).
2. `oa_hoja_contactos` del tramo (12–24 fotogramas) → revisá ritmo, variedad, consistencia de paleta.
3. `oa_ver_fotogramas` en cada beat nuevo **justo antes de que termine** (ahí todo su texto ya debería estar).
4. Revisá que lo que se dice coincide con lo que se ve (ni antes, ni tarde, ni con otra palabra).
5. Si hay voz: ningún texto en pantalla que el narrador lea distinto (siglas, números, símbolos).
6. Contá qué verificaste y qué no ("no escuché el audio final", "revisé 18 fotogramas").

Un auditor que comparte el mismo bug que el render lo confirma en vez de detectarlo: por eso **siempre**
también se mira.

## 5. Cuando el usuario dice "más profesional"

No agregues efectos al azar. Diagnosticá con una hoja de contactos y respondé con cambios concretos:
más variedad de tipos de escena, jerarquía tipográfica más marcada, menos texto por pantalla, cámara con
intención, sincronía palabra→imagen más precisa, color de acento consistente, aperturas de sección.
