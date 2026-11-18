// Page de sortie vidéo : une instance par écran physique (grand écran, retour
// présentateur, écrans périphériques, multiview régie…).
import { Client, bindClicker, esc, fmtTime, timerValue } from '/shared/client.js';
import { Stage, describe, notesFor, stepFrom } from '/shared/renderer.js';

const params = new URLSearchParams(location.search);
const outputId = params.get('id');
const app = document.getElementById('app');
const statusEl = document.getElementById('status');
const unlockEl = document.getElementById('audio-unlock');

let view = null; // { source, render(state) }

const client = new Client({
  role: 'output',
  output: outputId,
  onState: (state) => render(state),
  onStatus: (s) => {
    // On garde la dernière image à l'écran en cas de coupure réseau.
    statusEl.hidden = s === 'online' || view?.source === 'program' || view?.source === 'clean';
    statusEl.textContent = 'Connexion perdue — reconnexion…';
  },
});
bindClicker(client);

function render(state) {
  document.documentElement.style.setProperty('--accent', state.settings.accent);
  if (!outputId) return renderPicker(state);
  const out = state.outputs.find((o) => o.id === outputId);
  if (!out) { app.innerHTML = '<div class="picker"><h1>Sortie supprimée</h1><p><a href="/output/">Choisir une autre sortie</a></p></div>'; view = null; return; }
  document.title = out.name + ' — Presentor';
  const source = out.source;
  if (!view || view.source !== source || view.audio !== !!out.audio) {
    app.innerHTML = '';
    view = createView(source, out);
  }
  view.render(state);
}

function createView(source, out) {
  const opts = { client, audio: !!out.audio, onAutoplayBlocked };
  if (source === 'presenter') return presenterView(opts);
  if (source === 'multiview') return multiView(opts);
  const el = document.createElement('div');
  app.append(el);
  if (source.startsWith('cue:')) {
    const stage = new Stage(el, { ...opts, free: true });
    const cueId = source.slice(4);
    return { source, audio: !!out.audio, render: (s) => stage.update(s, describe(s, { cueId, slide: 1 })) };
  }
  const stage = new Stage(el, { ...opts, reportEnded: source === 'program' || source === 'clean' });
  return {
    source, audio: !!out.audio,
    render: (s) => {
      const pos = source === 'preview' ? s.live.preview : s.live.program;
      const flags = source === 'preview' ? {} : { blackout: s.live.blackout, logo: s.live.logo };
      stage.update(s, describe(s, pos, flags), source === 'program' ? s.live.overlay : null, source === 'program' && !s.live.blackout ? s.live.overlayScenes : null);
      if (source !== 'preview') stage.preload(describe(s, stepFrom(s, s.live.program, 1)));
    },
  };
}

function presenterView(opts) {
  app.innerHTML = `<div class="presenter">
    <div class="p-head"><div class="p-clock" data-clock></div><div class="p-timer" data-timer></div><div class="p-count" data-count></div></div>
    <div class="p-current"><div class="p-label">En cours <b data-cur></b></div><div data-stage-cur></div></div>
    <div class="p-next"><div class="p-label">Suivant <b data-next></b></div><div data-stage-next></div></div>
    <div class="p-notes" data-notes></div>
    <div data-msg></div><div data-black></div></div>`;
  const $ = (s) => app.querySelector(s);
  const cur = new Stage($('[data-stage-cur]'), { ...opts, audio: false, monitor: true }); // pas d'iframe : évite de rejoindre la visio deux fois
  const nxt = new Stage($('[data-stage-next]'), { ...opts, audio: false, monitor: true });
  let state;
  const tick = () => {
    if (!state) return;
    $('[data-clock]').textContent = new Date(client.now()).toLocaleTimeString('fr-FR');
    const v = timerValue(state.timer, client.now());
    const el = $('[data-timer]');
    el.textContent = fmtTime(v, true);
    el.className = 'p-timer' + (state.timer.mode === 'down' ? (v < 0 ? ' over' : v < 120000 ? ' warn' : '') : '');
  };
  setInterval(tick, 250);
  return {
    source: 'presenter', audio: false,
    render(s) {
      state = s;
      const pos = s.live.program;
      const next = stepFrom(s, pos, 1);
      cur.update(s, describe(s, pos, { logo: s.live.logo }));
      nxt.update(s, next ? describe(s, next) : { key: 'end', type: 'placeholder', label: 'Fin du conducteur' });
      const cue = s.cues.find((c) => c.id === pos?.cueId);
      const nextCue = s.cues.find((c) => c.id === next?.cueId);
      $('[data-cur]').textContent = cue?.name || '—';
      $('[data-next]').textContent = nextCue ? nextCue.name + (next.cueId === pos?.cueId ? ` · diapo ${next.slide}` : '') : '';
      const media = cue?.type === 'slides' ? s.media.find((m) => m.id === cue.mediaId) : null;
      $('[data-count]').textContent = media ? `${pos.slide} / ${media.pages || '?'}` : '';
      $('[data-notes]').textContent = notesFor(s, pos);
      const msgFresh = s.message && client.now() - s.message.at < 10 * 60 * 1000;
      $('[data-msg]').innerHTML = msgFresh ? `<div class="p-msg">${esc(s.message.text)}</div>` : '';
      $('[data-black]').innerHTML = s.live.blackout ? '<div class="p-black">ÉCRAN NOIR</div>' : '';
      tick();
    },
  };
}

