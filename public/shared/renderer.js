// Moteur de rendu "sans coupure" : chaque contenu est préparé dans un calque
// invisible, et n'est affiché (fondu ou cut) qu'une fois entièrement prêt.
// L'ancien calque reste à l'écran jusque-là : jamais d'écran noir intempestif.
import { esc } from './client.js';

// ---------------------------------------------------------------- PDF
let pdfjs;
async function loadPdfjs() {
  if (!pdfjs) {
    pdfjs = import('/vendor/pdfjs/pdf.min.mjs').then((m) => {
      m.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
      return m;
    });
  }
  return pdfjs;
}
const docs = new Map();
function pdfDoc(url) {
  if (!docs.has(url)) docs.set(url, loadPdfjs().then((p) => p.getDocument({ url, isEvalSupported: false }).promise));
  return docs.get(url);
}
const pageCache = new Map(); // clé -> Promise<canvas>, LRU
function pageCanvas(url, n, w, h) {
  const key = `${url}#${n}@${w}x${h}`;
  if (pageCache.has(key)) {
    const v = pageCache.get(key);
    pageCache.delete(key); pageCache.set(key, v); // rafraîchit la position LRU
    return v;
  }
  const p = pdfDoc(url).then(async (doc) => {
    const page = await doc.getPage(Math.min(n, doc.numPages));
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(w / base.width, h / base.height);
    const vp = page.getViewport({ scale });
    const c = document.createElement('canvas');
    c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    return c;
  });
  pageCache.set(key, p);
  p.catch(() => pageCache.delete(key));
  while (pageCache.size > 24) pageCache.delete(pageCache.keys().next().value);
  return p;
}
export async function pdfThumb(url, n, w, h) {
  const src = await pageCanvas(url, n, w, h);
  const c = document.createElement('canvas');
  c.width = src.width; c.height = src.height;
  c.getContext('2d').drawImage(src, 0, 0);
  return c;
}

// ---------------------------------------------------------------- caméras / cartes d'acquisition
const streams = new Map();
async function cameraStream(cue) {
  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  const cams = devices.filter((d) => d.kind === 'videoinput');
  // L'identifiant change d'une machine à l'autre : on retombe sur le nom du périphérique.
  const dev = cams.find((d) => d.deviceId === cue.deviceId) || cams.find((d) => d.label && d.label === cue.deviceLabel);
  const key = (dev?.deviceId || 'default') + (cue.withAudio ? '+a' : '');
  if (!streams.has(key)) {
    const p = navigator.mediaDevices.getUserMedia({
      video: { deviceId: dev ? { exact: dev.deviceId } : undefined, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 50 } },
      audio: cue.withAudio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false,
    });
    streams.set(key, p);
    p.catch(() => streams.delete(key));
  }
  return streams.get(key);
}

// ---------------------------------------------------------------- lien de participation
let infoPromise;
export function joinUrl(state) {
  if (state?.settings?.publicUrl) return Promise.resolve(state.settings.publicUrl.replace(/\/$/, '') + '/vote/');
  infoPromise ||= fetch('/api/info').then((r) => r.json()).catch(() => ({ lan: [] }));
  return infoPromise.then((i) => {
    const local = /^(localhost|127\.)/.test(location.hostname);
    return ((local && i.lan?.[0]) || location.origin) + '/vote/';
  });
}

