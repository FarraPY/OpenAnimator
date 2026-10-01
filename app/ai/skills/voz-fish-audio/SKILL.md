---
name: voz-fish-audio
description: Cómo narrar profesionalmente con Fish Audio (S2.1 Pro / S2.1 Pro Free gratis, S2 Pro, S1) desde OpenAnimator: elección de modelo y voz, dirección de la actuación con [corchetes], pausas, diálogos con varias voces, parámetros, normalización del texto en español, tiempos para sincronizar y control de calidad. Usala siempre que generes voz con Fish Audio (oa_generar_voz con proveedor fish).
---

# Voz con Fish Audio

Generá con la herramienta `oa_generar_voz` (proveedor `fish`): la app pone la clave, el modelo y los parámetros
que eligió el usuario. `oa_plugins` te dice el modelo configurado; `oa_voces` busca voces.

## Modelos (header `model`)

| Modelo | Costo | Idiomas | Dirección | Cuándo |
|---|---|---|---|---|
| `s2.1-pro-free` | **gratis** (uso justo, hasta 30/11/2026; los pedidos pueden usarse para mejorar el modelo; sin garantías de latencia) | 83 | `[corchetes]` en lenguaje natural | **por defecto** para todo: misma calidad que s2.1-pro |
| `s2.1-pro` | pago (≈ US$ 15 por millón de bytes de texto) | 83 | `[corchetes]` | producción con garantías de latencia (sólo si el usuario lo pide) |
| `s2-pro` | pago | 80+ | `[corchetes]` | integraciones viejas |
| `s1` | pago, heredado | 13 | `(paréntesis)` con etiquetas fijas | sólo si el usuario lo eligió |

Si una llamada con un modelo pago da **402** (sin saldo), volvé a generar con `modelo: "s2.1-pro-free"`.
No cambies a un modelo pago por tu cuenta.

## Dirigir la actuación (S2 / S2.1)

Las indicaciones van **entre corchetes** y **no se leen**: describen cómo decir lo que sigue. No son una lista
cerrada; se pueden escribir en lenguaje natural (en inglés funcionan mejor).

- **Emoción de la frase**: al **principio** de la oración. `[calm] Hoy vamos a entender por qué dormimos.`
  Básicas: happy, sad, angry, excited, calm, nervous, confident, surprised, curious, empathetic, proud, grateful,
  sarcastic… Avanzadas: hopeful, nostalgic, determined, doubtful, confused, disappointed, compassionate…
- **Tono**: en cualquier lugar. `[whispering]`, `[soft tone]`, `[emphasis]`, `[shouting]`, `[in a hurry tone]`.
- **Sonidos**: en cualquier lugar, seguidos del texto que corresponda. `[laughing] ¡Ja, ja! No me lo esperaba.`
  `[sighing]`, `[chuckling]`, `[gasping]`, `[clear throat]`…
- **Pausas**: `[break]` (corta) y `[long-break]` (larga). Úsalas después de un título, antes de un dato
  importante o entre ideas: le dan aire a la animación.
- **Descripciones libres**: `[warm documentary narrator, slow and clear]`, `[building suspense]`.

Buenas prácticas:
- **Una** emoción principal por oración; como mucho 3 indicaciones combinadas. No mezcles emociones opuestas.
- Cambios de emoción espaciados y con sentido (una narración documental casi siempre es `[calm]`/`[confident]`,
  con `[curious]` en preguntas y `[emphasis]` en la palabra clave).
- En `s1` la sintaxis es `(happy)`, `(break)`: **nunca** mezcles corchetes y paréntesis.
- Las indicaciones no aparecen en pantalla: la versión escrita del guion (subtítulos, textos) va **sin** ellas.

## Diálogos con varias voces (S2 / S2.1)

Marcá a cada hablante con `<|speaker:N|>` y pasá `voces` en el **mismo orden**:

```
texto:  "<|speaker:0|>[curious] ¿Y por qué soñamos? <|speaker:1|>[calm] Buena pregunta. [break] Nadie lo sabe del todo."
voces:  ["<id voz 0>", "<id voz 1>"]
```
Un solo archivo con toda la conversación. Para ubicar cada réplica en el timeline, transcribí el resultado.

## Elegir la voz

- Por defecto usá la voz que eligió el usuario (no pases `voz`).
- Para buscar: `oa_voces` con `buscar: "es"` (idioma), `"narrador"` (título) o `"es: documental"`. Preferí voces
  nativas del idioma del guion y con mucho uso. Pedile al usuario que escuche 2 o 3 candidatas antes de un video largo.
- Clonar voces: sólo la del usuario o con permiso escrito de la persona. Nunca voces de famosos.

## Parámetros

| Parámetro | Valor | Efecto |
|---|---|---|
| `temperatura` | 0.7 (defecto) | más alta = más expresiva y variable; 0.5–0.6 para narración larga y pareja |
| `velocidad` | 1 | 0.9–0.95 para contenido denso o educativo; 1.05–1.1 para promos |
| latencia | normal | la app usa la mejor calidad; `low` sólo para tiempo real |

La app ya pide MP3 a 192 kbps con la sonoridad normalizada.

## Texto para el oído (español)

La normalización automática de Fish **sólo** cubre inglés y chino: en español escribí lo que se tiene que **decir**.
- Números, fechas, horas y unidades en palabras: "mil novecientos ochenta y cuatro", "quince miligramos",
  "tres de cada diez", "las ocho y media".
- Siglas como se pronuncian, o su nombre completo. Símbolos (%, /, +, →) en palabras.
- Frases de 8–20 palabras. Puntuación real: la coma y el punto también son pausas.
- Aplicá el diccionario del proyecto (`scripts/pronunciacion.json`) si existe (ver skill `voz-y-tiempos`).

## Flujo recomendado

1. Guion escrito (pantalla) → versión hablada (normalizada + indicaciones) en `scripts/`.
2. Generá **por párrafo o sección** (`nombre`: `cap1-parte-3`). Los textos largos se procesan en tramos y la voz
   se mantiene coherente, pero regenerar un párrafo es más barato que rehacer todo.
3. **Tiempos por palabra**: Fish no los devuelve. Usá `oa_transcribir` sobre cada archivo **sin `proveedor`**: corre
   Whisper local (gratis, en el equipo del usuario: la PC, la tablet o el iPhone) con tiempos por palabra precisos.
   Pasá `idioma: "es"`.
   (Con `proveedor: "fish"` los tiempos son por frase y aproximados: evitalo.)
4. Control de calidad: compará la transcripción con el texto. Palabras que faltan, se repiten o cambian =
   regenerá **ese** párrafo (bajando un poco la temperatura). Escuchá también que ninguna indicación se haya leído
   en voz alta; si pasó, reescribila en inglés o simplificala.
5. Ubicá las partes en la pista `Voz` con 0,3–0,4 s de aire y recién después fijá los tiempos de la animación.
