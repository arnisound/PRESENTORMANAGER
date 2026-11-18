// Page de sortie vidéo : une instance par écran physique (grand écran, retour
// présentateur, écrans périphériques, multiview régie…).
import { Client, bindClicker, esc, fmtTime, timerValue } from '/shared/client.js';
import { Stage, describe, notesFor, stepFrom } from '/shared/renderer.js';
import { quadMatrix, blendMask, testPatternSvg, DEFAULT_CORNERS } from '/shared/mapping.js';
import { CompositionView, deckInfo } from '/shared/composition.js';

const params = new URLSearchParams(location.search);
const outputId = params.get('id');
// Aperçu intégré à l'éditeur de mapping : muet, sans iframe, non compté comme écran.
const previewMode = params.get('preview') === '1';
if (previewMode) document.documentElement.classList.add('preview-mode');
const app = document.getElementById('app');
const statusEl = document.getElementById('status');
const unlockEl = document.getElementById('audio-unlock');

let view = null; // { source, render(state) }

const client = new Client({
  role: 'output',
  output: previewMode ? null : outputId,
  onState: (state) => render(state),
  onStatus: (s) => {
    // On garde la dernière image à l'écran en cas de coupure réseau.
    statusEl.hidden = s === 'online' || client.state?.settings?.showOfflineBanner === false || view?.source === 'program' || view?.source === 'clean';
    statusEl.textContent = 'Connexion perdue — reconnexion…';
  },
});
if (!previewMode) bindClicker(client);

function render(state) {
  const st = state.settings;
  document.documentElement.style.setProperty('--accent', st.accent);
  document.body.style.background = st.outputBackground || '#000';
  document.body.classList.toggle('show-cursor', st.hideCursor === false);
  if (st.keepAwake !== false) keepAwake();
  if (!outputId) return renderPicker(state);
  const out = state.outputs.find((o) => o.id === outputId);
  if (!out) { app.innerHTML = '<div class="picker"><h1>Sortie supprimée</h1><p><a href="/output/">Choisir une autre sortie</a></p></div>'; view = null; return; }
  document.title = out.name + ' — PresenThor';
  const mapped = !!(out.mapping && out.zones?.length);
  const source = mapped ? 'mapping' : out.source;
  if (!view || view.source !== source || view.audio !== !!out.audio) {
    app.innerHTML = '';
    view = mapped ? mappingView(baseOpts(out)) : createView(source, out);
  }
  view.render(state, out);
  reportResolution();
}

function baseOpts(out) {
  return { client, audio: !!out.audio && !previewMode, monitor: previewMode, onAutoplayBlocked };
}

// Contenu d'une source "écran" : composition (programme), composition sans habillage,
// calque isolé, élément fixe. ("preview" : ancien mode conducteur.)
function makeSourceStage(el, source, opts) {
  if (source === 'program' || source === 'clean' || source === 'aux' || source.startsWith('layer:')) {
    const view = new CompositionView(el, {
      ...opts,
      reportEnded: !previewMode && source === 'program',
      overlays: source === 'program',
      only: source.startsWith('layer:') ? source.slice(6) : null,
      outputId,
      aux: source === 'aux',
    });
    return (s) => view.update(s);
  }
  if (source.startsWith('cue:')) {
    const stage = new Stage(el, { ...opts, free: true });
    const cueId = source.slice(4);
    return (s) => stage.update(s, describe(s, { cueId, slide: 1 }));
  }
  const stage = new Stage(el, { ...opts, reportEnded: !previewMode && (source === 'program' || source === 'clean') });
  return (s) => {
    const pos = source === 'preview' ? s.live.preview : s.live.program;
    const flags = source === 'preview' ? {} : { blackout: s.live.blackout, logo: s.live.logo };
    stage.update(s, describe(s, pos, flags), source === 'program' ? s.live.overlay : null, source === 'program' && !s.live.blackout ? s.live.overlayScenes : null);
    if (source !== 'preview') stage.preload(describe(s, stepFrom(s, s.live.program, 1)));
  };
}