// ---------------------------------------------------------------- description d'un contenu
export function describe(state, pos, { blackout = false, logo = false, depth = 0 } = {}) {
  if (!state) return { key: 'none', type: 'black' };
  if (blackout) return { key: 'black', type: 'black' };
  const logoMedia = state.media.find((m) => m.id === state.settings.logoMediaId);
  if (logo || !pos) {
    return logoMedia ? { key: 'logo:' + logoMedia.id, type: 'image', src: '/media/' + logoMedia.file } : { key: 'black', type: 'black' };
  }
  const cue = state.cues.find((c) => c.id === pos.cueId);
  if (!cue) return { key: 'black', type: 'black' };
  const media = cue.mediaId ? state.media.find((m) => m.id === cue.mediaId) : null;
  const base = { cue, media, type: cue.type };
  switch (cue.type) {
    case 'slides':
      if (!media || media.status !== 'ready') return { ...base, key: 'wait:' + cue.id, type: 'placeholder', label: media?.status === 'error' ? 'Erreur : ' + media.error : 'Conversion en cours…' };
      return { ...base, key: `${cue.id}:${pos.slide}:${media.file}`, src: '/media/' + media.file, slide: pos.slide, pages: media.pages };
    case 'video':
    case 'audio':
      if (!media) return { ...base, key: 'wait:' + cue.id, type: 'placeholder', label: 'Média manquant' };
      return { ...base, key: `${cue.id}:${media.file}`, src: '/media/' + media.file };
    case 'image':
      if (!media) return { ...base, key: 'wait:' + cue.id, type: 'placeholder', label: 'Média manquant' };
      return { ...base, key: `${cue.id}:${media.file}`, src: '/media/' + media.file };
    case 'web':
      return { ...base, key: `${cue.id}:${cue.url}` };
    case 'camera':
      return { ...base, key: `${cue.id}:${cue.deviceId}:${cue.deviceLabel}:${cue.withAudio}` };
    case 'ndi':
      return { ...base, key: `${cue.id}:${cue.source?.name}:${cue.source?.urlAddress}` };
    case 'scene':
      if (depth > 0) return { ...base, key: 'nested:' + cue.id, type: 'placeholder', label: 'Scène imbriquée non autorisée' };
      return { ...base, key: 'scene:' + cue.id, slide: pos.slide };
    default:
      return { ...base, key: cue.id + ':' + (cue.bgMediaId || '') };
  }
}

export function notesFor(state, pos) {
  if (!state || !pos) return '';
  const cue = state.cues.find((c) => c.id === pos.cueId);
  if (!cue) return '';
  if (cue.type === 'scene') {
    const main = mainLayerOf(cue, state.cues);
    const inner = main ? notesFor(state, { cueId: main.cueId, slide: pos.slide }) : '';
    return [cue.notes, inner].filter(Boolean).join('\n\n');
  }
  const media = cue.mediaId ? state.media.find((m) => m.id === cue.mediaId) : null;
  const slideNotes = cue.type === 'slides' ? media?.notes?.[pos.slide - 1] || '' : '';
  return [cue.notes, slideNotes].filter(Boolean).join('\n\n');
}

// ---------------------------------------------------------------- Stage
export class Stage {
  /**
   * @param {HTMLElement} root
   * @param {object} opts
   *  - client: Client (horloge + actions)
   *  - audio: la sortie joue le son
   *  - monitor: vignette de régie (pas d'iframe, pas de son)
   *  - reportEnded: signale la fin des vidéos (enchaînement auto)
   */
  constructor(root, opts = {}) {
    this.root = root;
    this.opts = opts;
    root.classList.add('stage');
    if (opts.transparent) root.classList.add('transparent');
    this.layers = document.createElement('div');
    this.layers.className = 'stage-layers';
    this.overlayEl = document.createElement('div');
    this.overlayEl.className = 'stage-overlay';
    root.append(this.layers, this.overlayEl);
    this.current = null;
    this.pending = null;
    this.state = null;
    let rt;
    new ResizeObserver(() => {
      clearTimeout(rt);
      rt = setTimeout(() => { if (this.current && this.current.desc.type === 'slides') { this.current.key = 'stale'; this.update(this.state, this.lastDesc); } }, 200);
    }).observe(root);
  }

  size() {
    const r = this.root.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    return { w: Math.max(64, Math.round(r.width * dpr)), h: Math.max(36, Math.round(r.height * dpr)) };
  }

  // Promesse résolue quand le contenu demandé est à l'écran (utilisée par les scènes).
  whenReady() { return this.pending ? this.pending.ready : Promise.resolve(); }

