---
name: plantilla-documental
description: Formato de datos y buenas prácticas de la plantilla "Documental ilustrado" de OpenAnimator (scenes/guion.js + motor/documental.js). Usala cuando el proyecto tenga scenes/documental.html o el usuario pida un video educativo/explicativo narrado.
---

# Plantilla Documental

Un mundo ilustrado (papel y tinta) por el que viaja una cámara. **Editás `scenes/guion.js`**; el motor
(`scenes/motor/documental.js`) hace el dibujo, la cámara, los colores y las animaciones.

```js
window.DOC = {
  duracion: 180,              // = duración del clip de escena en el timeline
  marca: 'MEDICINA INTERNA',  // texto chico arriba a la izquierda
  vuelo: 1.2,                 // segundos que tarda la cámara entre beats
  paletas: ['papel','noche','menta','arena','papel','ciruela'],  // rotación opcional
  beats: [ … ]                // en orden, t0 creciente; t1 = t0 del siguiente
}
```

| tipo | campos | uso |
|---|---|---|
| `titulo` | `kicker`, `titulo`, `subtitulo`, `icono`, `tTitulo` | apertura de video o de sección |
| `puntos` | `titulo`, `icono`, `items:[{t, texto, icono?}]` (≤ 5) | enumeraciones |
| `cifra` | `valor` ("> 95 %", "3 : 1"), `etiqueta`, `t`, `nota` | un dato que tiene que quedar grabado |
| `comparar` | `titulo`, `izq:{titulo, items}`, `der:{titulo, items}` | A vs B, antes/después |
| `pasos` | `titulo`, `pasos:[{t, texto}]` (≤ 6) | procesos, algoritmos, líneas de tiempo |
| `cita` | `texto`, `autor` | frase clave, regla de oro |
| `cierre` | `titulo`, `subtitulo`, `icono` | final |

Cualquier beat acepta `paleta` (`papel`, `arena`, `menta`, `noche`, `ciruela`) para forzar el fondo.
Íconos: check, cruz, estrella, corazon, rayo, gota, libro, grafico, persona, reloj, idea, globo, lupa, alerta,
pastilla, cerebro, engranaje, flecha, bandera.

## Reglas

- Cada `t` de un ítem = instante en que el narrador dice su palabra ancla (tiempos por palabra, skill `voz-y-tiempos`).
- Textos cortos: títulos ≤ 6 palabras, ítems ≤ 9 palabras. El motor achica la letra para que entre, pero si
  necesita achicar mucho, el texto es demasiado largo: resumí (la voz explica, la pantalla ancla).
- Alterná tipos: nunca dos `puntos` seguidos; cada 3–4 beats una `cifra`, `comparar` o `cita`.
- Un `titulo` cada sección nueva; un `cierre` al final.
- ¿Algo que el motor no hace? Podés agregar un tipo nuevo en el motor (manteniendo `render(t)` puro) o poner
  una escena HTML propia en la pista de escenas por encima (la primera pista visual se dibuja adelante).
- Para videos largos (> 10 min) usá **un timeline por capítulo** (cada uno con su propio `guion` y su escena):
  se editan y exportan por separado y se unen con capítulos al exportar.

## Verificar
`oa_hoja_contactos` (24 cuadros) + `oa_auditar_layout` (0 incidencias) + `oa_ver_fotogramas` al final de cada beat.
