/*
 * OpenAnimator scene runtime — se inyecta como PRIMER script de cada escena HTML.
 *
 * Objetivo: que CUALQUIER página HTML sea un video determinista, aunque no fue
 * escrita para eso. Estrategias de control del tiempo, en orden de preferencia:
 *
 *   1. window.__oa           → contrato propio: { duration?, render(t) | async renderFrame(t) }
 *   2. window.__kcControl    → compatibilidad con escenas estilo CoAnimator (renderFrame / seekAndPause)
 *   3. Reloj virtual         → performance.now, Date, requestAnimationFrame, setTimeout/setInterval,
 *                              animaciones CSS/WAAPI y <video data-oa-sync> se controlan desde afuera.
 *
 * Mientras la escena no fue "tomada" (takeControl), todo corre en tiempo real
 * para que la carga (fuentes, Babel, fetch…) funcione normal.
 */
(function () {
  'use strict';
  if (window.__oaRuntime) return;

  var realRAF = window.requestAnimationFrame.bind(window);
  var realCAF = window.cancelAnimationFrame.bind(window);
  var realSetTimeout = window.setTimeout.bind(window);
  var realClearTimeout = window.clearTimeout.bind(window);
  var realSetInterval = window.setInterval.bind(window);
  var realClearInterval = window.clearInterval.bind(window);
  var realPerfNow = performance.now.bind(performance);
  var RealDate = window.Date;

  // El TIEMPO está congelado desde el primer instante: la carga de la página es t=0.
  // Lo que se "toma" recién con takeControl es la ejecución de rAF/timers (antes corren
  // en tiempo real para que la carga no se cuelgue, pero siempre ven el tiempo virtual).
  var controlled = false;
  var virtualMs = 0;            // tiempo virtual de la escena (ms) = performance.now()
  var dateBase = RealDate.now();

  // ── requestAnimationFrame virtual ─────────────────────────────────────────
  var rafSeq = 1, rafQueue = new Map();
  window.requestAnimationFrame = function (cb) {
    if (!controlled) return realRAF(function () { cb(virtualMs); });
    var id = 1e9 + rafSeq++;
    rafQueue.set(id, cb);
    return id;
  };
  window.cancelAnimationFrame = function (id) {
    if (rafQueue.has(id)) rafQueue.delete(id); else realCAF(id);
  };

  // ── timers virtuales ──────────────────────────────────────────────────────
  var timerSeq = 1, timers = new Map();
  function addTimer(cb, ms, args, repeat) {
    var id = 2e9 + timerSeq++;
    timers.set(id, { cb: cb, at: virtualMs + Math.max(0, +ms || 0), every: repeat ? Math.max(1, +ms || 1) : 0, args: args });
    return id;
  }
  window.setTimeout = function (cb, ms) {
    var args = Array.prototype.slice.call(arguments, 2);
    if (!controlled || typeof cb !== 'function') return realSetTimeout.apply(window, arguments);
    return addTimer(cb, ms, args, false);
  };
  window.setInterval = function (cb, ms) {
    var args = Array.prototype.slice.call(arguments, 2);
    if (!controlled || typeof cb !== 'function') return realSetInterval.apply(window, arguments);
    return addTimer(cb, ms, args, true);
  };
  window.clearTimeout = function (id) { if (timers.has(id)) timers.delete(id); else realClearTimeout(id); };
  window.clearInterval = function (id) { if (timers.has(id)) timers.delete(id); else realClearInterval(id); };

  // ── performance.now / Date ────────────────────────────────────────────────
  performance.now = function () { return virtualMs; };
  function VDate() {
    if (!(this instanceof VDate)) return new RealDate(dateBase + virtualMs).toString();
    if (arguments.length === 0) return new RealDate(dateBase + virtualMs);
    var a = [null].concat(Array.prototype.slice.call(arguments));
    return new (Function.prototype.bind.apply(RealDate, a))();
  }
  VDate.prototype = RealDate.prototype;
  VDate.now = function () { return dateBase + virtualMs; };
  VDate.parse = RealDate.parse; VDate.UTC = RealDate.UTC;
  window.Date = VDate;

  // ── WebGL: esperar a la GPU (captura) ─────────────────────────────────────
  // Referencias débiles: un contexto que la escena suelta (p. ej. para ver si hay WebGL) no queda vivo por esto
  // (pasados ~16 vivos, Chromium pierde el más viejo, que puede ser el de la escena).
  var glContexts = [];
  var realGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type) {
    var g = realGetContext.apply(this, arguments);
    if (g && /webgl/i.test(type) && typeof WeakRef === 'function') {
      glContexts = glContexts.filter(function (r) { return r.deref(); });
      if (!glContexts.some(function (r) { return r.deref() === g; })) glContexts.push(new WeakRef(g));
    }
    return g;
  };
  /** Lee un píxel de lo que se ve, sin que la escena note nada (framebuffer, PBO y parámetros de lectura como estaban). */
  function readOne(g) {
    var gl2 = typeof WebGL2RenderingContext !== 'undefined' && g instanceof WebGL2RenderingContext;
    var target = gl2 ? g.READ_FRAMEBUFFER : g.FRAMEBUFFER;
    var fb = g.getParameter(gl2 ? g.READ_FRAMEBUFFER_BINDING : g.FRAMEBUFFER_BINDING);
    var pbo = gl2 ? g.getParameter(g.PIXEL_PACK_BUFFER_BINDING) : null;
    var pack = gl2 ? [g.PACK_ROW_LENGTH, g.PACK_SKIP_PIXELS, g.PACK_SKIP_ROWS].map(function (p) { return [p, g.getParameter(p)]; }).filter(function (x) { return x[1]; }) : [];
    if (fb) g.bindFramebuffer(target, null);
    if (pbo) g.bindBuffer(g.PIXEL_PACK_BUFFER, null);
    pack.forEach(function (x) { g.pixelStorei(x[0], 0); });
    g.readPixels(0, 0, 1, 1, g.RGBA, g.UNSIGNED_BYTE, px);
    pack.forEach(function (x) { g.pixelStorei(x[0], x[1]); });
    if (pbo) g.bindBuffer(g.PIXEL_PACK_BUFFER, pbo);
    if (fb) g.bindFramebuffer(target, fb);
  }
  /**
   * Captura: espera a que la GPU termine lo que dibujó la escena. Sin esperar, con un WebGL pesado la página entrega el
   * cuadro siguiente antes de que se muestre éste, el motor lo reemplaza y la GPU lo dibujó en vano (raymarching de
   * «Prueba de render»: 70 de 180 dos veces; 14,3 → 16,8 fps). finish() de WebGL es sólo un flush: leer un píxel espera.
   * Si la espera es corta (la escena usa poco la GPU) frenar cuesta más de lo que ahorra (puntos GPU: 96 → 84 fps):
   * se vuelve a medir cada 60 cuadros.
   */
  var px = new Uint8Array(4), syncSkip = 0;
  function gpuSync() {
    if (syncSkip > 0) { syncSkip--; return; }
    var ms = gpuWait();
    if (ms >= 0 && ms < 12) syncSkip = 60;
  }
  /** Espera a la GPU y devuelve cuánto tardó (ms), o -1 si la escena no tiene WebGL (también para el costo, ver measureCost). */
  function gpuWait() {
    var live = glContexts.map(function (r) { return r.deref(); }).filter(function (g) { return g && g.canvas.isConnected && !g.isContextLost(); });
    if (!live.length) return -1;
    var t0 = realPerfNow();
    live.forEach(readOne);
    return realPerfNow() - t0;
  }

  // ── animaciones CSS / Web Animations ──────────────────────────────────────
  var animFirstSeen = new WeakMap();
  var cssPaused = new WeakSet();
  var CSSAnim = window.CSSAnimation, CSSTrans = window.CSSTransition;
  function syncAnimations() {
    if (!document.getAnimations) return;
    var list = document.getAnimations();
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (!animFirstSeen.has(a)) {
        // Las que existen al tomar el control arrancaron en t=0; las posteriores, cuando aparecieron.
        animFirstSeen.set(a, virtualMs <= 0.5 ? 0 : virtualMs);
      }
      try {
        // En una animación CSS, leer playState recalcula los estilos de todo el documento (y el currentTime
        // anterior los dejó sucios): con cientos era cuadrático (1600 animaciones: más de 1 s por fotograma).
        // Se pausan una vez: pausadas ya no siguen a animation-play-state. Las del script (el.animate) pueden
        // volver a arrancar con play(): a ésas se les pregunta, sin costo.
        if ((CSSAnim && a instanceof CSSAnim) || (CSSTrans && a instanceof CSSTrans)) {
          if (!cssPaused.has(a)) { a.pause(); cssPaused.add(a); }
        } else if (a.playState !== 'paused') a.pause();
        a.currentTime = Math.max(0, virtualMs - animFirstSeen.get(a));
      } catch (e) { /* animación sin timeline */ }
    }
  }

  // ── WebKit: máscaras SVG sobre grupos grandes ─────────────────────────────
  // El motor SVG de WebKit aplica la máscara de un <g mask> a cada figura de adentro por separado, con la CPU: en la
  // escena SVG de «Prueba de render» (1500 figuras bajo una máscara) el iPhone exportaba a 7 fps. Aislado cada hijo que
  // es un grupo (isolation), WebKit lo pinta en una capa propia y la enmascara una vez: 13 fps (mientras la máscara se
  // abre, 4 → 7,8) y la misma imagen (PSNR al nivel del ruido del codificador, sin corrimiento de color). isolation sólo
  // cambia el resultado con mix-blend-mode adentro: esas máscaras no se tocan. Chromium no lo necesita.
  var WEBKIT = /AppleWebKit/i.test(navigator.userAgent) && !/Chrome|Chromium|CriOS|Android|Edg/i.test(navigator.userAgent);
  var maskBlends = new WeakMap();
  function isolateMasked() {
    var list = document.querySelectorAll('svg [mask]');
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      // ponytail: los modos de mezcla se miran una vez por máscara; uno agregado después quedaría aislado.
      if (!maskBlends.has(m)) maskBlends.set(m, Array.prototype.some.call(m.querySelectorAll('*'), function (el) { return getComputedStyle(el).mixBlendMode !== 'normal'; }));
      if (maskBlends.get(m)) continue;
      for (var c = m.firstElementChild; c; c = c.nextElementSibling) {
        if (c.firstElementChild && c.style && c.style.isolation !== 'isolate') c.style.isolation = 'isolate';
      }
    }
  }

  // ── videos sincronizados (<video data-oa-sync> o data-oa-time) ────────────
  function syncVideos(t) {
    var vids = document.querySelectorAll('video[data-oa-sync], video[data-oa-time], video[data-kc-desired-time]');
    var waits = [];
    vids.forEach(function (v) {
      var target;
      if (v.hasAttribute('data-oa-time')) target = parseFloat(v.getAttribute('data-oa-time'));
      else if (v.hasAttribute('data-kc-desired-time')) target = parseFloat(v.getAttribute('data-kc-desired-time'));
      else target = t - (parseFloat(v.getAttribute('data-oa-start')) || 0) + (parseFloat(v.getAttribute('data-oa-in')) || 0);
      if (!isFinite(target)) return;
      if (v.duration && isFinite(v.duration)) target = Math.min(Math.max(0, target), v.duration - 0.001);
      try { v.pause(); } catch (e) {}
      if (Math.abs(v.currentTime - target) < 0.004 && v.readyState >= 2) return;
      waits.push(new Promise(function (res) {
        var done = false;
        function fin() { if (!done) { done = true; v.removeEventListener('seeked', fin); res(); } }
        v.addEventListener('seeked', fin);
        realSetTimeout(fin, 3000);
        v.currentTime = target;
      }));
    });
    return Promise.all(waits);
  }

  function flushTimers() {
    var guard = 0;
    while (guard++ < 10000) {
      var next = null, nextId = null;
      timers.forEach(function (tm, id) { if (tm.at <= virtualMs && (!next || tm.at < next.at)) { next = tm; nextId = id; } });
      if (!next) break;
      if (next.every) next.at += next.every; else timers.delete(nextId);
      try { next.cb.apply(window, next.args); } catch (e) { console.error(e); }
    }
  }

  function flushRAF() {
    // Una pasada: los callbacks que se re-encolen quedan para el próximo frame.
    var batch = Array.from(rafQueue.entries());
    rafQueue.clear();
    var ts = virtualMs;
    for (var i = 0; i < batch.length; i++) {
      try { batch[i][1](ts); } catch (e) { console.error(e); }
    }
  }

  function nextPaint() {
    return new Promise(function (res) { realRAF(function () { realRAF(function () { res(); }); }); });
  }

  function imagesReady() {
    var imgs = Array.prototype.filter.call(document.images, function (im) { return !im.complete; });
    return Promise.all(imgs.map(function (im) {
      return new Promise(function (res) { im.addEventListener('load', res, { once: true }); im.addEventListener('error', res, { once: true }); realSetTimeout(res, 5000); });
    }));
  }

  function detectMode() {
    if (window.__oa && (typeof window.__oa.render === 'function' || typeof window.__oa.renderFrame === 'function')) return 'oa';
    if (window.__kcControl && (typeof window.__kcControl.renderFrame === 'function' || typeof window.__kcControl.seekAndPause === 'function' || typeof window.__kcControl.seek === 'function')) return 'kc';
    return 'clock';
  }

  function getDuration() {
    try {
      if (window.__oa && window.__oa.duration) return +window.__oa.duration;
      if (window.__kcControl && typeof window.__kcControl.getDuration === 'function') return +window.__kcControl.getDuration() || 0;
    } catch (e) {}
    return 0;
  }

  var busy = Promise.resolve();

  /** Deja la escena exactamente en el instante t (segundos) y espera a que esté lista para capturar. */
  function renderAt(t, opts) {
    opts = opts || {};
    var job = busy.then(async function () {
      if (!controlled) takeControl();
      t = Math.max(0, +t || 0);
      virtualMs = t * 1000;
      var mode = detectMode();
      if (mode === 'oa') {
        var oa = window.__oa;
        if (typeof oa.renderFrame === 'function') await oa.renderFrame(t, { fps: opts.fps || 30 });
        else oa.render(t);
      } else if (mode === 'kc') {
        var kc = window.__kcControl;
        if (typeof kc.renderFrame === 'function') await kc.renderFrame(t, { fps: opts.fps || 30 });
        else if (typeof kc.seekAndPause === 'function') kc.seekAndPause(t);
        else kc.seek(t);
      }
      flushTimers();
      flushRAF();
      syncAnimations();
      if (WEBKIT) isolateMasked();
      await syncVideos(t);
      await imagesReady();
      if (document.fonts && document.fonts.status !== 'loaded') await document.fonts.ready;
      if (!opts.skipPaint) await nextPaint();
      return { t: t, mode: mode };
    });
    busy = job.catch(function () {});
    return job;
  }

  function takeControl() {
    if (controlled) return;
    controlled = true;
    // Silenciar el audio propio de la escena: el timeline es la única fuente de audio.
    document.querySelectorAll('audio, video').forEach(function (m) { try { m.muted = true; m.pause(); } catch (e) {} });
  }

  /** Auditoría de layout en el estado actual: textos fuera de cuadro, textos superpuestos, texto sobre figuras. */
  function auditNow(margin) {
    margin = margin == null ? 4 : margin;
    var W = window.innerWidth, H = window.innerHeight;
    var texts = [], figures = [];
    function visible(el) {
      var cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') return false;
      var o = 1, n = el;
      while (n && n.nodeType === 1) { var s = getComputedStyle(n); o *= parseFloat(s.opacity); if (o < 0.25) return false; n = n.parentElement || (n.ownerSVGElement ? n.parentNode : null); }
      return true;
    }
    var walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    var seen = new Set();
    while (walker.nextNode()) {
      var tn = walker.currentNode, str = (tn.nodeValue || '').trim();
      if (!str) continue;
      var el = tn.parentElement; if (!el || seen.has(el)) continue;
      if (/^(SCRIPT|STYLE|NOSCRIPT|TITLE)$/i.test(el.tagName)) continue;
      seen.add(el);
      if (!visible(el)) continue;
      var r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      texts.push({ str: str.slice(0, 60), box: [r.left, r.top, r.right, r.bottom] });
    }
    document.querySelectorAll('[data-oa-figure], [data-c="figure"], [data-c="chip"]').forEach(function (el) {
      if (!visible(el)) return;
      var r = el.getBoundingClientRect();
      if (r.width > 2 && r.height > 2) figures.push({ box: [r.left, r.top, r.right, r.bottom] });
    });
    function inter(a, b, pad) { return a[0] < b[2] - pad && b[0] < a[2] - pad && a[1] < b[3] - pad && b[1] < a[3] - pad; }
    function contains(a, b) { return a[0] <= b[0] + 1 && a[1] <= b[1] + 1 && a[2] >= b[2] - 1 && a[3] >= b[3] - 1; }
    var issues = [];
    texts.forEach(function (tx, i) {
      var b = tx.box;
      if (b[0] < -margin || b[1] < -margin || b[2] > W + margin || b[3] > H + margin) issues.push({ kind: 'fuera-de-cuadro', text: tx.str, box: b.map(Math.round) });
      for (var j = i + 1; j < texts.length; j++) {
        var o = texts[j];
        if (contains(b, o.box) || contains(o.box, b)) continue; // anidados (p.ej. <tspan> dentro de <text>)
        if (inter(b, o.box, 3)) issues.push({ kind: 'texto-sobre-texto', text: tx.str + ' ✕ ' + o.str, box: b.map(Math.round) });
      }
    });
    return { width: W, height: H, texts: texts.length, issues: issues };
  }

  window.__oaRuntime = {
    version: 1,
    renderAt: renderAt,
    takeControl: takeControl,
    isControlled: function () { return controlled; },
    mode: detectMode,
    getDuration: getDuration,
    audit: async function (t) { await renderAt(t, { skipPaint: true }); return auditNow(); },
    gpuSync: gpuSync,
    gpuWait: gpuWait,
    realSetTimeout: realSetTimeout
  };
})();