  update(state, desc, overlay = null, overlayScenes = null) {
    this.state = state;
    this.lastDesc = desc;
    this.renderOverlay(overlay);
    this.renderOverlayScenes(state, overlayScenes || []);
    if (this.current && this.current.key === desc.key) return this.current.update(desc, state);
    if (this.pending && this.pending.key === desc.key) return this.pending.update(desc, state);
    if (this.pending) this.pending.destroy();
    const layer = new Layer(this, desc);
    this.pending = layer;
    layer.update(desc, state);
    const fallback = setTimeout(() => this.reveal(layer), desc.type === 'web' ? 6000 : 4000);
    layer.ready.then(() => { clearTimeout(fallback); this.reveal(layer); });
  }

  reveal(layer) {
    if (this.pending !== layer) return;
    this.pending = null;
    const old = this.current;
    this.current = layer;
    const s = this.state?.settings || {};
    // Fondu entre éléments du conducteur, cut entre diapositives (comme PowerPoint).
    const sameCue = old && old.desc.cue && layer.desc.cue && old.desc.cue.id === layer.desc.cue.id;
    const ms = s.transition === 'cut' || sameCue ? 0 : s.transitionMs ?? 400;
    layer.el.style.transition = ms ? `opacity ${ms}ms ease` : 'none';
    layer.el.getBoundingClientRect();
    layer.el.style.opacity = 1;
    layer.activate();
    if (old) setTimeout(() => old.destroy(), ms + 50);
  }

  // Préchauffe un contenu à venir (diapo suivante) pour un affichage instantané.
  preload(desc) {
    if (desc?.type === 'slides') { const { w, h } = this.size(); pageCanvas(desc.src, desc.slide, w, h).catch(() => {}); }
  }

  // Scènes d'habillage (logo, bandeau, cadre…) superposées au programme.
  renderOverlayScenes(state, ids) {
    this.ovScenes ||= new Map();
    ids = ids.filter((id) => id !== this.lastDesc?.cue?.id); // jamais la scène déjà à l'antenne
    for (const [id, o] of this.ovScenes) if (!ids.includes(id)) { o.stage.destroy(); o.el.remove(); this.ovScenes.delete(id); }
    ids.forEach((id, i) => {
      let o = this.ovScenes.get(id);
      if (!o) {
        const el = document.createElement('div');
        el.className = 'stage-ovscene';
        this.overlayEl.before(el);
        o = { el, stage: new Stage(el, { ...this.opts, transparent: true, reportEnded: false }) };
        this.ovScenes.set(id, o);
      }
      o.el.style.zIndex = 2 + i;
      o.stage.update(state, describe(state, { cueId: id, slide: 1 }));
    });
  }

  destroy() {
    this.pending?.destroy();
    this.current?.destroy();
    for (const o of this.ovScenes?.values() || []) o.stage.destroy();
    this.destroyed = true;
  }

  renderOverlay(o) {
    const html = o ? `<div class="lower-third"><div class="lt-text">${esc(o.text)}</div>${o.sub ? `<div class="lt-sub">${esc(o.sub)}</div>` : ''}</div>` : '';
    if (this.overlayEl.dataset.html !== html) { this.overlayEl.dataset.html = html; this.overlayEl.innerHTML = html; }
  }
}

class Layer {
  constructor(stage, desc) {
    this.stage = stage;
    this.desc = desc;
    this.key = desc.key;
    this.el = document.createElement('div');
    this.el.className = 'layer layer-' + desc.type;
    this.el.style.opacity = 0;
    stage.layers.append(this.el);
    this.timers = [];
    this.ready = this.build(desc).catch((e) => {
      console.warn('Rendu impossible', desc, e);
      this.el.innerHTML = `<div class="placeholder">${esc(e.message || 'Erreur de rendu')}</div>`;
    });
  }

