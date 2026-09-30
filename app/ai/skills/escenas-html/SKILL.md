---
name: escenas-html
description: Cómo escribir o editar escenas HTML/SVG/Canvas/three.js para OpenAnimator que se rendericen igual en la vista previa y en la exportación (deterministas, función del tiempo). Usala al crear una escena nueva, diseñar un estilo propio, integrar librerías (GSAP, three.js, Lottie, D3) o arreglar una escena que se ve distinta al exportar.
---

# Escenas HTML deterministas

## El contrato

```js
window.__oa = {
  duration: 12,                 // segundos (el editor la usa al agregar la escena)
  render(t) { /* pinta el estado exacto del instante t */ },
  // o bien: async renderFrame(t, { fps }) { …; await algoQueCargue }  (resolvé cuando esté listo para capturar)
}
```

- **Pura**: mismo `t` ⇒ mismo cuadro, sin importar si venís de atrás, de adelante o de otra escena.
  Nada de `Math.random()` (usá un hash de índice/semilla), nada de `Date.now()`, nada de estado acumulado.
- **Ocultar = resetear**: si un elemento sale de su ventana de tiempo, dejalo en su estado base (no en el
  último estilo que tuvo), o el cuadro dependerá del orden de los saltos.
- Diseñá en **1920×1080** y escalá (`--u = min(100vw/1920, 100vh/1080)` o SVG con `viewBox`). La exportación
  puede renderizar a 4K: lo vectorial queda nítido, los PNG chicos se ven borrosos.
- **Todo local**: fuentes, librerías e imágenes dentro del proyecto (la exportación no depende de internet).
  Fuentes seguras en Windows sin descargar: Segoe UI, Georgia, Segoe Print, Consolas, Cascadia.

## El runtime de OpenAnimator (lo que pasa por debajo)

OpenAnimator inyecta un runtime ANTES de tus scripts:
- El **tiempo está congelado** desde la carga: `performance.now()`, `Date.now()` y el timestamp de
  `requestAnimationFrame` valen el tiempo de la escena (0 al cargar).
- Por eso **también funcionan** escenas escritas "normalmente": animaciones CSS (`@keyframes`, transitions),
  Web Animations, loops con `requestAnimationFrame`, `setTimeout`/`setInterval`, GSAP (usa rAF), etc.
  El runtime avanza el reloj virtual y pausa/posiciona las animaciones CSS en el instante pedido.
- Videos dentro de la escena: marcalos `<video data-oa-sync data-oa-start="3">` (arranca a los 3 s de la escena)
  o poné `data-oa-time` con el segundo exacto a mostrar; el runtime los posiciona y espera el cuadro.
- El audio propio de la escena se silencia: el sonido va SIEMPRE en pistas de audio del timeline.
- Aun así, **`window.__oa.render(t)` es lo más confiable**: preferilo en escenas nuevas.

## Rendimiento (sobre todo en la tablet)

La vista previa corre en el mismo motor que la interfaz de la app, y en el mismo hilo: una escena pesada traba
todo, hace parpadear partes de la interfaz (se acaba la memoria de la GPU) y en la tablet puede cerrar la app.
Presupuesto: a 30 fps, **~10 ms por fotograma** para el JS de la escena y recalcular estilos (el resto es pintar
y la app).
- Animá `transform` y `opacity`. Cambiar `top`/`left`/`width`/`height` de muchos elementos rehace el maquetado.
- Muchas partículas o piezas iguales: un solo `<canvas>` dibujado en `render(t)`, no cientos de nodos del DOM
  ni cientos de animaciones CSS (el runtime posiciona cada una en cada fotograma).
- `filter: blur()`, `backdrop-filter`, `mix-blend-mode` y sombras grandes se vuelven a pintar en cada fotograma:
  pocos y en elementos chicos. Para un resplandor, un degradado radial.
- `will-change` y las transformaciones 3D crean una capa de GPU por elemento: sólo en unos pocos.
- Imágenes del tamaño en que se ven (una foto de 6000×4000 ocupa ~90 MB decodificada) y canvas del tamaño
  del cuadro.
- Nada de Babel en el navegador (`type="text/babel"`): JS directo.
- En la tablet, `oa_ver_fotogramas` y `oa_hoja_contactos` dicen lo que cuesta cada escena, medido en el
  equipo. Si dicen que es pesada, simplificala antes de seguir.

## Trampas conocidas

- Filtros SVG animados (`feTurbulence` con semilla que cambia) sobre capas grandes cuelgan Chromium: semilla fija,
  filtros sólo en elementos chicos.
- `ctx.globalAlpha = x` pisa los fundidos del que llama: multiplicá (`ctx.globalAlpha *= x`).
- Texto que "hierve": el jitter de un trazo dibujado debe depender del índice del punto + semilla, nunca de `t`.
- `object-fit: cover` recorta: si cambiás de 16:9 a vertical, reencuadrá a mano.
- Medí el texto (canvas `measureText` o `getBBox`) y ajustá tamaño/saltos: **nunca cortes texto con "…"** ni lo
  dejes salir del cuadro. Para la auditoría, marcá figuras grandes con `data-oa-figure` (así se detecta texto encima).
- three.js/WebGL: renderizá en `render(t)` (no en un loop propio) y fijá `preserveDrawingBuffer: true`.
- Librerías por CDN rompen la exportación: copialas a `scenes/vendor/`.

## Verificación

1. Guardá → el editor recarga. `oa_ver_fotogramas` en 3+ instantes (inicio, medio, justo antes del final).
2. Saltá hacia atrás y adelante (`times: [5, 2, 5]`) → los dos cuadros de t=5 deben ser idénticos.
3. `oa_auditar_layout` → 0 incidencias.
4. Tramo corto exportado (`%OA_EXE% --cli render <id> --start a --end b --res 720p`) si hay video o 3D.
