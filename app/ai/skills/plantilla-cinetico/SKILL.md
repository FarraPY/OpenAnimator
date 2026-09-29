---
name: plantilla-cinetico
description: Formato de datos de la plantilla "Cinético" (tipografía en movimiento) de OpenAnimator (scenes/guion.js + motor/cinetico.js). Usala cuando el proyecto tenga scenes/cinetico.html o el usuario pida una intro, promo, reel o anuncio con texto animado.
---

# Plantilla Cinético

Tipografía grande, fondos planos que alternan (claro / tinta / marca), entradas con desenfoque y máscaras.
**Editás `scenes/guion.js`**:

```js
window.KINE = {
  duracion: 24,
  colores: { marca: '#6352ff', acento: '#6352ff', acentoOscuro: '#b3a9ff', claro: '#fff', tinta: '#0b0b10' },
  beats: [ { tipo, t0, t1, fondo?, … } ]
}
```

| tipo | campos | efecto |
|---|---|---|
| `grande` | `texto`, `sub` | una palabra/frase enorme que "respira" (peso 400→900) |
| `palabras` | `texto`, `destacar:[palabras]` | entra palabra por palabra con desenfoque; destacadas en color de acento |
| `lista` | `titulo`, `items:[{t, texto}]` (≤ 4) | filas numeradas que entran escalonadas |
| `mascara` | `lineas:[…]` (≤ 3) | cada línea sube desde su propia caja |
| `contador` | `desde`, `hasta`, `decimales`, `sufijo`, `etiqueta` | número que cuenta con aceleración |
| `final` | `titulo`, `linea`, `url` | cierre con impacto |

Reglas: un mensaje por beat (3–5 s), no más de 10 palabras en `palabras`, alterná `fondo` para que no se aplane
(si no lo indicás, rota automáticamente), un único color de marca. Con voz: `t` de cada ítem = palabra ancla.