  async build(d) {
    const { monitor } = this.stage.opts;
    const el = this.el;
    switch (d.type) {
      case 'black': return;
      case 'placeholder':
        el.innerHTML = `<div class="placeholder">${esc(d.label)}</div>`;
        return;
      case 'image': {
        const img = new Image();
        img.src = d.src;
        img.className = 'fit';
        await img.decode().catch(() => {});
        el.append(img);
        return;
      }
      case 'slides': {
        const { w, h } = this.stage.size();
        const src = await pageCanvas(d.src, d.slide, w, h);
        const c = document.createElement('canvas');
        c.width = src.width; c.height = src.height;
        c.className = 'fit';
        c.getContext('2d').drawImage(src, 0, 0);
        el.append(c);
        // Préchargement des diapositives voisines.
        if (!monitor) for (const n of [d.slide + 1, d.slide + 2, d.slide - 1]) if (n >= 1 && n <= d.pages) pageCanvas(d.src, n, w, h).catch(() => {});
        return;
      }
      case 'video':
      case 'audio': {
        const v = (this.video = document.createElement('video'));
        v.className = 'fit';
        v.src = d.src;
        v.preload = 'auto';
        v.playsInline = true;
        v.muted = monitor || !this.stage.opts.audio;
        v.loop = !!d.cue.loop;
        v.volume = d.cue.volume ?? 1;
        if (d.type === 'audio') { el.innerHTML = `<div class="audio-badge">♪ ${esc(d.cue.name)}</div>`; v.style.display = 'none'; }
        el.append(v);
        v.addEventListener('ended', () => {
          if (this.stage.opts.reportEnded && !v.loop) this.stage.opts.client?.send({ type: 'video.ended', cueId: d.cue.id, duration: v.duration });
        });
        await new Promise((res, rej) => {
          if (v.readyState >= 3) return res();
          v.addEventListener('canplay', res, { once: true });
          v.addEventListener('error', () => rej(new Error('Vidéo illisible (format/codec)')), { once: true });
        });
        return;
      }
      case 'web': {
        if (monitor) {
          el.innerHTML = `<div class="placeholder"><b>Page web / visio</b><small>${esc(d.cue.url || 'aucune URL')}</small></div>`;
          return;
        }
        if (!d.cue.url) { el.innerHTML = '<div class="placeholder">Aucune URL</div>'; return; }
        const f = document.createElement('iframe');
        f.src = d.cue.url;
        f.allow = 'camera; microphone; fullscreen; autoplay; display-capture; clipboard-write';
        f.referrerPolicy = 'no-referrer';
        if (d.cue.zoom && d.cue.zoom !== 1) Object.assign(f.style, { width: 100 / d.cue.zoom + '%', height: 100 / d.cue.zoom + '%', transform: `scale(${d.cue.zoom})`, transformOrigin: '0 0' });
        el.append(f);
        await new Promise((r) => f.addEventListener('load', r, { once: true }));
        return;
      }
      case 'camera': {
        const v = document.createElement('video');
        v.className = 'fit' + (d.cue.fill ? ' cover' : '');
        v.autoplay = true; v.playsInline = true;
        v.muted = monitor || !this.stage.opts.audio || !d.cue.withAudio;
        el.append(v);
        v.srcObject = await cameraStream(d.cue);
        await v.play().catch(() => {});
        return;
      }
      case 'title':
      case 'poll':
      case 'qa':
        this.renderCard(d, this.stage.state);
        return;
      case 'scene':
        this.builtAt = this.stage.opts.client ? this.stage.opts.client.now() : Date.now();
        this.children = new Map();
        this.syncScene(d, this.stage.state);
        // On attend que tous les calques soient prêts (avec un plafond) avant d'afficher la scène.
        await Promise.race([Promise.all([...this.children.values()].map((c) => c.stage.whenReady())), new Promise((r) => setTimeout(r, 3500))]);
        return;
      case 'ndi': {
        const api = window.presentor?.ndi;
        if (!api) { el.innerHTML = `<div class="placeholder"><b>NDI : ${esc(d.cue.source?.name || 'aucune source')}</b><small>Réception NDI disponible dans l'app Mac / PC</small></div>`; return; }
        if (!d.cue.source?.name) { el.innerHTML = '<div class="placeholder">Choisissez une source NDI</div>'; return; }
        const c = document.createElement('canvas');
        c.className = 'fit' + (d.cue.fill ? ' cover' : '');
        c.id = 'ndi-' + Math.random().toString(36).slice(2);
        el.append(c);
        // Le module natif tourne dans le preload : il dessine directement dans ce canvas.
        this.ndiHandle = await api.attach(c.id, d.cue.source, { low: !!monitor, audio: !monitor && !!this.stage.opts.audio && d.cue.withAudio !== false });
        await api.firstFrame(this.ndiHandle, 3000);
        return;
      }
    }
  }

