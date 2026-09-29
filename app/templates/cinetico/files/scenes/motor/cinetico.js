/*
 * Motor "Cinético" de OpenAnimator (MIT) — tipografía en movimiento.
 * Datos en window.KINE (scenes/guion.js). render(t) es puro: sólo lee t.
 *
 * Unidad: 1 "u" = 1 px de un cuadro 1920×1080 (todo escala al tamaño real).
 * Fondos: 'claro' | 'tinta' | 'marca'  (alternalos para que no se aplane).
 *
 * Beats:
 *   palabras { t0, t1, fondo?, texto, destacar?: ['palabra'] }       palabra por palabra con desenfoque
 *   grande   { t0, t1, fondo?, texto, sub? }                          una palabra enorme que "respira"
 *   lista    { t0, t1, fondo?, titulo, items: [{ t, texto }] }         filas numeradas escalonadas
 *   mascara  { t0, t1, fondo?, lineas: ['…','…'] }                     líneas que suben desde su propia caja
 *   contador { t0, t1, fondo?, desde, hasta, decimales?, sufijo?, etiqueta }
 *   final    { t0, t1, fondo?, titulo, linea?, url? }
 */
(function () {
  'use strict';
  var K = window.KINE;
  var C = Object.assign({ claro: '#ffffff', tinta: '#0b0b10', marca: '#6352ff', textoClaro: '#0b0b10', textoOscuro: '#ffffff', acento: '#6352ff', acentoOscuro: '#b3a9ff', fuente: 'Segoe UI Variable Display, Segoe UI, Inter, sans-serif' }, K.colores || {});

  function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
  function prog(t, a, d) { return d <= 0 ? (t >= a ? 1 : 0) : clamp((t - a) / d, 0, 1); }
  var outCubic = function (u) { return 1 - Math.pow(1 - u, 3); };
  var outExpo = function (u) { return u >= 1 ? 1 : 1 - Math.pow(2, -10 * u); };
  var outBack = function (u) { var c = 1.70158; return 1 + (c + 1) * Math.pow(u - 1, 3) + c * Math.pow(u - 1, 2); };
  var inOut = function (u) { return u < .5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2; };

  var stage = document.createElement('div');
  stage.id = 'stage';
  document.body.appendChild(stage);
  var css = document.createElement('style');
  css.textContent = [
    'html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#000}',
    '#stage{position:absolute;left:50%;top:50%;width:1920px;height:1080px;transform-origin:0 0;font-family:' + C.fuente + '}',
    '.beat{position:absolute;inset:0;display:none}',
    '.cap{position:absolute;left:0;right:0;text-align:center;white-space:nowrap}',
    '.w{display:inline-block;margin:0 .14em;will-change:transform,filter,opacity}',
    '.row{position:absolute;left:260px;right:200px;display:flex;align-items:baseline;gap:40px}',
    '.num{font-weight:800;font-size:44px;opacity:.55;min-width:70px}',
    '.mask{position:absolute;left:0;right:0;overflow:hidden;text-align:center}',
    '.mask>div{will-change:transform}',
  ].join('\n');
  document.head.appendChild(css);

  function fit() {
    var s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
    stage.style.transform = 'scale(' + s + ') translate(-50%,-50%)';
    stage.style.left = '50%'; stage.style.top = '50%';
    stage.style.transform = 'translate(-50%,-50%) scale(' + s + ')';
    stage.style.transformOrigin = '50% 50%';
  }
  window.addEventListener('resize', fit);
  fit();

  function div(cls, parent, html) { var d = document.createElement('div'); if (cls) d.className = cls; if (html != null) d.textContent = html; parent.appendChild(d); return d; }
  function colores(fondo) {
    if (fondo === 'tinta') return { bg: C.tinta, fg: C.textoOscuro, ac: C.acentoOscuro };
    if (fondo === 'marca') return { bg: C.marca, fg: '#ffffff', ac: '#ffffff' };
    return { bg: C.claro, fg: C.textoClaro, ac: C.acento };
  }
  var FONDOS = ['claro', 'claro', 'tinta', 'claro', 'marca'];

  var beats = K.beats.map(function (b, i) {
    var col = colores(b.fondo || FONDOS[i % FONDOS.length]);
    var root = div('beat', stage);
    root.style.background = col.bg; root.style.color = col.fg;
    var o = { b: b, root: root, col: col, parts: [] };
    if (b.tipo === 'palabras') {
      var cap = div('cap', root); cap.style.top = '430px'; cap.style.fontSize = '104px'; cap.style.fontWeight = 700; cap.style.whiteSpace = 'normal'; cap.style.padding = '0 160px'; cap.style.lineHeight = '1.1';
      var ws = String(b.texto).split(/\s+/), d = Math.min(0.12, (b.t1 - b.t0 - 1) / Math.max(1, ws.length));
      ws.forEach(function (w, j) {
        var s = document.createElement('span'); s.className = 'w'; s.textContent = w; cap.appendChild(s);
        if ((b.destacar || []).indexOf(w.replace(/[.,;:!?¡¿]/g, '')) >= 0) s.style.color = col.ac;
        o.parts.push({ el: s, t: b.t0 + 0.15 + j * d, kind: 'blur' });
      });
      cap.style.top = 540 - (Math.ceil(ws.join(' ').length / 26) * 58) + 'px';
    } else if (b.tipo === 'grande') {
      var g = div('cap', root, b.texto); g.style.top = '330px'; g.style.fontSize = '260px'; g.style.fontWeight = 900; g.style.letterSpacing = '-6px';
      o.parts.push({ el: g, t: b.t0 + 0.1, kind: 'swell' });
      if (b.sub) { var sb = div('cap', root, b.sub); sb.style.top = '680px'; sb.style.fontSize = '54px'; sb.style.fontWeight = 600; sb.style.color = col.ac; o.parts.push({ el: sb, t: b.t0 + 0.6, kind: 'rise' }); }
    } else if (b.tipo === 'lista') {
      var tt = div('cap', root, b.titulo); tt.style.top = '150px'; tt.style.fontSize = '84px'; tt.style.fontWeight = 800; tt.style.textAlign = 'left'; tt.style.left = '260px';
      o.parts.push({ el: tt, t: b.t0 + 0.1, kind: 'rise' });
      (b.items || []).forEach(function (it, j) {
        var r = div('row', root); r.style.top = 340 + j * 150 + 'px';
        var n = div('num', r, String(j + 1).padStart(2, '0')); n.style.color = col.ac;
        var tx = div('', r, it.texto); tx.style.fontSize = '64px'; tx.style.fontWeight = 650;
        o.parts.push({ el: r, t: it.t, kind: 'slide' });
      });
    } else if (b.tipo === 'mascara') {
      (b.lineas || []).forEach(function (ln, j) {
        var m = div('mask', root); m.style.top = 540 - (b.lineas.length * 140) / 2 + j * 140 + 'px'; m.style.height = '140px';
        var inner = div('', m, ln); inner.style.fontSize = '118px'; inner.style.fontWeight = 800; inner.style.lineHeight = '140px';
        if (j % 2 === 1) inner.style.color = col.ac;
        o.parts.push({ el: inner, t: b.t0 + 0.2 + j * 0.35, kind: 'mask' });
      });
    } else if (b.tipo === 'contador') {
      var v = div('cap', root, ''); v.style.top = '300px'; v.style.fontSize = '300px'; v.style.fontWeight = 900; v.style.color = col.ac; v.style.fontVariantNumeric = 'tabular-nums';
      o.parts.push({ el: v, t: b.t0 + 0.2, kind: 'count', b: b });
      var e = div('cap', root, b.etiqueta || ''); e.style.top = '700px'; e.style.fontSize = '64px'; e.style.fontWeight = 650;
      o.parts.push({ el: e, t: b.t0 + 0.7, kind: 'rise' });
    } else if (b.tipo === 'final') {
      var ti = div('cap', root, b.titulo); ti.style.top = '360px'; ti.style.fontSize = '150px'; ti.style.fontWeight = 900;
      o.parts.push({ el: ti, t: b.t0 + 0.2, kind: 'smash' });
      if (b.linea) { var li = div('cap', root, b.linea); li.style.top = '580px'; li.style.fontSize = '56px'; li.style.fontWeight = 600; o.parts.push({ el: li, t: b.t0 + 0.7, kind: 'rise' }); }
      if (b.url) { var u = div('cap', root, b.url); u.style.top = '700px'; u.style.fontSize = '44px'; u.style.color = col.ac; u.style.fontWeight = 700; o.parts.push({ el: u, t: b.t0 + 1.1, kind: 'rise' }); }
    }
    return o;
  });

  function part(p, t, out) {
    var u = prog(t, p.t, 0.6), e = outCubic(u), s = p.el.style;
    if (p.kind === 'blur') { s.opacity = e; s.filter = 'blur(' + ((1 - e) * 18).toFixed(2) + 'px)'; s.transform = 'translateY(' + ((1 - e) * 40).toFixed(2) + 'px)'; }
    else if (p.kind === 'rise') { s.opacity = e; s.transform = 'translateY(' + ((1 - e) * 50).toFixed(2) + 'px)'; }
    else if (p.kind === 'slide') { s.opacity = e; s.transform = 'translateX(' + ((1 - outExpo(prog(t, p.t, 0.7))) * -120).toFixed(2) + 'px)'; }
    else if (p.kind === 'mask') { s.transform = 'translateY(' + ((1 - outExpo(prog(t, p.t, 0.8))) * 140).toFixed(2) + 'px)'; }
    else if (p.kind === 'swell') { var w = 400 + 500 * Math.sin(Math.PI * prog(t, p.t, 1.6)); s.fontWeight = Math.round(clamp(w, 400, 900)); s.opacity = e; s.transform = 'scale(' + (0.92 + 0.08 * e) + ')'; }
    else if (p.kind === 'smash') { var k = prog(t, p.t, 0.5); s.opacity = k > 0 ? 1 : 0; s.transform = 'scale(' + (k < 1 ? 2.4 - 1.4 * outBack(k) : 1) + ')'; }
    else if (p.kind === 'count') { var c = inOut(prog(t, p.t, 1.6)), b = p.b; var val = b.desde + (b.hasta - b.desde) * c; p.el.textContent = val.toFixed(b.decimales || 0).replace('.', ',') + (b.sufijo || ''); s.opacity = u > 0 ? 1 : 0; }
    if (out < 1) { s.opacity = String(parseFloat(s.opacity || '1') * out); }
  }

  function render(t) {
    beats.forEach(function (o) {
      var b = o.b, on = t >= b.t0 && t < b.t1;
      o.root.style.display = on ? 'block' : 'none';
      if (!on) return;
      var out = 1 - prog(t, b.t1 - 0.35, 0.35);
      o.parts.forEach(function (p) { part(p, t, out); });
      // Empuje sutil de cámara durante todo el beat.
      var z = 1 + 0.04 * inOut(prog(t, b.t0, b.t1 - b.t0));
      o.root.style.transform = 'scale(' + z.toFixed(4) + ')';
    });
  }
  window.__oa = { duration: K.duracion, render: render };
  render(0);
})();
