/*
 * OpenAnimator compositor — arma un timeline completo en una sola página.
 *
 * La MISMA página se usa para la vista previa del editor y para exportar:
 * "un solo renderizador", así lo que se ve es exactamente lo que sale en el MP4.
 *
 *   oa://app/runtime/compositor.html?p=<proyecto>&tl=<timeline>&mode=preview|export[&capture=1]
 *
 * capture=1 (exportación en Android): la página ocupa toda la vista (el escenario se escala al tamaño
 * del video) y Java la captura directamente: __oaCap(t, n) deja el compositor en t y pone
 * __oaCapDone = n; __oaCapReady avisa que cargó. Los pedidos se atienden de a uno y en orden.
 * Con marker=1 (captura por GPU, Capture.java) la vista es 16 píxeles más alta que el video: en esa
 * franja de abajo, 8 celdas de colores puros dicen el número del fotograma que se está viendo (0 =
 * cambiando); Java la recorta. __oaCapTest(n) muestra un patrón de prueba con el número n.
 *
 * Capas visuales: pistas "scene" (HTML), "video" (mp4/webm/imagen). La primera pista
 * visual del array se dibuja ADELANTE. Las pistas "audio" sólo suenan en la vista previa
 * (en la exportación el audio lo mezcla FFmpeg).
 */