  // Positionne / met à jour les calques d'une scène.
  syncScene(d, state) {
    const cue = state?.cues.find((c) => c.id === d.cue.id) || d.cue;
    const el = this.el;
    const transparent = cue.background === 'transparent' || this.stage.opts.transparent;
    el.style.background = transparent ? 'transparent' : cue.background || '#000';
    const bg = cue.bgMediaId && state?.media.find((m) => m.id === cue.bgMediaId);
    el.style.backgroundImage = bg ? `url('/media/${bg.file}')` : '';
    el.style.backgroundSize = 'cover';
    const main = mainLayerOf(cue, state?.cues || []);
    const layers = (cue.layers || []).filter((l) => l.visible !== false && l.cueId);
    for (const [id, ch] of this.children) if (!layers.some((l) => l.id === id)) { ch.stage.destroy(); ch.el.remove(); this.children.delete(id); }
    layers.forEach((l, i) => {
      let ch = this.children.get(l.id);
      if (!ch) {
        const box = document.createElement('div');
        box.className = 'scene-layer';
        const inner = document.createElement('div');
        inner.className = 'scene-inner';
        box.append(inner);
        el.append(box);
        const startAt = () => (this.stage.state?.live?.program?.cueId === cue.id ? this.stage.state.live.cueAt : this.builtAt);
        ch = { el: box, inner, stage: new Stage(inner, { ...this.stage.opts, transparent: true, reportEnded: false, startAt, depth: 1 }) };
        this.children.set(l.id, ch);
      }
      const c = l.crop || {};
      const cw = 1 - (c.l || 0) - (c.r || 0), chh = 1 - (c.t || 0) - (c.b || 0);
      Object.assign(ch.el.style, {
        left: l.x * 100 + '%', top: l.y * 100 + '%', width: l.w * 100 + '%', height: l.h * 100 + '%',
        opacity: l.opacity ?? 1, zIndex: i + 1, borderRadius: (l.radius || 0) * 100 + '%',
      });
      // Recadrage : le contenu est agrandi puis décalé, la boîte du calque masque le reste.
      Object.assign(ch.inner.style, {
        width: '100%', height: '100%', left: 0, top: 0, transformOrigin: '0 0',
        transform: cw < 1 || chh < 1 ? `scale(${1 / cw}, ${1 / chh}) translate(${-(c.l || 0) * 100}%, ${-(c.t || 0) * 100}%)` : '',
      });
      ch.inner.dataset.fit = l.fit || 'contain';
      const slide = main && main.id === l.id ? d.slide || 1 : l.slide || 1;
      ch.stage.update(state, describe(state, { cueId: l.cueId, slide }, { depth: 1 }));
    });
  }

  activate() { this.active = true; this.syncMedia(); }

  update(desc, state) {
    this.desc = desc;
    if (['title', 'poll', 'qa'].includes(desc.type)) this.renderCard(desc, state);
    if (desc.type === 'scene' && this.children) this.syncScene(desc, state);
    if (this.video) {
      this.video.loop = !!desc.cue.loop;
      this.video.volume = Math.max(0, Math.min(1, desc.cue.volume ?? 1));
      this.syncMedia();
      if (!this.syncTimer) this.syncTimer = setInterval(() => this.syncMedia(), 250);
    }
  }

