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
  var capture = qs.get('capture') === '1';
  var marker = capture && qs.get('marker') === '1';
  var MARK_PX = 16; // alto de la franja de marca en píxeles de la pantalla (Capture.MARK)
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
  function post(msg) { if (window.parent !== window) window.parent.postMessage(Object.assign({ source: 'oa-compositor' }, msg), '*'); }

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
    var vw = vv ? vv.width : window.innerWidth, vh = vv ? vv.height : window.innerHeight;
    var mh = marker ? MARK_PX / (window.devicePixelRatio || 1) : 0;
    document.body.style.width = '100vw';
    document.body.style.height = '100vh';
    stage.style.transform = 'scale(' + (vw / W) + ',' + ((vh - mh) / H) + ')';
    if (markEl) markEl.style.height = mh + 'px';
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
      ready = new Promise(function (res) {
        el.addEventListener('load', function () {
          var w = el.contentWindow;
          // Esperar a que el runtime exista (se inyecta en <head>) y a las fuentes.
          var tries = 0;
          (function wait() {
            if (w.__oaRuntime || tries++ > 200) {
              var f = w.document && w.document.fonts ? w.document.fonts.ready : Promise.resolve();
              f.then(function () { setTimeout(res, 50); });
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
          if (L.kind === 'scene') {
            var rt = L.el.contentWindow && L.el.contentWindow.__oaRuntime;
            if (rt) await rt.renderAt(local, { fps: project.fps || 30, skipPaint: true });
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
          L.el.style.display = 'block';
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
    if (mode === 'preview') syncAudio(t);
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

  function fitRect(fit, sw, sh, W, H) {
    if (!sw || !sh || fit === 'fill') return [0, 0, W, H];
    var s = fit === 'cover' ? Math.max(W / sw, H / sh) : Math.min(W / sw, H / sh);
    var w = sw * s, h = sh * s;
    return [(W - w) / 2, (H - h) / 2, w, h];
  }

  /** Renderiza t y devuelve un canvas de width×height con todas las capas visibles. */
  async function rasterAt(t, width, height) {
    await renderAt(t, { force: true, skipPaint: true });
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
            // Chromium no necesita los arreglos de Safari/Firefox (redibujar con demoras).
            features: { fixSvgXmlDecode: false, copyScrollbar: false, restoreScrollPosition: false } });
          ctx.__w = W; shotCtx.set(L.el, ctx);
        }
        var img = await ms.domToCanvas(ctx);
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

  function canvasData(cv, mime, quality) {
    return new Promise(function (res, rej) {
      cv.toBlob(function (b) {
        if (!b) return rej(new Error('No se pudo codificar el fotograma'));
        var fr = new FileReader();
        fr.onload = function () { var s = String(fr.result); res(s.slice(s.indexOf(',') + 1)); };
        fr.onerror = function () { rej(fr.error); };
        fr.readAsDataURL(b);
      }, mime, quality);
    });
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
        syncAudio(m.t == null ? lastT : m.t);
      } else if (m.type === 'reload') {
        await reload(); post({ type: 'reloaded' });
      } else if (m.type === 'audit') {
        post({ type: 'audit', id: m.id, issues: await audit(m.t) });
      } else if (m.type === 'probe') {
        post({ type: 'probe', id: m.id, result: await probeScene(m.src) });
      } else if (m.type === 'frame') {
        // Un fotograma como imagen (base64). format: jpeg | png.
        var cv = await rasterAt(m.t, m.width, m.height);
        var mime = m.format === 'png' ? 'image/png' : 'image/jpeg';
        post({ type: 'frame', id: m.id, t: m.t, mime: mime, data: await canvasData(cv, mime, m.quality || 0.92), width: cv.width, height: cv.height });
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
  function capStep(work, n) {
    capChain = capChain.then(function () {
      // Mientras cambia, la franja dice 0: ninguna imagen a medio cambiar lleva el número de otro fotograma.
      setMark(0);
      return work();
    }).then(function () {
      setMark(n);
      window.__oaCapDone = n;
      // El próximo pedido recién cuando este estado ya se entregó para dibujar (si no, se pisarían).
      if (marker) return afterCommit();
    }, function (err) {
      // __oaCapError queda: con pedidos por adelantado, __oaCapDone lo pisaría el siguiente que salga bien.
      window.__oaCapDone = window.__oaCapError = 'error: ' + (err && err.message || err);
    });
    return capChain;
  }
  /** Después de que el cuadro con el estado actual pasó al compositor (rAF + una tarea: ya se pintó). */
  function afterCommit() {
    return new Promise(function (resolve) {
      requestAnimationFrame(function () {
        var ch = new MessageChannel();
        ch.port1.onmessage = function () { resolve(); };
        ch.port2.postMessage(0);
      });
    });
  }
  if (capture) {
    window.__oaCap = function (t, n) {
      return capStep(function () { showTest(false); return renderAt(t, { force: true, skipPaint: true }); }, n);
    };
    window.__oaCapTest = function (n) { return capStep(function () { showTest(true); }, n); };
  }
})();