function multiView(opts) {
  app.innerHTML = `<div class="multiview">
    <div class="mv-head"><b data-name></b><span data-timer></span><span data-clock></span></div>
    <div class="mv-cell pvw"><div class="mv-tag">PREVIEW <span data-pvw></span></div><div data-s-pvw></div></div>
    <div class="mv-cell pgm"><div class="mv-tag">PROGRAMME <span data-pgm></span></div><div data-s-pgm></div></div>
    <div class="mv-list" data-list></div></div>`;
  const $ = (s) => app.querySelector(s);
  const pvw = new Stage($('[data-s-pvw]'), { ...opts, audio: false, monitor: true });
  const pgm = new Stage($('[data-s-pgm]'), { ...opts, monitor: true });
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
      pvw.update(s, describe(s, s.live.preview));
      pgm.update(s, describe(s, s.live.program, { blackout: s.live.blackout, logo: s.live.logo }), s.live.overlay, s.live.blackout ? null : s.live.overlayScenes);
      const nm = (p) => { const c = s.cues.find((x) => x.id === p?.cueId); return c ? c.name + (c.type === 'slides' ? ` (${p.slide})` : '') : '—'; };
      $('[data-pvw]').textContent = nm(s.live.preview);
      $('[data-pgm]').textContent = (s.live.blackout ? 'NOIR · ' : '') + nm(s.live.program);
      $('[data-list]').innerHTML = s.cues.map((c, i) => `<span class="${c.id === s.live.program?.cueId ? 'pgm' : c.id === s.live.preview?.cueId ? 'pvw' : ''}">${i + 1}. ${esc(c.name)}</span>`).join('');
    },
  };
}

function renderPicker(state) {
  view = null;
  app.innerHTML = `<div class="picker"><h1>Choisir la sortie de cet écran</h1>
    <p>Ouvrez cette page sur l'ordinateur relié à l'écran, puis passez en plein écran (double-clic ou F11).</p>
    ${state.outputs.map((o) => `<a href="?id=${encodeURIComponent(o.id)}">${esc(o.name)} <small>${esc(o.source)}</small></a>`).join('')}</div>`;
}

function onAutoplayBlocked(unmute) {
  unlockEl.hidden = false;
  window.addEventListener('pointerdown', () => { unmute(); unlockEl.hidden = true; }, { once: true });
}

// Ergonomie écran : curseur masqué, double-clic = plein écran.
let idleT;
window.addEventListener('mousemove', () => { document.body.classList.remove('idle'); clearTimeout(idleT); idleT = setTimeout(() => document.body.classList.add('idle'), 2000); });
window.addEventListener('dblclick', () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen().catch(() => {})));
// Évite la mise en veille de l'écran pendant la diffusion (navigateurs compatibles).
const keepAwake = () => navigator.wakeLock?.request('screen').catch(() => {});
keepAwake();
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && keepAwake());