  // Lecture calée sur l'horloge du serveur : toutes les sorties restent synchronisées.
  syncMedia() {
    const v = this.video;
    if (!v || !this.active) return;
    const startAt = this.stage.opts.startAt;
    if (startAt && this.stage.opts.client) {
      // Vidéo dans une scène : démarre avec la scène, synchronisée entre toutes les sorties.
      const dur = v.duration || Infinity;
      let t = (this.stage.opts.client.now() - startAt()) / 1000;
      if (t < 0) { if (!v.paused) v.pause(); return; }
      if (v.loop && isFinite(dur)) t %= dur;
      else if (t >= dur) { if (!v.paused) v.pause(); return; }
      if (Math.abs(v.currentTime - t) > 0.5) v.currentTime = t;
      if (v.paused) v.play().catch(() => { v.muted = true; v.play().catch(() => {}); });
      return;
    }
    if (this.stage.opts.free) {
      // Écran périphérique sur un élément fixe : boucle autonome.
      v.loop = true;
      if (v.paused) v.play().catch(() => { v.muted = true; v.play().catch(() => {}); });
      return;
    }
    const pb = this.stage.state?.live?.playback;
    const client = this.stage.opts.client;
    if (!pb || pb.cueId !== this.desc.cue.id || !client) { if (!v.paused) v.pause(); return; }
    let target = pb.playing ? (client.now() - pb.startedAt) / 1000 : pb.offset;
    const dur = v.duration || Infinity;
    if (v.loop && isFinite(dur) && dur > 0) target = ((target % dur) + dur) % dur;
    if (target < 0) { if (!v.paused) v.pause(); if (v.currentTime > 0.05) v.currentTime = 0; return; }
    if (target >= dur && !v.loop) return;
    const drift = v.currentTime - target;
    if (pb.playing) {
      if (Math.abs(drift) > 0.5) v.currentTime = target;
      else v.playbackRate = Math.abs(drift) > 0.04 ? (drift > 0 ? 0.97 : 1.03) : 1;
      if (v.paused) {
        v.play().catch((e) => {
          if (e.name === 'NotAllowedError' && !v.muted) { v.muted = true; v.play().catch(() => {}); this.stage.opts.onAutoplayBlocked?.(() => { v.muted = false; }); }
        });
      }
    } else {
      if (!v.paused) v.pause();
      if (Math.abs(drift) > 0.05) v.currentTime = target;
    }
  }

  renderCard(d, state) {
    let html = '';
    const cue = d.cue;
    const bg = cue.bgMediaId && state?.media.find((m) => m.id === cue.bgMediaId);
    const bgStyle = bg ? ` style="background-image:url('/media/${esc(bg.file)}')"` : '';
    if (d.type === 'title') {
      html = `<div class="card title-card"${bgStyle}><h1>${esc(cue.title || cue.name)}</h1>${cue.subtitle ? `<p>${esc(cue.subtitle)}</p>` : ''}</div>`;
    } else if (d.type === 'poll') {
      const poll = state?.polls.find((p) => p.id === cue.pollId);
      html = poll ? pollCard(poll, state, this) : '<div class="placeholder">Sondage non défini</div>';
    } else if (d.type === 'qa') {
      const q = state?.questions.find((x) => x.status === 'shown');
      html = q
        ? `<div class="card qa-card"${bgStyle}><div class="qa-label">Question du public</div><blockquote>${esc(q.text)}</blockquote>${q.author ? `<div class="qa-author">— ${esc(q.author)}</div>` : ''}</div>`
        : `<div class="card qa-card"${bgStyle}><h1>${esc(cue.title || 'Posez vos questions')}</h1>${joinBlock(this)}</div>`;
    }
    if (this.el.dataset.html !== html) {
      this.el.dataset.html = html;
      this.el.innerHTML = html;
      this.fillJoin(state);
    }
  }

