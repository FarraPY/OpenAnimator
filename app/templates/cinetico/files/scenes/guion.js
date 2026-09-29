/* Guion del reel «{{PROJECT_NAME}}». Tiempos en segundos absolutos. Ver la skill "plantilla-cinetico". */
window.KINE = {
  duracion: 24,
  colores: { marca: '#6352ff', acento: '#6352ff', acentoOscuro: '#b3a9ff' },
  beats: [
    { tipo: 'grande', t0: 0, t1: 4, texto: '{{PROJECT_NAME}}', sub: 'una idea en 24 segundos' },
    { tipo: 'palabras', t0: 4, t1: 8.5, texto: 'Las ideas simples se entienden mejor cuando se mueven', destacar: ['simples', 'mueven'] },
    { tipo: 'lista', t0: 8.5, t1: 14, fondo: 'tinta', titulo: 'Tres claves', items: [ { t: 9.3, texto: 'Un mensaje por escena' }, { t: 10.6, texto: 'Ritmo guiado por la voz' }, { t: 11.9, texto: 'Contraste en cada corte' } ] },
    { tipo: 'contador', t0: 14, t1: 18, desde: 0, hasta: 87, sufijo: ' %', etiqueta: 'más retención con movimiento' },
    { tipo: 'mascara', t0: 18, t1: 21, fondo: 'marca', lineas: ['Menos texto.', 'Más ritmo.'] },
    { tipo: 'final', t0: 21, t1: 24, titulo: '¡Empezá hoy!', linea: 'Hecho con OpenAnimator', url: 'openanimator.local' }
  ]
};
