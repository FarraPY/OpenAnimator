/*
 * Guion visual del documental «{{PROJECT_NAME}}».
 * Tiempos en SEGUNDOS ABSOLUTOS de la escena. Con narración: cada `t` es el instante
 * en que el narrador DICE esa palabra (tabla de tiempos por palabra del TTS).
 * Ver la skill "plantilla-documental" para todos los tipos de beat.
 */
window.DOC = {
  duracion: 30,
  marca: '{{PROJECT_NAME}}',
  beats: [
    { tipo: 'titulo', t0: 0, t1: 5.5, kicker: 'Capítulo 1', titulo: 'El ciclo del agua', subtitulo: 'un viaje sin fin', icono: 'gota', tTitulo: 0.8 },
    { tipo: 'puntos', t0: 5.5, t1: 12.5, titulo: 'Cuatro etapas', icono: 'globo', items: [
      { t: 7.0, texto: 'Evaporación: el sol calienta el agua' },
      { t: 8.6, texto: 'Condensación: se forman las nubes' },
      { t: 10.2, texto: 'Precipitación: lluvia y nieve' },
      { t: 11.6, texto: 'Escorrentía: vuelve al mar' } ] },
    { tipo: 'cifra', t0: 12.5, t1: 18, valor: '97 %', etiqueta: 'del agua del planeta es salada', t: 13.2, nota: 'sólo el 3 % es dulce' },
    { tipo: 'comparar', t0: 18, t1: 24.5, titulo: 'Agua dulce disponible', izq: { titulo: 'Accesible', items: [ { t: 19.4, texto: 'ríos y lagos' }, { t: 20.4, texto: 'acuíferos poco profundos' } ] }, der: { titulo: 'Congelada', items: [ { t: 21.8, texto: 'glaciares' }, { t: 22.8, texto: 'casquetes polares' } ] } },
    { tipo: 'cierre', t0: 24.5, t1: 30, titulo: 'Cada gota cuenta', subtitulo: 'cuidala', icono: 'corazon', tTitulo: 25.2 }
  ]
};