  fillJoin(state) {
    const el = this.el.querySelector('[data-join]');
    if (!el) return;
    joinUrl(state).then((url) => {
      el.querySelector('img').src = '/api/qr.svg?text=' + encodeURIComponent(url);
      el.querySelector('.join-url').textContent = url.replace(/^https?:\/\//, '').replace(/\/$/, '');
    });
  }

  destroy() {
    clearInterval(this.syncTimer);
    for (const ch of this.children?.values() || []) ch.stage.destroy();
    if (this.ndiHandle) window.presentor?.ndi?.detach(this.ndiHandle);
    if (this.video) { this.video.pause(); this.video.removeAttribute('src'); this.video.srcObject = null; this.video.load(); }
    this.el.remove();
  }
}

function joinBlock() {
  return `<div class="join" data-join><img alt=""><div><div class="join-label">Participez sur</div><div class="join-url"></div></div></div>`;
}

function pollCard(poll, state) {
  const r = poll.results || { total: 0 };
  const showRes = poll.showResults;
  let body = '';
  if (poll.kind === 'words') {
    const max = Math.max(1, ...(r.words || []).map((w) => w[1]));
    body = `<div class="cloud">${(r.words || []).map(([w, n]) => `<span style="font-size:${1 + (n / max) * 2.6}em;opacity:${0.55 + (n / max) * 0.45}">${esc(w)}</span>`).join('') || '<span class="muted">En attente des réponses…</span>'}</div>`;
  } else if (poll.kind === 'rating') {
    const max = Math.max(1, ...(r.counts || [0]));
    body = `<div class="rating-avg">${showRes ? (r.avg || 0).toFixed(1) : '–'}<small>/5</small></div>
      <div class="bars">${[1, 2, 3, 4, 5].map((n) => bar('★'.repeat(n), showRes ? r.counts[n - 1] : 0, max, r.total)).join('')}</div>`;
  } else {
    const max = Math.max(1, ...(r.counts || [0]));
    body = `<div class="bars">${poll.options.map((o, i) => bar(o, showRes ? r.counts?.[i] || 0 : 0, max, r.total, !showRes)).join('')}</div>`;
  }
  const open = state?.activePollId === poll.id;
  return `<div class="card poll-card"><h1>${esc(poll.question)}</h1>${body}
    <div class="poll-foot">${open ? joinBlock() : '<div class="closed">Vote clos</div>'}<div class="total">${r.total || 0} réponse${r.total > 1 ? 's' : ''}</div></div></div>`;
}

function bar(label, n, max, total, hidden = false) {
  const pct = total ? Math.round((n / total) * 100) : 0;
  return `<div class="bar"><div class="bar-label">${esc(label)}</div><div class="bar-track"><div class="bar-fill" style="width:${hidden ? 0 : (n / max) * 100}%"></div></div><div class="bar-val">${hidden ? '' : pct + '%'}</div></div>`;
}

// ---------------------------------------------------------------- navigation (miroir du serveur)
export function slideCount(state, cue) {
  if (cue?.type === 'scene') {
    const main = mainLayerOf(cue, state.cues);
    return main ? slideCount(state, state.cues.find((c) => c.id === main.cueId)) : 1;
  }
  if (cue?.type !== 'slides') return 1;
  return Math.max(1, state.media.find((m) => m.id === cue.mediaId)?.pages || 1);
}
export function stepFrom(state, pos, dir) {
  const cues = state?.cues || [];
  if (!cues.length) return null;
  if (!pos) return { cueId: cues[0].id, slide: 1 };
  const idx = cues.findIndex((c) => c.id === pos.cueId);
  const cue = cues[idx];
  if (dir > 0) {
    if (cue && pos.slide < slideCount(state, cue)) return { cueId: cue.id, slide: pos.slide + 1 };
    return cues[idx + 1] ? { cueId: cues[idx + 1].id, slide: 1 } : null;
  }
  if (cue && pos.slide > 1) return { cueId: cue.id, slide: pos.slide - 1 };
  return cues[idx - 1] ? { cueId: cues[idx - 1].id, slide: slideCount(state, cues[idx - 1]) } : null;
}

export function mainLayerOf(scene, cues) {
  const layers = (scene.layers || []).filter((l) => l.cueId);
  return layers.find((l) => l.main) || layers.find((l) => cues.find((c) => c.id === l.cueId)?.type === 'slides') || null;
}
