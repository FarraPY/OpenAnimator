/*
 * Motor "Documental" de OpenAnimator (MIT).
 *
 * Convierte datos (window.DOC) en un documental ilustrado: un mundo SVG grande por el
 * que viaja una cámara; cada beat vive en su propio lugar del mundo y sus elementos
 * aparecen cuando el narrador los nombra (tiempos absolutos en segundos).
 *
 * Todo es una función pura del tiempo: render(t) sólo LEE t y ESCRIBE atributos.
 * Nada de Math.random, Date ni estado entre fotogramas.
 *
 * Tipos de beat:
 *   titulo   { t0, t1, kicker?, titulo, subtitulo?, icono? }
 *   puntos   { t0, t1, titulo, icono?, items: [{ t, texto, icono? }] }
 *   cifra    { t0, t1, valor, etiqueta, t?, nota? }
 *   comparar { t0, t1, titulo?, izq: { titulo, items: [{t, texto}] }, der: {…} }
 *   pasos    { t0, t1, titulo, pasos: [{ t, texto }] }
 *   cita     { t0, t1, texto, autor?, marcas?: [{ t, palabra }] }
 *   cierre   { t0, t1, titulo, subtitulo? }
 */
(function () {
  'use strict';
  var DOC = window.DOC;
  var NS = 'http://www.w3.org/2000/svg';
  var W = 1920, H = 1080;

  // ── paletas (se alternan para que el video no se aplane) ──────────────────
  var PALETAS = {
    papel:  { bg: '#f3ecdc', tinta: '#22303c', texto: '#22303c', sub: '#3e8b80', acento: '#e0892f', suave: '#dfe9dd', tarjeta: '#fbf7ee', mal: '#b9473c', oscuro: false },
    arena:  { bg: '#f2dfc4', tinta: '#2e2520', texto: '#2e2520', sub: '#9c4a2b', acento: '#c9502f', suave: '#f7e8d2', tarjeta: '#fff8ee', mal: '#a8322a', oscuro: false },
    menta:  { bg: '#dcefe6', tinta: '#1b3431', texto: '#1b3431', sub: '#2a7b6f', acento: '#dd8a30', suave: '#c3e4d6', tarjeta: '#f5fbf8', mal: '#b8473c', oscuro: false },
    noche:  { bg: '#132638', tinta: '#eef0f3', texto: '#eef0f3', sub: '#9fd6c4', acento: '#f2a93b', suave: '#23405c', tarjeta: '#1b3450', mal: '#f0a39a', oscuro: true },
    ciruela:{ bg: '#241a35', tinta: '#f3eaf7', texto: '#f3eaf7', sub: '#c7a8ff', acento: '#ffb454', suave: '#3a2c55', tarjeta: '#2e2244', mal: '#ff9d8f', oscuro: true },
  };
  var ORDEN_PALETAS = DOC.paletas || ['papel', 'noche', 'menta', 'arena', 'papel', 'ciruela'];

  // ── utilidades de tiempo (todas puras) ─────────────────────────────────────
  function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
  function prog(t, t0, d) { return d <= 0 ? (t >= t0 ? 1 : 0) : clamp((t - t0) / d, 0, 1); }
  var E = {
    outCubic: function (u) { return 1 - Math.pow(1 - u, 3); },
    inOutCubic: function (u) { return u < .5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2; },
    outBack: function (u) { var c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(u - 1, 3) + c1 * Math.pow(u - 1, 2); },
    smoother: function (u) { return u * u * u * (u * (u * 6 - 15) + 10); },
  };
  function lerp(a, b, u) { return a + (b - a) * u; }
  // Ruido determinista para "vida" sutil (sin Math.random).
  function wobble(t, seed, amp, freq) { return amp * (Math.sin(t * freq + seed * 1.7) * 0.6 + Math.sin(t * freq * 0.53 + seed * 3.1) * 0.4); }

  function el(tag, attrs, parent) {
    var e = document.createElementNS(NS, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  // ── íconos simples (trazos redondeados, tinta) ────────────────────────────
  var ICONOS = {
    check: 'M-22 2 L-6 18 L24 -16', cruz: 'M-18 -18 L18 18 M18 -18 L-18 18',
    estrella: 'M0 -26 L7 -8 L26 -8 L11 4 L17 23 L0 12 L-17 23 L-11 4 L-26 -8 L-7 -8 Z',
    corazon: 'M0 22 C-30 2 -26 -24 -8 -20 C-2 -19 0 -12 0 -10 C0 -12 2 -19 8 -20 C26 -24 30 2 0 22 Z',
    rayo: 'M6 -28 L-16 4 L0 4 L-6 28 L18 -6 L2 -6 Z',
    gota: 'M0 -26 C10 -10 20 0 20 10 A20 20 0 0 1 -20 10 C-20 0 -10 -10 0 -26 Z',
    libro: 'M-26 -18 L-2 -12 L-2 22 L-26 16 Z M2 -12 L26 -18 L26 16 L2 22 Z',
    grafico: 'M-24 22 L-24 -22 M-24 22 L24 22 M-14 12 L-4 -2 L6 6 L20 -14',
    persona: 'M0 -8 A10 10 0 1 0 0 -28 A10 10 0 1 0 0 -8 M-20 24 C-20 4 20 4 20 24',
    reloj: 'M0 -24 A24 24 0 1 0 0.01 -24 M0 -12 L0 0 L12 8',
    idea: 'M-10 18 L10 18 M-8 24 L8 24 M-12 10 C-24 -2 -18 -26 0 -26 C18 -26 24 -2 12 10 Z',
    globo: 'M0 -24 A24 24 0 1 0 0.01 -24 M-24 0 L24 0 M0 -24 C-12 -10 -12 10 0 24 C12 10 12 -10 0 -24',
    lupa: 'M-6 -6 m-14 0 a14 14 0 1 0 28 0 a14 14 0 1 0 -28 0 M4 4 L22 22',
    alerta: 'M0 -24 L24 20 L-24 20 Z M0 -8 L0 6 M0 12 L0 13',
    pastilla: 'M-20 8 L8 -20 A10 10 0 0 1 22 -6 L-6 22 A10 10 0 0 1 -20 8 Z M-6 -6 L8 8',
    cerebro: 'M-4 -22 C-20 -24 -28 -8 -22 2 C-30 12 -18 24 -4 20 Z M4 -22 C20 -24 28 -8 22 2 C30 12 18 24 4 20 Z',
    engranaje: 'M0 -10 A10 10 0 1 0 0.01 -10 M0 -26 L0 -18 M0 18 L0 26 M-26 0 L-18 0 M18 0 L26 0 M-18 -18 L-13 -13 M13 13 L18 18 M18 -18 L13 -13 M-13 13 L-18 18',
    flecha: 'M-24 0 L20 0 M8 -12 L20 0 L8 12',
    bandera: 'M-16 26 L-16 -24 M-16 -22 L18 -16 L8 -6 L18 4 L-16 -2',
  };
  function icono(nombre, x, y, s, pal, parent) {
    var g = el('g', { transform: 'translate(' + x + ' ' + y + ') scale(' + s + ')' }, parent);
    el('circle', { r: 40, fill: pal.suave, stroke: pal.tinta, 'stroke-width': 4 }, g);
    var d = ICONOS[nombre] || ICONOS.idea;
    var p = el('path', { d: d, fill: 'none', stroke: pal.tinta, 'stroke-width': 4.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, g);
    return { g: g, p: p };
  }

  // ── texto con ajuste de línea medido ──────────────────────────────────────
  var measureCtx = document.createElement('canvas').getContext('2d');
  function wrap(texto, fuente, maxW) {
    measureCtx.font = fuente;
    var palabras = String(texto).split(/\s+/), lineas = [], cur = '';
    palabras.forEach(function (w) {
      var prueba = cur ? cur + ' ' + w : w;
      if (measureCtx.measureText(prueba).width > maxW && cur) { lineas.push(cur); cur = w; } else cur = prueba;
    });
    if (cur) lineas.push(cur);
    return lineas;
  }
  /** Texto multilínea que se AJUSTA: baja el tamaño hasta que entra en maxW × maxLineas. */
  function texto(parent, str, x, y, opts) {
    var size = opts.size, fam = opts.fam || 'Inter', peso = opts.peso || 600;
    var lineas;
    for (var i = 0; i < 12; i++) {
      lineas = wrap(str, peso + ' ' + size + 'px ' + fam, opts.maxW);
      if (lineas.length <= (opts.maxLineas || 3)) break;
      size = Math.round(size * 0.9);
    }
    var t = el('text', { x: x, y: y, fill: opts.color, 'font-family': fam + ', Segoe UI, sans-serif', 'font-weight': peso, 'font-size': size, 'text-anchor': opts.anchor || 'start' }, parent);
    lineas.forEach(function (ln, k) { var ts = el('tspan', { x: x, dy: k ? size * 1.18 : 0 }, t); ts.textContent = ln; });
    return { node: t, alto: size * 1.18 * lineas.length, size: size, lineas: lineas.length };
  }

  // ── escena ────────────────────────────────────────────────────────────────
  var svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, width: '100%', height: '100%', preserveAspectRatio: 'xMidYMid meet' });
  svg.style.position = 'absolute'; svg.style.inset = '0';
  document.body.appendChild(svg);
  var defs = el('defs', {}, svg);
  var f = el('filter', { id: 'grano', x: 0, y: 0, width: '100%', height: '100%' }, defs);
  el('feTurbulence', { type: 'fractalNoise', baseFrequency: '0.8', numOctaves: 3, seed: 7, stitchTiles: 'stitch' }, f);
  el('feColorMatrix', { values: '0 0 0 0 .45  0 0 0 0 .38  0 0 0 0 .28  0 0 0 .5 0' }, f);
  var sombra = el('filter', { id: 'sombra', x: '-10%', y: '-10%', width: '120%', height: '130%' }, defs);
  el('feDropShadow', { dx: 0, dy: 10, stdDeviation: 14, 'flood-opacity': 0.18 }, sombra);
  var vg = el('radialGradient', { id: 'vineta', cx: '50%', cy: '50%', r: '75%' }, defs);
  el('stop', { offset: '60%', 'stop-color': '#000', 'stop-opacity': 0 }, vg);
  el('stop', { offset: '100%', 'stop-color': '#000', 'stop-opacity': 0.32 }, vg);

  var fondo = el('rect', { x: 0, y: 0, width: W, height: H, fill: '#f3ecdc' }, svg);
  var mundo = el('g', {}, svg);
  var grano = el('rect', { x: 0, y: 0, width: W, height: H, filter: 'url(#grano)', opacity: 0.22, 'pointer-events': 'none' }, svg);
  grano.style.mixBlendMode = 'multiply';
  el('rect', { x: 0, y: 0, width: W, height: H, fill: 'url(#vineta)', 'pointer-events': 'none' }, svg);
  var barra = el('rect', { x: 0, y: H - 8, width: 0, height: 8, fill: '#e0892f', opacity: 0.85 }, svg);
  var marca = el('text', { x: 64, y: 70, 'font-family': 'Inter, Segoe UI', 'font-weight': 700, 'font-size': 26, 'letter-spacing': 3, opacity: 0.7 }, svg);
  marca.textContent = (DOC.marca || '').toUpperCase();

  // Posiciones en el mundo: zig-zag para que la cámara viaje en direcciones distintas.
  var beats = DOC.beats.map(function (b, i) {
    var col = i % 3, fila = Math.floor(i / 3);
    var x = (fila % 2 === 0 ? col : 2 - col) * 2600, y = fila * 1700 + (col === 1 ? 260 : 0);
    var pal = PALETAS[b.paleta || ORDEN_PALETAS[i % ORDEN_PALETAS.length]] || PALETAS.papel;
    return { b: b, i: i, x: x, y: y, pal: pal, parts: [], g: null };
  });

  // Cada "parte" es un elemento con su propia aparición: { node, t, anim, ox, oy }
  function parte(bt, node, t, anim, extra) { var p = extra || {}; p.node = node; p.t = t; p.anim = anim; bt.parts.push(p); return p; }

  function construir(bt) {
    var b = bt.b, pal = bt.pal;
    var g = el('g', { transform: 'translate(' + bt.x + ' ' + bt.y + ')' }, mundo);
    bt.g = g;
    var t0 = b.t0;
    if (b.tipo === 'titulo' || b.tipo === 'cierre') {
      if (b.icono) { var ic = icono(b.icono, 960, 250, 2, pal, g); parte(bt, ic.g, t0 + 0.2, 'pop', { cx: 960, cy: 250, s: 1 }); }
      if (b.kicker) { var k = el('text', { x: 960, y: b.icono ? 440 : 400, 'text-anchor': 'middle', fill: pal.sub, 'font-family': 'Inter, Segoe UI', 'font-weight': 700, 'font-size': 34, 'letter-spacing': 6 }, g); k.textContent = b.kicker.toUpperCase(); parte(bt, k, t0 + 0.3, 'sube'); }
      var tt = texto(g, b.titulo, 960, b.icono ? 590 : 540, { size: 118, fam: 'Fraunces, Georgia, serif', peso: 700, color: pal.texto, maxW: 1500, maxLineas: 2, anchor: 'middle' });
      parte(bt, tt.node, t0 + (b.tTitulo != null ? b.tTitulo - t0 : 0.6), 'sube');
      var yb = (b.icono ? 590 : 540) + tt.alto - tt.size * 0.6;
      var sub = el('path', { d: 'M760 ' + (yb + 28) + ' Q960 ' + (yb + 12) + ' 1160 ' + (yb + 28), fill: 'none', stroke: pal.acento, 'stroke-width': 9, 'stroke-linecap': 'round' }, g);
      parte(bt, sub, t0 + 1.1, 'trazo', { len: 420 });
      if (b.subtitulo) { var st = texto(g, b.subtitulo, 960, yb + 110, { size: 56, fam: 'Caveat, Segoe Print, cursive', peso: 700, color: pal.sub, maxW: 1400, maxLineas: 2, anchor: 'middle' }); parte(bt, st.node, t0 + 1.4, 'sube'); }
    } else if (b.tipo === 'puntos') {
      var hx = 470;
      var ic2 = icono(b.icono || 'idea', hx, 540, 3.4, pal, g); parte(bt, ic2.g, t0 + 0.1, 'pop', { cx: hx, cy: 540, s: 1 });
      var tt2 = texto(g, b.titulo, 820, 250, { size: 74, fam: 'Fraunces, Georgia, serif', peso: 700, color: pal.texto, maxW: 1000, maxLineas: 2 });
      parte(bt, tt2.node, t0 + 0.35, 'sube');
      var items = b.items || [], n = items.length;
      var y0 = 250 + tt2.alto + 40, esp = Math.min(150, (1000 - y0) / Math.max(1, n));
      items.forEach(function (it, j) {
        var y = y0 + j * esp + 30;
        var c = el('g', { 'data-oa-figure': '' }, g);
        el('circle', { cx: 850, cy: y - 14, r: 14, fill: pal.acento }, c);
        parte(bt, c, it.t, 'pop', { cx: 850, cy: y - 14, s: 1 });
        var tx = texto(g, it.texto, 890, y, { size: 50, fam: 'Inter, Segoe UI', peso: 600, color: pal.texto, maxW: 900, maxLineas: 2 });
        parte(bt, tx.node, it.t + 0.05, 'desliza');
      });
    } else if (b.tipo === 'cifra') {
      var tn = b.t != null ? b.t : t0 + 0.4;
      var aro = el('circle', { cx: 960, cy: 470, r: 290, fill: 'none', stroke: pal.acento, 'stroke-width': 18, 'stroke-linecap': 'round', transform: 'rotate(-90 960 470)' }, g);
      parte(bt, aro, tn, 'trazo', { len: 2 * Math.PI * 290, dur: 1.4 });
      el('circle', { cx: 960, cy: 470, r: 262, fill: pal.tarjeta, filter: 'url(#sombra)' }, g).setAttribute('opacity', 1);
      var v = texto(g, b.valor, 960, 520, { size: 190, fam: 'Fraunces, Georgia, serif', peso: 800, color: pal.acento, maxW: 470, maxLineas: 1, anchor: 'middle' });
      parte(bt, v.node, tn + 0.2, 'pop', { cx: 960, cy: 470, s: 1 });
      var et = texto(g, b.etiqueta, 960, 870, { size: 64, fam: 'Inter, Segoe UI', peso: 700, color: pal.texto, maxW: 1500, maxLineas: 2, anchor: 'middle' });
      parte(bt, et.node, tn + 0.5, 'sube');
      if (b.nota) { var nt = texto(g, b.nota, 960, 870 + et.alto + 20, { size: 46, fam: 'Caveat, Segoe Print, cursive', peso: 700, color: pal.sub, maxW: 1400, maxLineas: 1, anchor: 'middle' }); parte(bt, nt.node, tn + 0.9, 'sube'); }
    } else if (b.tipo === 'comparar') {
      if (b.titulo) { var tc = texto(g, b.titulo, 960, 170, { size: 64, fam: 'Fraunces, Georgia, serif', peso: 700, color: pal.texto, maxW: 1600, maxLineas: 1, anchor: 'middle' }); parte(bt, tc.node, t0 + 0.2, 'sube'); }
      [['izq', 110, pal.sub], ['der', 1030, pal.mal]].forEach(function (lado, li) {
        var L = b[lado[0]]; if (!L) return;
        var x = lado[1];
        var card = el('g', {}, g);
        var alto = Math.max(420, 200 + Math.max((b.izq && b.izq.items || []).length, (b.der && b.der.items || []).length) * 110 + 60);
        el('rect', { x: x, y: 240, width: 780, height: alto, rx: 34, fill: pal.tarjeta, stroke: pal.tinta, 'stroke-width': 4, filter: 'url(#sombra)' }, card);
        parte(bt, card, t0 + 0.3 + li * 0.25, 'pop', { cx: x + 390, cy: 620, s: 1 });
        var th = texto(g, L.titulo, x + 390, 340, { size: 60, fam: 'Fraunces, Georgia, serif', peso: 700, color: lado[2], maxW: 700, maxLineas: 1, anchor: 'middle' });
        parte(bt, th.node, t0 + 0.5 + li * 0.25, 'sube');
        (L.items || []).forEach(function (it, j) {
          var tx = texto(g, '• ' + it.texto, x + 60, 450 + j * 110, { size: 44, fam: 'Inter, Segoe UI', peso: 600, color: pal.texto, maxW: 660, maxLineas: 2 });
          parte(bt, tx.node, it.t, 'desliza');
        });
      });
      var vs = el('g', {}, g);
      el('circle', { cx: 960, cy: 620, r: 46, fill: pal.acento, stroke: pal.tinta, 'stroke-width': 4 }, vs);
      var vst = el('text', { x: 960, y: 636, 'text-anchor': 'middle', fill: '#fff', 'font-family': 'Fraunces, Georgia', 'font-weight': 800, 'font-size': 44 }, vs); vst.textContent = 'vs';
      parte(bt, vs, t0 + 0.9, 'pop', { cx: 960, cy: 620, s: 1 });
    } else if (b.tipo === 'pasos') {
      var tp = texto(g, b.titulo, 960, 200, { size: 70, fam: 'Fraunces, Georgia, serif', peso: 700, color: pal.texto, maxW: 1600, maxLineas: 1, anchor: 'middle' });
      parte(bt, tp.node, t0 + 0.2, 'sube');
      var ps = b.pasos || [], m = ps.length, x0 = 260, x1 = 1660;
      var linea = el('path', { d: 'M' + x0 + ' 560 L' + x1 + ' 560', stroke: pal.tinta, 'stroke-width': 6, 'stroke-dasharray': '1 18', 'stroke-linecap': 'round', fill: 'none' }, g);
      parte(bt, linea, t0 + 0.5, 'aparece');
      ps.forEach(function (p, j) {
        var x = m === 1 ? 960 : lerp(x0, x1, j / (m - 1)), arriba = j % 2 === 0;
        var nodo = el('g', {}, g);
        el('circle', { cx: x, cy: 560, r: 62, fill: pal.acento, stroke: pal.tinta, 'stroke-width': 5 }, nodo);
        var num = el('text', { x: x, y: 582, 'text-anchor': 'middle', fill: '#fff', 'font-family': 'Fraunces, Georgia', 'font-weight': 800, 'font-size': 60 }, nodo); num.textContent = j + 1;
        parte(bt, nodo, p.t, 'pop', { cx: x, cy: 560, s: 1 });
        var tx = texto(g, p.texto, x, arriba ? 420 : 720, { size: 44, fam: 'Inter, Segoe UI', peso: 600, color: pal.texto, maxW: Math.min(420, (x1 - x0) / Math.max(1, m - 1) * 1.8), maxLineas: 3, anchor: 'middle' });
        if (arriba) tx.node.setAttribute('y', 440 - tx.alto + tx.size);
        parte(bt, tx.node, p.t + 0.1, 'sube');
      });
    } else if (b.tipo === 'cita') {
      var comillas = el('text', { x: 250, y: 400, fill: pal.acento, 'font-family': 'Fraunces, Georgia', 'font-weight': 800, 'font-size': 300, opacity: 0.9 }, g); comillas.textContent = '“';
      parte(bt, comillas, t0 + 0.1, 'pop', { cx: 330, cy: 300, s: 1 });
      var q = texto(g, b.texto, 960, 470, { size: 78, fam: 'Fraunces, Georgia, serif', peso: 600, color: pal.texto, maxW: 1400, maxLineas: 4, anchor: 'middle' });
      parte(bt, q.node, t0 + 0.4, 'sube');
      if (b.autor) { var au = el('text', { x: 960, y: 470 + q.alto + 60, 'text-anchor': 'middle', fill: pal.sub, 'font-family': 'Caveat, Segoe Print', 'font-weight': 700, 'font-size': 58 }, g); au.textContent = '— ' + b.autor; parte(bt, au, t0 + 1.2, 'sube'); }
    }
  }
  beats.forEach(construir);

  // ── cámara ────────────────────────────────────────────────────────────────
  var VUELO = DOC.vuelo || 1.2;
  function camara(t) {
    var idx = 0;
    for (var i = 0; i < beats.length; i++) if (t >= beats[i].b.t0) idx = i;
    var cur = beats[idx], prev = beats[Math.max(0, idx - 1)];
    var u = idx === 0 ? 1 : E.inOutCubic(prog(t, cur.b.t0 - 0.15, VUELO));
    var cx = lerp(prev.x, cur.x, u), cy = lerp(prev.y, cur.y, u);
    // Alejamiento a mitad del vuelo ("fly-over") y deriva lenta durante el beat.
    var fly = idx === 0 ? 0 : Math.sin(Math.PI * u) * 0.28;
    var local = t - cur.b.t0, dur = Math.max(1, (cur.b.t1 || cur.b.t0 + 6) - cur.b.t0);
    var zoom = (1 + 0.035 * E.smoother(clamp(local / dur, 0, 1))) * (1 - fly);
    cx += wobble(t, idx, 6, 0.6); cy += wobble(t, idx + 5, 5, 0.5);
    return { x: cx, y: cy, z: zoom, idx: idx, u: u };
  }

  function aplicar(p, t) {
    var u = prog(t, p.t, p.dur || (p.anim === 'trazo' ? 0.9 : 0.55));
    var n = p.node;
    if (p.anim === 'trazo') {
      n.setAttribute('stroke-dasharray', p.len);
      n.setAttribute('stroke-dashoffset', p.len * (1 - E.outCubic(u)));
      n.setAttribute('opacity', u > 0 ? 1 : 0);
    } else if (p.anim === 'pop') {
      var s = u <= 0 ? 0.001 : E.outBack(u) * (p.s || 1);
      n.setAttribute('transform', 'translate(' + p.cx + ' ' + p.cy + ') scale(' + s + ') translate(' + (-p.cx) + ' ' + (-p.cy) + ')' + (n.__base || ''));
      n.setAttribute('opacity', clamp(u * 3, 0, 1));
    } else if (p.anim === 'sube') {
      var e = E.outCubic(u);
      n.setAttribute('transform', 'translate(0 ' + (1 - e) * 36 + ')');
      n.setAttribute('opacity', e);
    } else if (p.anim === 'desliza') {
      var e2 = E.outCubic(u);
      n.setAttribute('transform', 'translate(' + (1 - e2) * -40 + ' 0)');
      n.setAttribute('opacity', e2);
    } else {
      n.setAttribute('opacity', E.outCubic(u));
    }
  }
  // Los íconos ya tienen transform propio: guardarlo para componer el "pop".
  beats.forEach(function (bt) { bt.parts.forEach(function (p) { if (p.anim === 'pop') { var tr = p.node.getAttribute('transform'); p.node.__base = tr ? ' ' + tr : ''; } }); });

  function render(t) {
    var c = camara(t);
    var cur = beats[c.idx], prev = beats[Math.max(0, c.idx - 1)];
    // Fondo: mezcla de color durante el vuelo.
    fondo.setAttribute('fill', c.u < 1 ? mezcla(prev.pal.bg, cur.pal.bg, c.u) : cur.pal.bg);
    grano.setAttribute('opacity', cur.pal.oscuro ? 0.10 : 0.22);
    marca.setAttribute('fill', cur.pal.tinta);
    barra.setAttribute('fill', cur.pal.acento);
    barra.setAttribute('width', W * clamp(t / DOC.duracion, 0, 1));
    var tx = W / 2 - (c.x + W / 2) * c.z, ty = H / 2 - (c.y + H / 2) * c.z;
    mundo.setAttribute('transform', 'translate(' + tx + ' ' + ty + ') scale(' + c.z + ')');
    beats.forEach(function (bt) {
      var visible = Math.abs(bt.i - c.idx) <= 1;
      bt.g.setAttribute('display', visible ? 'inline' : 'none');
      if (!visible) return;
      // El beat que se va se desvanece al final para que la cámara llegue a un lugar limpio.
      var salida = bt.i < c.idx ? 1 - c.u : 1;
      bt.g.setAttribute('opacity', salida);
      bt.parts.forEach(function (p) { aplicar(p, t); });
    });
  }
  function hex(h) { var n = parseInt(h.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
  function mezcla(a, b, u) { var x = hex(a), y = hex(b); return 'rgb(' + x.map(function (v, i) { return Math.round(lerp(v, y[i], u)); }).join(',') + ')'; }

  window.__oa = { duration: DOC.duracion, render: render };
  render(0);
})();