// Mapping : chaque zone est une copie de la source, recadrée puis déformée
// sur 4 coins, avec fondu de bord éventuel.
function mappingView(opts) {
  const root = document.createElement('div');
  root.className = 'mapping';
  app.append(root);
  const zones = new Map();
  let last = null;
  const render = (s, out) => {
    last = [s, out];
    const W = window.innerWidth, H = window.innerHeight;
    const list = out.zones || [];
    for (const [id, z] of zones) if (!list.some((x) => x.id === id)) { z.stage?.destroy?.(); z.el.remove(); zones.delete(id); }
    list.forEach((zd, i) => {
      const src = zd.source || (['presenter', 'multiview', 'preview'].includes(out.source) ? 'program' : out.source);
      let z = zones.get(zd.id);
      if (!z || z.src !== src) {
        z?.el.remove();
        const el = document.createElement('div');
        el.className = 'zone';
        el.innerHTML = '<div class="zone-crop"><div class="zone-inner"></div></div><div class="zone-test"></div>';
        root.append(el);
        z = { el, src, inner: el.querySelector('.zone-inner'), test: el.querySelector('.zone-test') };
        z.update = makeSourceStage(z.inner, src, opts);
        zones.set(zd.id, z);
      }
      const c = zd.crop || { x: 0, y: 0, w: 1, h: 1 };
      const corners = (zd.corners || DEFAULT_CORNERS).map(([x, y]) => [x * W, y * H]);
      Object.assign(z.el.style, {
        width: W + 'px', height: H + 'px', transform: quadMatrix(W, H, corners), zIndex: i + 1,
        opacity: zd.opacity ?? 1, display: zd.visible === false ? 'none' : '',
      });
      const mask = blendMask(zd.blend, zd.gamma || 2.2);
      z.el.style.maskImage = z.el.style.webkitMaskImage = mask || 'none';
      z.el.style.maskComposite = 'intersect';
      z.el.style.webkitMaskComposite = 'source-in';
      // La source est rendue à la taille de la sortie, puis la partie choisie est agrandie.
      Object.assign(z.inner.style, {
        width: W + 'px', height: H + 'px', left: 0, top: 0, transformOrigin: '0 0',
        transform: `scale(${1 / c.w}, ${1 / c.h}) translate(${-c.x * W}px, ${-c.y * H}px)`,
      });
      const testHtml = out.testPattern ? testPatternSvg(zd.name, ['#22d3ee', '#f472b6', '#a3e635', '#facc15'][i % 4]) : '';
      if (z.test.dataset.html !== testHtml) { z.test.dataset.html = testHtml; z.test.innerHTML = testHtml; }
      z.update(s);
    });
  };
  window.addEventListener('resize', () => last && render(...last));
  return { source: 'mapping', audio: !!opts.audio, render };
}

let reported = '';
function reportResolution() {
  if (previewMode || !outputId) return;
  const key = window.innerWidth + 'x' + window.innerHeight;
  if (key === reported || !client.connected) return;
  reported = key;
  client.send({ type: 'output.report', id: outputId, w: window.innerWidth, h: window.innerHeight });
}
window.addEventListener('resize', () => { if (client.state) render(client.state); });

function createView(source, out) {
  const opts = baseOpts(out);
  if (source === 'presenter') return presenterView(opts);
  if (source === 'multiview') return multiView(opts);
  const el = document.createElement('div');
  el.className = 'fill';
  app.append(el);
  const update = makeSourceStage(el, source, opts);
  // Mire plein écran (calage projecteur) même sans zones de mapping.
  const test = document.createElement('div');
  test.className = 'zone-test full';
  app.append(test);
  return {
    source, audio: !!out.audio,
    render: (s, o) => {
      update(s);
      const html = o?.testPattern ? testPatternSvg(o.name) : '';
      if (test.dataset.html !== html) { test.dataset.html = html; test.innerHTML = html; }
    },
  };
}

function presenterView(opts) {
  app.innerHTML = `<div class="presenter">
    <div class="p-head"><div class="p-clock" data-clock></div><div class="p-timer" data-timer></div><div class="p-count" data-count></div></div>
    <div class="p-current"><div class="p-label">À l'écran <b data-cur></b></div><div class="p-comp" data-stage-cur></div></div>
    <div class="p-next"><div class="p-label">Diapo suivante <b data-next></b></div><div data-stage-next></div></div>
    <div class="p-notes" data-notes></div>
    <div data-msg></div><div data-black></div></div>`;
  const $ = (s) => app.querySelector(s);
  // Vignettes "monitor" : pas d'iframe (évite de rejoindre une visio deux fois), pas de son.
  const cur = new CompositionView($('[data-stage-cur]'), { ...opts, audio: false, monitor: true, overlays: true });
  const nxt = new Stage($('[data-stage-next]'), { ...opts, audio: false, monitor: true });
  let state;
  const tick = () => {
    if (!state) return;
    $('[data-clock]').textContent = new Date(client.now()).toLocaleTimeString('fr-FR');
    const v = timerValue(state.timer, client.now());
    const el = $('[data-timer]');
    el.textContent = fmtTime(v, true);
    el.className = 'p-timer' + (state.timer.mode === 'down' ? (v < 0 ? ' over' : v < (state.settings.timerWarnSec ?? 120) * 1000 ? ' warn' : '') : '');
  };
  setInterval(tick, 250);
  return {
    source: 'presenter', audio: false,
    render(s) {
      state = s;
      cur.update(s);
      const d = deckInfo(s);
      nxt.update(s, d?.next ? describe(s, { cueId: d.cue.id, slide: d.next }) : { key: 'end', type: 'placeholder', label: d ? 'Dernière diapo' : 'Pas de présentation à l\'écran' });
      $('[data-cur]').textContent = d ? d.cue.name : '';
      $('[data-next]').textContent = d?.next ? `${d.next} / ${d.pages}` : '';
      $('[data-count]').textContent = d ? `${d.slide} / ${d.pages}` : '';
      $('[data-notes]').textContent = d?.notes || '';
      const msgFresh = s.message && client.now() - s.message.at < 10 * 60 * 1000;
      $('[data-msg]').innerHTML = msgFresh ? `<div class="p-msg">${esc(s.message.text)}</div>` : '';
      $('[data-black]').innerHTML = s.live.blackout ? '<div class="p-black">ÉCRAN NOIR</div>' : '';
      tick();
    },
  };
}