(function () {
  'use strict';
  var qs = new URLSearchParams(location.search);
  var projectId = qs.get('p');
  var timelineId = qs.get('tl');
  var mode = qs.get('mode') || 'preview';
  // audio=0: la vista previa no hace sonar nada (en el iPhone el sonido lo pone la página, con Web Audio).
  var previewAudio = mode === 'preview' && qs.get('audio') !== '0';
  var capture = qs.get('capture') === '1';
  var marker = capture && qs.get('marker') === '1';
  var MARK_PX = 16; // alto de la franja de marca en píxeles de la pantalla (Capture.MARK)
  // Alto que se ve (captura por GPU): Java hace la vista más alta que la pantalla virtual para que el motor le dé
  // más memoria de mosaicos (se calcula con el tamaño de la vista); la página se acomoda a lo que se ve.
  var viewH = capture ? +qs.get('vh') || 0 : 0;
  // El compositor se sirve desde <origen>/p/<proyecto>/__oa/ (oa:// en la PC, https en Android):
  // la carpeta del proyecto es lo que está antes de __oa/.
  var base = location.href.split('?')[0].replace(/__oa\/[^/]*$/, '');
  var stage = document.getElementById('stage');
  var msgEl = document.getElementById('msg');

  var project = null, timeline = null;
  var layers = new Map();      // clipId -> { el, kind, clip, track, ready: Promise }
  var audios = new Map();      // clipId -> { el, clip, track }
  var playing = false, playRate = 1, lastT = 0;
  var MAX_SCENE_IFRAMES = mode === 'export' ? 3 : 6;
  var lastUse = new Map();

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function url(src) {
    if (/^(https?:|oa:|data:|blob:)/.test(src)) return src;
    return base + src.split('/').map(encodeURIComponent).join('/');
  }
  function isImage(src) { return /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(src); }
  function post(msg, transfer) { if (window.parent !== window) window.parent.postMessage(Object.assign({ source: 'oa-compositor' }, msg), '*', transfer || []); }

  async function loadJSON(path) {
    var r = await fetch(url(path) + '?_=' + Date.now());
    if (!r.ok) throw new Error('No se pudo leer ' + path + ' (' + r.status + ')');
    return r.json();
  }

  async function load() {
    project = await loadJSON('project.json');
    var tls = project.timelines || [];
    var ref = tls.find(function (x) { return x.id === timelineId; }) || tls[0];
    if (!ref) throw new Error('El proyecto no tiene timelines');
    timelineId = ref.id;
    timeline = await loadJSON(ref.file);
    var W = project.width || 1920, H = project.height || 1080;
    stage.style.width = W + 'px';
    stage.style.height = H + 'px';
    stage.style.background = project.background || '#000';
    document.body.style.width = W + 'px';
    document.body.style.height = H + 'px';
    if (capture) fitCapture();
  }

  // Captura: el escenario llena la vista (que Java crea del tamaño exacto del video), así lo que dibuja el
  // motor ya es el fotograma. visualViewport da el ancho con decimales (innerWidth redondea).
  function fitCapture() {
    var W = project.width || 1920, H = project.height || 1080;
    var vv = window.visualViewport;
    var vw = vv ? vv.width : window.innerWidth, vh = viewH || (vv ? vv.height : window.innerHeight);
    var mh = marker ? MARK_PX / (window.devicePixelRatio || 1) : 0;
    document.body.style.width = '100vw';
    document.body.style.height = viewH ? vh + 'px' : '100vh';
    stage.style.transform = 'scale(' + (vw / W) + ',' + ((vh - mh) / H) + ')';
    if (markEl) {
      markEl.style.height = mh + 'px';
      if (viewH) { markEl.style.bottom = 'auto'; markEl.style.top = (vh - mh) + 'px'; }
    }
    if (testEl) testEl.style.height = (vh - mh) + 'px';
  }
  if (capture) {
    msgEl.style.display = 'none';
    window.addEventListener('resize', function () { if (project) fitCapture(); });
  }

  // ── franja de marca y patrón de prueba (captura por GPU) ──────────────────
  var markEl = null, markCells = [], testEl = null;
  if (marker) {
    markEl = document.createElement('div');
    markEl.style.cssText = 'position:fixed;left:0;right:0;bottom:0;display:flex;z-index:2147483647;background:#000';
    for (var mi = 0; mi < 8; mi++) {
      var cell = document.createElement('div');
      cell.style.cssText = 'flex:1;background:#000';
      markEl.appendChild(cell);
      markCells.push(cell);
    }
    document.body.appendChild(markEl);
  }
  /** Celda i = bits 3i (rojo), 3i+1 (verde) y 3i+2 (azul) de n: prendido 255, apagado 0. */
  function setMark(n) {
    for (var i = 0; i < markCells.length; i++) {
      var v = (n >> (3 * i)) & 7;
      markCells[i].style.background = 'rgb(' + (v & 1 ? 255 : 0) + ',' + (v & 2 ? 255 : 0) + ',' + (v & 4 ? 255 : 0) + ')';
    }
  }
  /** 3×2 parches (rojo, verde, azul / blanco, gris, negro) sobre el escenario: Java comprueba que lleguen iguales. */
  function showTest(on) {
    if (on && !testEl) {
      testEl = document.createElement('div');
      testEl.style.cssText = 'position:fixed;left:0;top:0;width:100vw;display:grid;grid-template-columns:repeat(3,1fr);grid-template-rows:repeat(2,1fr);z-index:2147483646';
      ['#ff0000', '#00ff00', '#0000ff', '#ffffff', '#808080', '#000000'].forEach(function (c) {
        var d = document.createElement('div');
        d.style.background = c;
        testEl.appendChild(d);
      });
      document.body.appendChild(testEl);
      if (project) fitCapture();
    }
    if (testEl) testEl.style.display = on ? 'grid' : 'none';
  }

  function visualTracks() {
    return (timeline.tracks || []).filter(function (tr) { return (tr.type === 'scene' || tr.type === 'video') && !tr.hidden; });
  }

  function activeClip(track, t) {
    var clips = track.clips || [];
    for (var i = 0; i < clips.length; i++) {
      var c = clips[i];
      if (t >= c.start - 1e-6 && t < c.start + c.duration - 1e-6) return c;
    }
    return null;
  }

  function clipOpacity(c, t) {
    var o = 1, lt = t - c.start;
    if (c.fadeIn > 0 && lt < c.fadeIn) o = Math.min(o, lt / c.fadeIn);
    if (c.fadeOut > 0 && c.duration - lt < c.fadeOut) o = Math.min(o, (c.duration - lt) / c.fadeOut);
    return Math.max(0, Math.min(1, o));
  }

  function ensureLayer(track, clip, z) {
    var L = layers.get(clip.id);
    if (L && L.src === clip.src) { L.el.style.zIndex = z; L.clip = clip; L.track = track; return L; }
    if (L) destroyLayer(clip.id);
    var el, ready;
    if (track.type === 'scene') {
      el = document.createElement('iframe');
      el.className = 'layer';
      el.setAttribute('scrolling', 'no');
      var loadStart = performance.now();
      ready = new Promise(function (res) {
        el.addEventListener('load', function () {
          var w = el.contentWindow;
          // Esperar a que el runtime exista (se inyecta en <head>) y a las fuentes.
          var tries = 0;
          (function wait() {
            if (w.__oaRuntime || tries++ > 200) {
              var f = w.document && w.document.fonts ? w.document.fonts.ready : Promise.resolve();
              f.then(function () { if (L) L.loadMs = performance.now() - loadStart; setTimeout(res, 50); });
            } else setTimeout(wait, 25);
          })();
        }, { once: true });
      });
      el.src = url(clip.src);
    } else if (isImage(clip.src)) {
      el = document.createElement('img');
      el.className = 'layer';
      ready = new Promise(function (res) { el.onload = res; el.onerror = res; });
      el.src = url(clip.src);
    } else {
      el = document.createElement('video');
      el.className = 'layer';
      el.muted = true; el.preload = 'auto'; el.playsInline = true;
      ready = new Promise(function (res) { el.addEventListener('loadeddata', res, { once: true }); el.addEventListener('error', res, { once: true }); setTimeout(res, 8000); });
      el.src = url(clip.src);
    }
    if (clip.fit) el.style.objectFit = clip.fit;
    el.style.zIndex = z;
    stage.appendChild(el);
    L = { el: el, kind: track.type === 'scene' ? 'scene' : (isImage(clip.src) ? 'image' : 'video'), clip: clip, track: track, src: clip.src, ready: ready };
    layers.set(clip.id, L);
    return L;
  }

  function destroyLayer(id) {
    var L = layers.get(id);
    if (!L) return;
    try { L.el.remove(); } catch (e) {}
    layers.delete(id); lastUse.delete(id);
  }

  function gc(keep) {
    var scenes = [];
    layers.forEach(function (L, id) { if (!keep.has(id)) scenes.push(id); });
    // Mantener algunas capas precargadas; eliminar las menos usadas.
    scenes.sort(function (a, b) { return (lastUse.get(a) || 0) - (lastUse.get(b) || 0); });
    while (layers.size > MAX_SCENE_IFRAMES && scenes.length) destroyLayer(scenes.shift());
  }

  function seekVideo(v, target) {
    return new Promise(function (res) {
      if (v.duration && isFinite(v.duration)) target = Math.min(Math.max(0, target), v.duration - 0.001);
      if (Math.abs(v.currentTime - target) < 0.004 && v.readyState >= 2) return res();
      var done = false;
      function fin() { if (!done) { done = true; v.removeEventListener('seeked', fin); res(); } }
      v.addEventListener('seeked', fin);
      setTimeout(fin, 3000);
      v.currentTime = target;
    });
  }

  var renderSeq = 0;
  /** Alguna capa pasó a verse en el último renderAt (su documento se pinta de cero: ver __oaCap). */
  var newlyShown = false;
  /** Deja el compositor exactamente en t. Devuelve cuando todas las capas están listas. */
  async function renderAt(t, opts) {
    opts = opts || {};
    var seq = ++renderSeq;
    lastT = t;
    var tracks = visualTracks();
    var keep = new Set();
    var jobs = [];
    var now = Date.now();
    tracks.forEach(function (track, idx) {
      var z = 1000 - idx;
      var c = activeClip(track, t);
      if (c) {
        keep.add(c.id);
        var L = ensureLayer(track, c, z);
        lastUse.set(c.id, now);
        var local = (c.in || 0) + (t - c.start);
        jobs.push(L.ready.then(async function () {
          if (seq !== renderSeq && !opts.force) return;
          if (L.el.style.display !== 'block') {
            // Con su tamaño antes de dibujar: oculta (display:none) la escena mide 0×0 y la que calcula su lienzo o
            // su escala con innerWidth dibujaba su primer cuadro en 1×1 (un color liso) o a escala 0 (vacío).
            newlyShown = true;
            L.el.style.visibility = 'hidden';
            L.el.style.display = 'block';
            void L.el.offsetWidth;
          }
          if (L.kind === 'scene') {
            var rt = L.el.contentWindow && L.el.contentWindow.__oaRuntime;
            if (rt) await rt.renderAt(local, { fps: project.fps || 30, skipPaint: true });
            if (rt && capture && rt.gpuSync) rt.gpuSync(); // WebGL pesado: que se muestre antes de pedir el próximo
          } else if (L.kind === 'video') {
            if (playing && mode === 'preview') {
              if (L.el.paused || Math.abs(L.el.currentTime - local) > 0.25) { L.el.currentTime = local; }
              L.el.playbackRate = playRate;
              if (L.el.paused) L.el.play().catch(function () {});
            } else {
              L.el.pause();
              await seekVideo(L.el, local);
            }
          }
          L.el.style.opacity = clipOpacity(c, t);
          L.el.style.visibility = 'visible';
        }));
      }
      // Precarga de la próxima escena de esta pista.
      var next = (track.clips || []).filter(function (x) { return x.start > t && x.start - t < 6; }).sort(function (a, b) { return a.start - b.start; })[0];
      if (next) {
        keep.add(next.id);
        var N = ensureLayer(track, next, z); lastUse.set(next.id, now - 1);
        // En la vista previa, la próxima escena queda maquetada y pintada (invisible): con display:none
        // Chromium la tiene que pintar de cero al activarla y se ve un cuadro vacío en el corte.
        if (mode === 'preview' && N.el.style.display !== 'block') { N.el.style.visibility = 'hidden'; N.el.style.display = 'block'; }
      }
    });
    await Promise.all(jobs);
    if (seq !== renderSeq && !opts.force) return { t: t, stale: true };
    layers.forEach(function (L, id) {
      var visible = false;
      tracks.forEach(function (track) { var c = activeClip(track, t); if (c && c.id === id) visible = true; });
      if (visible) return;
      if (L.kind === 'video') try { L.el.pause(); } catch (e) {}
      if (mode === 'preview' && L.el.style.display === 'block') {
        // Ocultar la capa saliente recién cuando la entrante ya se pintó (evita el parpadeo en los cortes).
        requestAnimationFrame(function () { requestAnimationFrame(function () {
          var still = false;
          visualTracks().forEach(function (track) { var c = activeClip(track, lastT); if (c && c.id === id) still = true; });
          if (!still && layers.get(id) === L) L.el.style.visibility = 'hidden';
        }); });
      } else L.el.style.display = 'none';
    });
    gc(keep);
    if (previewAudio) syncAudio(t);
    if (!opts.skipPaint) await new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r); }); });
    return { t: t };
  }

  // ── audio de la vista previa ──────────────────────────────────────────────
  function soloActive() { return (timeline.tracks || []).some(function (tr) { return tr.type === 'audio' && tr.solo; }); }
  function syncAudio(t) {
    var solo = soloActive();
    var want = new Set();
    (timeline.tracks || []).forEach(function (tr) {
      if (tr.type !== 'audio' && tr.type !== 'video') return;
      var audible = !tr.muted && (!solo || tr.solo);
      (tr.clips || []).forEach(function (c) {
        if (tr.type === 'video' && isImage(c.src)) return;
        if (!audible || c.muted) return;
        var inWin = t >= c.start && t < c.start + c.duration;
        var soon = c.start > t && c.start - t < 3;
        if (!inWin && !soon) return;
        want.add(c.id);
        var A = audios.get(c.id);
        if (!A || A.src !== c.src) {
          if (A) { A.el.pause(); A.el.removeAttribute('src'); }
          var el = new Audio(); el.preload = 'auto'; el.src = url(c.src);
          A = { el: el, src: c.src }; audios.set(c.id, A);
        }
        A.clip = c; A.track = tr;
        var local = (c.in || 0) + (t - c.start);
        var vol = (c.volume == null ? 1 : c.volume) * (tr.volume == null ? 1 : tr.volume);
        var lt = t - c.start;
        if (c.fadeIn > 0 && lt < c.fadeIn) vol *= Math.max(0, lt / c.fadeIn);
        if (c.fadeOut > 0 && c.duration - lt < c.fadeOut) vol *= Math.max(0, (c.duration - lt) / c.fadeOut);
        A.el.volume = Math.max(0, Math.min(1, vol));
        if (playing && inWin) {
          A.el.playbackRate = playRate;
          if (A.el.paused) { A.el.currentTime = local; A.el.play().catch(function () {}); }
          else if (Math.abs(A.el.currentTime - local) > 0.2) A.el.currentTime = local;
        } else {
          if (!A.el.paused) A.el.pause();
          if (inWin && Math.abs(A.el.currentTime - local) > 0.05) A.el.currentTime = local;
        }
      });
    });
    audios.forEach(function (A, id) { if (!want.has(id)) { A.el.pause(); A.el.removeAttribute('src'); audios.delete(id); } });
  }

  // ── herramientas para la IA y el editor ───────────────────────────────────
  async function audit(t) {
    await renderAt(t, { force: true, skipPaint: true });
    var out = [];
    var tracks = visualTracks();
    for (var i = 0; i < tracks.length; i++) {
      var c = activeClip(tracks[i], t);
      if (!c) continue;
      var L = layers.get(c.id);
      if (!L || L.kind !== 'scene') continue;
      var rt = L.el.contentWindow && L.el.contentWindow.__oaRuntime;
      if (!rt) continue;
      var local = (c.in || 0) + (t - c.start);
      var r = await rt.audit(local);
      r.issues.forEach(function (is) { is.clip = c.src; is.t = +t.toFixed(2); });
      out = out.concat(r.issues);
    }
    return out;
  }

  async function probeScene(src) {
    var el = document.createElement('iframe');
    el.className = 'layer';
    el.style.display = 'block'; el.style.visibility = 'hidden';
    stage.appendChild(el);
    var dur = 0, modeName = 'clock';
    try {
      await new Promise(function (res) { el.addEventListener('load', res, { once: true }); el.src = url(src); setTimeout(res, 15000); });
      for (var i = 0; i < 80; i++) {
        var rt = el.contentWindow && el.contentWindow.__oaRuntime;
        if (rt) { dur = rt.getDuration(); modeName = rt.mode(); if (dur) break; }
        await sleep(50);
      }
    } finally { el.remove(); }
    return { duration: dur, mode: modeName };
  }

  // ── fotogramas como imagen (Android: sin capturePage, se rasteriza el DOM) ──
  // Cada capa visible se dibuja en un canvas en orden: las escenas HTML con modern-screenshot
  // (DOM → SVG → imagen, el mismo motor de Chromium), las imágenes y videos directo.
  var vendor = null;
  function loadVendor() {
    if (!vendor) vendor = new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = 'vendor/modern-screenshot.js';
      s.onload = function () { res(window.modernScreenshot); };
      s.onerror = function () { rej(new Error('No se pudo cargar el rasterizador')); };
      document.head.appendChild(s);
    });
    return vendor;
  }
  var shotCtx = new Map(); // iframe → contexto reutilizable (fuentes e imágenes ya embebidas)
  /**
   * Safari (el iPhone) decodifica en segundo plano las imágenes que van dentro del SVG del rasterizador: el primer
   * dibujo puede salir sin ellas. modern-screenshot lo arregla redibujando una vez por imagen con ~100 ms de espera
   * cada vez (6 imágenes: ~660 ms por fotograma en WebKit; 30 s de video, 10 minutos). Acá, el primer fotograma de
   * cada escena espera más (hasta 4 × 60 ms: las imágenes se decodifican ahí y quedan en la caché) y los siguientes
   * redibujan una sola vez (~30 ms). Sin imágenes no se redibuja.
   */
  var SAFARI = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
  function capRedraws(ctx) {
    var n = 0;
    ctx.__redraws = 4; ctx.drawImageInterval = 60;
    Object.defineProperty(ctx, 'drawImageCount', { get: function () { return Math.min(n, ctx.__redraws); }, set: function (v) { n = v; }, configurable: true });
  }

  function fitRect(fit, sw, sh, W, H) {
    if (!sw || !sh || fit === 'fill') return [0, 0, W, H];
    var s = fit === 'cover' ? Math.max(W / sw, H / sh) : Math.min(W / sw, H / sh);
    var w = sw * s, h = sh * s;
    return [(W - w) / 2, (H - h) / 2, w, h];
  }

  /** Renderiza t y devuelve un canvas de width×height con todas las capas visibles. */
  async function rasterAt(t, width, height, cost) {
    var t0 = performance.now();
    await renderAt(t, { force: true, skipPaint: true });
    if (cost) cost.seekMs = performance.now() - t0;
    var ms = await loadVendor();
    var PW = project.width || 1920, PH = project.height || 1080;
    var W = Math.round(width || PW), H = Math.round(height || Math.round(W * PH / PW));
    var cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    var g = cv.getContext('2d');
    g.fillStyle = project.background || '#000'; g.fillRect(0, 0, W, H);
    var list = [];
    layers.forEach(function (L) { if (L.el.style.display === 'block' && L.el.style.visibility !== 'hidden') list.push(L); });
    list.sort(function (a, b) { return (+a.el.style.zIndex || 0) - (+b.el.style.zIndex || 0); });
    for (var i = 0; i < list.length; i++) {
      var L = list[i];
      var alpha = parseFloat(L.el.style.opacity); if (!isFinite(alpha)) alpha = 1;
      if (alpha <= 0.001) continue;
      g.globalAlpha = alpha;
      if (L.kind === 'scene') {
        var doc = L.el.contentDocument;
        if (!doc || !doc.documentElement) continue;
        var ctx = shotCtx.get(L.el);
        if (!ctx || ctx.__w !== W) {
          if (ctx) try { ms.destroyContext(ctx); } catch (e) {}
          ctx = await ms.createContext(doc.documentElement, { width: PW, height: PH, scale: W / PW, backgroundColor: null, timeout: 15000,
            // Chromium no necesita los arreglos de Safari/Firefox (redibujar con demoras); Safari sí (ver capRedraws).
            features: { fixSvgXmlDecode: SAFARI, copyScrollbar: false, restoreScrollPosition: false } });
          if (SAFARI) capRedraws(ctx);
          ctx.__w = W; shotCtx.set(L.el, ctx);
        }
        var img = await ms.domToCanvas(ctx);
        if (SAFARI && ctx.__redraws > 1) { ctx.__redraws = 1; ctx.drawImageInterval = 16; }
        g.drawImage(img, 0, 0, W, H);
      } else {
        var el = L.el, sw = L.kind === 'video' ? el.videoWidth : el.naturalWidth, sh = L.kind === 'video' ? el.videoHeight : el.naturalHeight;
        var r = fitRect(el.style.objectFit || 'contain', sw, sh, W, H);
        try { g.drawImage(el, r[0], r[1], r[2], r[3]); } catch (e) { /* aún sin datos */ }
      }
      g.globalAlpha = 1;
    }
    // Contextos de escenas que ya no existen.
    shotCtx.forEach(function (c, el) { if (!el.isConnected) { try { ms.destroyContext(c); } catch (e) {} shotCtx.delete(el); } });
    return cv;
  }

  // ── costo de la escena (Android: va con los fotogramas que mira Claude) ────
  // La vista previa corre en el mismo motor (y el mismo hilo) que la interfaz: lo que tarda la escena en
  // pasar al fotograma siguiente (su JS, más recalcular estilos y maquetar) traba toda la app, y lo que
  // tiene de caro al pintar o en memoria (desenfoques, capas, imágenes enormes) la hace parpadear o cerrarse.
  /** Las escenas HTML visibles en t, con su runtime y su tiempo interno. */
  function scenesAt(t) {
    var out = [];
    visualTracks().forEach(function (tr) {
      var c = activeClip(tr, t), L = c && layers.get(c.id);
      if (!L || L.kind !== 'scene') return;
      try {
        var w = L.el.contentWindow, doc = L.el.contentDocument;
        if (w && w.__oaRuntime && doc && doc.documentElement) out.push({ rt: w.__oaRuntime, doc: doc, src: L.src, loadMs: L.loadMs || 0, local: (c.in || 0) + (t - c.start) });
      } catch (e) { /* otro origen */ }
    });
    return out;
  }
  /** Recalcula estilos y maqueta lo que cambió (leer una medida lo obliga); devuelve cuánto tardó. */
  function flushLayout(scenes) {
    var s = performance.now();
    scenes.forEach(function (d) { try { void d.doc.documentElement.offsetHeight; } catch (e) {} });
    return performance.now() - s;
  }
  /** El desenfoque más grande de un box-shadow calculado ("rgba(…) 0px 10px 40px 0px, …"). */
  function maxShadowBlur(v) {
    var m = 0;
    v.split(/,(?![^(]*\))/).forEach(function (one) { var px = one.match(/-?[\d.]+px/g); if (px && px.length >= 3) m = Math.max(m, parseFloat(px[2])); });
    return m;
  }
  /** Cuenta lo visible de una escena que cuesta al pintar o en memoria. */
  function weigh(doc, w) {
    var win = doc.defaultView;
    if (!win) return;
    var all = doc.getElementsByTagName('*');
    var area = (win.innerWidth || 1920) * (win.innerHeight || 1080);
    var n = Math.min(all.length, 20000);
    w.elements += all.length;
    for (var i = 0; i < n; i++) {
      var el = all[i];
      if (el.checkVisibility && !el.checkVisibility()) continue;
      var cs = win.getComputedStyle(el), tag = el.localName;
      var f = cs.filter;
      if (f && f !== 'none') {
        if (f.indexOf('url(') >= 0) w.svgFilters++; else w.filters++;
        var b = /blur\(([\d.]+)px\)/.exec(f);
        if (b && +b[1] >= 8) { var r = el.getBoundingClientRect(); if (r.width * r.height > area * 0.1) w.bigBlurs++; }
      }
      var bf = cs.backdropFilter || cs.webkitBackdropFilter;
      if (bf && bf !== 'none') w.backdrops++;
      if (cs.mixBlendMode && cs.mixBlendMode !== 'normal') w.blends++;
      if (cs.boxShadow && cs.boxShadow !== 'none' && maxShadowBlur(cs.boxShadow) >= 24) w.shadows++;
      if ((cs.willChange && cs.willChange !== 'auto') || cs.transform.indexOf('matrix3d') === 0) w.layers++;
      if (tag === 'canvas') w.canvasPx += (el.width || 0) * (el.height || 0);
      else if (tag === 'img') w.imagePx += (el.naturalWidth || 0) * (el.naturalHeight || 0);
      else if (tag === 'video') w.videos++;
    }
    w.turbulence += doc.getElementsByTagName('feTurbulence').length;
    w.babel += doc.querySelectorAll('script[type="text/babel"], script[type="text/jsx"]').length;
    try { w.animations += doc.getAnimations().length; } catch (e) { /* sin Web Animations */ }
  }
  /**
   * Después de un fotograma en t: lo que tarda el hilo principal en pasar al siguiente (3 pasos de un
   * fotograma de cada escena visible, el del medio; uno solo si ya es muy lento) y el peso de lo que se ve.
   * Sólo las escenas: los videos del timeline se reproducen solos en la vista previa.
   */
  async function measureCost(t, cost) {
    var fps = (project && project.fps) || 30;
    var scenes = scenesAt(t);
    flushLayout(scenes);
    if (scenes.length) {
      var steps = [];
      for (var i = 1; i <= 3; i++) {
        var s = performance.now();
        for (var k = 0; k < scenes.length; k++) await scenes[k].rt.renderAt(scenes[k].local + i / fps, { fps: fps, skipPaint: true });
        var one = { js: performance.now() - s, layout: flushLayout(scenes), gpu: -1 };
        // Lo que tarda la GPU en el WebGL de ese paso (la página lo encarga en el JS y sigue sin esperarlo).
        for (k = 0; k < scenes.length; k++) if (scenes[k].rt.gpuWait) one.gpu = Math.max(one.gpu, scenes[k].rt.gpuWait());
        steps.push(one);
        if (one.js + one.layout > 150) break;
      }
      var gpus = steps.map(function (x) { return x.gpu; }).sort(function (a, b) { return a - b; });
      if (gpus[0] >= 0) cost.stepGpuMs = gpus[Math.floor(gpus.length / 2)];
      steps.sort(function (a, b) { return (a.js + a.layout) - (b.js + b.layout); });
      var mid = steps[Math.floor(steps.length / 2)];
      cost.stepJsMs = mid.js; cost.stepLayoutMs = mid.layout;
    }
    var w = { elements: 0, filters: 0, bigBlurs: 0, svgFilters: 0, backdrops: 0, blends: 0, shadows: 0, layers: 0, turbulence: 0, babel: 0, canvasPx: 0, imagePx: 0, videos: 0, animations: 0 };
    var s2 = performance.now();
    scenes.forEach(function (d) { weigh(d.doc, w); });
    w.ms = performance.now() - s2;
    cost.weight = w;
    cost.scenes = scenes.map(function (d) { return d.src; });
    cost.loadMs = scenes.reduce(function (m, d) { return Math.max(m, d.loadMs); }, 0);
    cost.fps = fps;
  }

  // toDataURL y no toBlob: en el WebView de la tablet toBlob espera un momento libre del hilo que no llega (4 s siempre).
  function canvasData(cv, mime, quality) {
    var url = cv.toDataURL(mime, quality);
    return Promise.resolve(url.slice(url.indexOf(',') + 1));
  }

  function setMsg(s) { msgEl.textContent = s || ''; }

  async function reload() {
    layers.forEach(function (L, id) { destroyLayer(id); });
    audios.forEach(function (A) { A.el.pause(); });
    audios.clear();
    await load();
    await renderAt(lastT, { force: true });
  }

  window.__oaCompositor = {
    ready: null,
    renderAt: renderAt,
    audit: audit,
    probeScene: probeScene,
    reload: reload,
    getTimeline: function () { return timeline; },
    getProject: function () { return project; },
    duration: function () { return timeline ? timeline.duration : 0; }
  };

  window.addEventListener('message', async function (e) {
    var m = e.data || {};
    if (m.target !== 'oa-compositor') return;
    try {
      if (m.type === 'seek') {
        playing = !!m.playing; playRate = m.rate || 1;
        var r = await renderAt(m.t, { skipPaint: true });
        if (!r.stale) post({ type: 'rendered', t: m.t });
      } else if (m.type === 'pause') {
        playing = false;
        layers.forEach(function (L) { if (L.kind === 'video') L.el.pause(); });
        if (previewAudio) syncAudio(m.t == null ? lastT : m.t);
      } else if (m.type === 'reload') {
        await reload(); post({ type: 'reloaded' });
      } else if (m.type === 'audit') {
        post({ type: 'audit', id: m.id, issues: await audit(m.t) });
      } else if (m.type === 'probe') {
        post({ type: 'probe', id: m.id, result: await probeScene(m.src) });
      } else if (m.type === 'frame') {
        // Un fotograma como imagen (base64). format: jpeg | png | bitmap (el iPhone: una ImageBitmap que va directo al
        // codificador, sin pasar por JPEG). cost: medir lo que le cuesta a la escena.
        var cost = m.cost ? {} : null, f0 = performance.now();
        var cv = await rasterAt(m.t, m.width, m.height, cost);
        if (m.format === 'bitmap') {
          var bmp = await createImageBitmap(cv);
          post({ type: 'frame', id: m.id, t: m.t, bitmap: bmp, width: cv.width, height: cv.height }, [bmp]);
        } else {
          var mime = m.format === 'png' ? 'image/png' : 'image/jpeg';
          var data = await canvasData(cv, mime, m.quality || 0.92);
          if (cost) { cost.frameMs = performance.now() - f0; await measureCost(m.t, cost); }
          post({ type: 'frame', id: m.id, t: m.t, mime: mime, data: data, width: cv.width, height: cv.height, cost: cost });
        }
      }
    } catch (err) {
      post({ type: 'error', id: m.id, message: String(err && err.message || err) });
    }
  });

  window.__oaCompositor.ready = load().then(async function () {
    await renderAt(0, { force: true, skipPaint: true });
    post({ type: 'ready', duration: timeline.duration, width: project.width, height: project.height });
    if (capture) window.__oaCapReady = true;
    return true;
  }).catch(function (err) {
    setMsg(String(err.message || err));
    post({ type: 'error', message: String(err.message || err) });
    if (capture) window.__oaCapReady = 'error: ' + (err.message || err);
    throw err;
  });

  // Pedidos de captura, de a uno y en orden (con la GPU, Java pide los próximos antes de que termine
  // éste). Sin esperar a que pinte: Java espera con postVisualStateCallback, que asegura que el próximo
  // dibujo ya tiene este estado, o mira la franja de marca en la imagen.
  var capChain = Promise.resolve();
  // Cuánto tarda la página en dejar listo cada fotograma (para los detalles de la exportación).
  var capStats = window.__oaCapStats = { n: 0, ms: 0, max: 0 };
  // Línea de tiempo de cada pedido, en ms de reloj (con decimales, comparable con el de Java): cuándo llegó,
  // cuándo lo empezó la página, cuándo quedó listo, cuándo se entregó para dibujar y el rAF de ese cuadro.
  var capLog = window.__oaCapLog = { rows: [] };
  function clock() { return performance.timeOrigin + performance.now(); }
  function capStep(work, n, measure, got) {
    var row = null;
    capChain = capChain.then(function () {
      // Mientras cambia, la franja dice 0: ninguna imagen a medio cambiar lleva el número de otro fotograma.
      setMark(0);
      var t = performance.now(), start = clock();
      return Promise.resolve(work()).then(function () {
        if (!measure) return;
        var d = performance.now() - t;
        capStats.n++; capStats.ms += d; if (d > capStats.max) capStats.max = d;
        row = [n, got || start, start, clock()];
      });
    }).then(function () {
      setMark(n);
      window.__oaCapDone = n;
      // El próximo pedido recién cuando este estado ya se entregó para dibujar (si no, se pisarían).
      if (marker) return afterCommit().then(function (raf) { if (row) { row.push(clock(), raf); capLog.rows.push(row); } });
      if (row) capLog.rows.push(row);
    }, function (err) {
      // __oaCapError queda: con pedidos por adelantado, __oaCapDone lo pisaría el siguiente que salga bien.
      window.__oaCapDone = window.__oaCapError = 'error: ' + (err && err.message || err);
    });
    return capChain;
  }
  /**
   * Después de que el cuadro con el estado actual pasó al compositor (rAF + una tarea: ya se pintó).
   * Devuelve la hora de ese cuadro (la del rAF, en ms de reloj).
   */
  function afterCommit() {
    return new Promise(function (resolve) {
      requestAnimationFrame(function (ts) {
        var ch = new MessageChannel();
        ch.port1.onmessage = function () { resolve(performance.timeOrigin + ts); };
        ch.port2.postMessage(0);
      });
    });
  }
  if (capture) {
    window.__oaCap = function (t, n) {
      var got = clock();
      return capStep(function () {
        showTest(false);
        newlyShown = false;
        return renderAt(t, { force: true, skipPaint: true }).then(function () {
          // Una escena que recién se muestra no sale en su primer cuadro (el motor pinta su documento de cero: salía
          // vacía, gris o blanca): con la franja en 0 se esperan dos cuadros. En la exportación pasa sólo al empezar
          // cada escena; en los fotogramas para Claude, en cada salto a otra escena.
          if (newlyShown) return afterCommit().then(afterCommit);
        });
      }, n, true, got);
    };
    window.__oaCapTest = function (n) { return capStep(function () { showTest(true); }, n); };
    // Lo que le cuesta a la escena el fotograma en t (para Claude: Snap.java lo pide después de tomar la imagen). La
    // medición mueve la escena unos cuadros: la franja queda en 0, así ninguna imagen de esos pasos pasa por un pedido.
    window.__oaCapCost = function (t) {
      window.__oaCapCostResult = '';
      capChain = capChain.then(function () {
        setMark(0);
        var c = {};
        return measureCost(t, c).then(function () { window.__oaCapCostResult = JSON.stringify(c); });
      }).catch(function (err) { window.__oaCapCostResult = JSON.stringify({ error: String(err && err.message || err) }); });
    };
  }
})();