// Multiview régie : la sortie + un moniteur par calque.
function multiView(opts) {
  app.innerHTML = `<div class="multiview">
    <div class="mv-head"><b data-name></b><span data-timer></span><span data-clock></span></div>
    <div class="mv-cell pgm"><div class="mv-tag">SORTIE <span data-pgm></span></div><div class="mv-comp" data-s-pgm></div></div>
    <div class="mv-layers" data-layers></div></div>`;
  const $ = (s) => app.querySelector(s);
  const pgm = new CompositionView($('[data-s-pgm]'), { ...opts, monitor: true, overlays: true });
  const mons = new Map();
  let state;
  setInterval(() => {
    $('[data-clock]').textContent = new Date(client.now()).toLocaleTimeString('fr-FR');
    if (state) $('[data-timer]').textContent = '⏱ ' + fmtTime(timerValue(state.timer, client.now()), true);
  }, 250);
  return {
    source: 'multiview', audio: !!opts.audio,
    render(s) {
      state = s;
      $('[data-name]').textContent = s.show.name;
      $('[data-pgm]').textContent = s.live.blackout ? 'NOIR' : '';
      pgm.update(s);
      const wrap = $('[data-layers]');
      const layers = [...s.comp.layers].reverse();
      for (const [id, m] of mons) if (!layers.some((l) => l.id === id)) { m.view.destroy(); m.el.remove(); mons.delete(id); }
      for (const l of layers) {
        let m = mons.get(l.id);
        if (!m) {
          const el = document.createElement('div');
          el.className = 'mv-cell';
          el.innerHTML = '<div class="mv-tag"><span data-n></span><span data-c></span></div><div class="mv-comp"></div>';
          m = { el, view: new CompositionView(el.querySelector('.mv-comp'), { ...opts, audio: false, monitor: true, only: l.id }) };
          mons.set(l.id, m);
        }
        wrap.append(m.el);
        const cue = s.cues.find((c) => c.id === s.live.comp?.active?.[l.id]);
        m.el.querySelector('[data-n]').textContent = l.name;
        m.el.querySelector('[data-c]').textContent = cue ? cue.name : '—';
        m.el.classList.toggle('off', !cue || l.bypass);
        m.view.update(s);
      }
    },
  };
}

function renderPicker(state) {
  view = null;
  app.innerHTML = `<div class="picker"><img class="picker-logo" src="/brand/logo-192.png" alt="PresenThor"><h1>Choisir la sortie de cet écran</h1>
    <p>Ouvrez cette page sur l'ordinateur relié à l'écran, puis passez en plein écran (double-clic ou F11).</p>
    ${state.outputs.map((o) => `<a href="?id=${encodeURIComponent(o.id)}">${esc(o.name)} <small>${esc(o.source)}</small></a>`).join('')}
    <p><small>PresenThor by arnisoundtools.com</small></p></div>`;
}

function onAutoplayBlocked(unmute) {
  unlockEl.hidden = false;
  window.addEventListener('pointerdown', () => { unmute(); unlockEl.hidden = true; }, { once: true });
}

// Ergonomie écran : curseur masqué, double-clic = plein écran.
let idleT;
window.addEventListener('mousemove', () => { document.body.classList.remove('idle'); clearTimeout(idleT); idleT = setTimeout(() => document.body.classList.add('idle'), 2000); });
// Plein écran : double-clic pour basculer, Échap pour sortir (aussi dans l'app Mac / PC).
const toggleFs = () => {
  if (window.presenthor?.toggleOutputFullscreen) return window.presenthor.toggleOutputFullscreen();
  return document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen().catch(() => {});
};
window.addEventListener('dblclick', toggleFs);
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.presenthor?.exitOutputFullscreen?.();
  if (e.key === 'F11') { e.preventDefault(); toggleFs(); }
});
// Évite la mise en veille de l'écran pendant la diffusion (navigateurs compatibles).
let wake = null;
function keepAwake() { if (!wake && document.visibilityState === 'visible') wake = navigator.wakeLock?.request('screen').then((l) => { l.addEventListener('release', () => { wake = null; }); return l; }).catch(() => { wake = null; }); }
document.addEventListener('visibilitychange', () => client.state?.settings?.keepAwake !== false && keepAwake());
