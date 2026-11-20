// Régie PresenThor : grille calques × colonnes (déclenchement de clips en direct),
// moniteurs, propriétés Composition / Calque / Clip, navigateur de médias et sources.
import { Client, bindClicker, esc, fmtTime, timerValue, timerVisible, getPin } from '/shared/client.js';
import { Stage, describe, pdfThumb, joinUrl } from '/shared/renderer.js';
import { CompositionView, deckInfo } from '/shared/composition.js';
import { openSceneEditor } from '/control/scene-editor.js';
import { openMappingEditor } from '/control/mapping-editor.js';
import { openPrefs } from '/control/prefs.js';
import { guestStream, setReturnTracks } from '/shared/rtc.js';

const $ = (s, r = document) => r.querySelector(s);
const desktop = window.presenthor || null; // API de l'app Mac / PC
const ICONS = { slides: '📑', video: '🎬', image: '🖼', audio: '🎵', web: '🌐', camera: '🎥', ndi: '📡', scene: '🧩', window: '🪟', guest: '🧑‍💻', poll: '📊', qa: '💬', title: '🅃', black: '⬛', color: '🎨', qr: '▦' };
const TYPE_LABEL = { slides: 'PRÉSENTATION', video: 'VIDÉO', image: 'IMAGE', audio: 'AUDIO', web: 'WEB', camera: 'CAMÉRA', ndi: 'NDI', scene: 'SCÈNE', window: 'FENÊTRE', guest: 'INVITÉ', poll: 'SONDAGE', qa: 'Q&R', title: 'TEXTE', black: 'NOIR', color: 'COULEUR', qr: 'QR' };
const BLENDS = [['normal', 'Normal'], ['plus-lighter', 'Ajout (Add)'], ['screen', 'Écran'], ['multiply', 'Produit'], ['overlay', 'Incrustation'], ['lighten', 'Éclaircir'], ['darken', 'Assombrir'], ['difference', 'Différence'], ['color-dodge', 'Densité -'], ['luminosity', 'Luminosité']];
const MASKS = [['none', 'Aucun'], ['ellipse', 'Ovale'], ['circle', 'Cercle'], ['rounded', 'Coins arrondis'], ['diamond', 'Losange']];
const FX = {
  brightness: { label: 'Luminosité', min: 0, max: 3, step: 0.05, def: 1.3 },
  contrast: { label: 'Contraste', min: 0, max: 3, step: 0.05, def: 1.3 },
  saturate: { label: 'Saturation', min: 0, max: 3, step: 0.05, def: 1.6 },
  hue: { label: 'Teinte', min: 0, max: 360, step: 1, def: 90 },
  blur: { label: 'Flou', min: 0, max: 40, step: 0.5, def: 6 },
  grayscale: { label: 'Noir & blanc', min: 0, max: 1, step: 0.05, def: 1 },
  sepia: { label: 'Sépia', min: 0, max: 1, step: 0.05, def: 1 },
  invert: { label: 'Négatif', min: 0, max: 1, step: 0.05, def: 1 },
  mirrorX: { label: 'Miroir horizontal' },
  mirrorY: { label: 'Miroir vertical' },
};
const LOOP_MODES = [['loop', 'Boucle'], ['once', 'Une fois (reste sur la fin)'], ['next', 'Puis clip suivant du calque'], ['clear', 'Une fois puis vider le calque']];

// Fenêtre détachée (« ?panel=public » ou « ?panel=live ») : un seul panneau, plein écran.
const PANEL = new URLSearchParams(location.search).get('panel');
const PANEL_NAMES = { public: 'Public et visio', live: 'Direct', outputs: 'Sorties', media: 'Médias', sources: 'Sources', fx: 'Effets', settings: 'Infos' };
if (PANEL) { document.body.classList.add('panel-mode'); document.title = (PANEL_NAMES[PANEL] || PANEL) + ' — PresenThor'; }
// Coordination entre la régie et ses fenêtres détachées (retour visio).
const bc = 'BroadcastChannel' in window ? new BroadcastChannel('presenthor-regie') : null;

let S = null;
let sel = null; // { layerId, col } case sélectionnée
let selLayerId = null;
let ptab = 'clip';
let btab = PANEL || 'media';
let displays = [];
let cameras = [];
let info = { lan: [] };
let outState = {};
let voteUrl = '';

const client = new Client({ role: 'control', onState, onStatus: (s) => { $('#conn').classList.toggle('on', s === 'online'); $('#conn').textContent = s === 'online' ? '● En ligne' : '● Hors ligne'; } });
const send = async (action) => {
  const r = await client.send(action);
  if (r?.error) toast(r.error);
  return r;
};
bindClicker(client);
window.__presenthorAction = (a) => send(a); // télécommande globale (app desktop)

// Moniteurs : seulement dans la régie principale (inutile de décoder des vidéos dans une fenêtre détachée).
// Pré-écoute : le moniteur de sortie peut être entendu au casque (préférence Audio).
const outMon = PANEL ? null : new CompositionView($('#out-mon'), { client, monitor: true, overlays: true, reportEnded: true,
  audio: true, listen: () => !!S?.settings.regieListen, sink: () => S?.settings.regieAudioDevice });
const pvwMon = PANEL ? null : new Stage($('#pvw-mon'), { client, monitor: true, clipStyle: true, free: true });

fetch('/api/info').then((r) => r.json()).then((i) => { info = i; renderBrowser(true); });
joinUrl(null).then((u) => { voteUrl = u; });
if (desktop) {
  desktop.listDisplays().then((d) => { displays = d; renderBrowser(true); });
  desktop.onDisplaysChanged((d) => { displays = d; renderBrowser(true); });
  setInterval(async () => { const st = await desktop.outputsState?.(); if (st && JSON.stringify(st) !== JSON.stringify(outState)) { outState = st; renderBrowser(true); } }, 1000);
}

// ------------------------------------------------------------------ utilitaires
const cueById = (id) => S?.cues.find((c) => c.id === id);
const mediaById = (id) => S?.media.find((m) => m.id === id);
const layerById = (id) => S?.comp.layers.find((l) => l.id === id);
const selCue = () => (sel ? cueById(layerById(sel.layerId)?.clips[sel.col]) : null);
// Un curseur en cours de glissé ne doit jamais être redessiné (sinon il « saute »).
let dragRange = null;
document.addEventListener('pointerdown', (e) => { if (e.target.matches?.('input[type=range]')) dragRange = e.target; }, true);
const endDrag = () => { if (!dragRange) return; const r = dragRange; dragRange = null; r.blur(); setTimeout(() => S && renderAll(), 60); };
document.addEventListener('pointerup', endDrag, true);
document.addEventListener('pointercancel', endDrag, true);
const isEditing = (el) => {
  if (dragRange && el.contains(dragRange)) return true;
  if (tlDrag && el.contains(tlDrag.el)) return true;
  const a = document.activeElement;
  return a && el.contains(a) && (a.isContentEditable || a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && !['range', 'checkbox', 'color'].includes(a.type)));
};
function patch(el, html, force = false) {
  if (!force && isEditing(el)) return;
  if (el._html === html) return;
  el._html = html;
  el.innerHTML = html;
}
const sel_ = (opts, value) => opts.map(([v, l]) => `<option value="${esc(v)}"${String(v) === String(value ?? '') ? ' selected' : ''}>${esc(l)}</option>`).join('');
const field = (label, input) => `<label class="field"><span>${label}</span>${input}</label>`;
const check = (label, attr, on) => `<label class="check"><input type="checkbox" ${attr}${on ? ' checked' : ''}> ${label}</label>`;
const fmt2 = (v) => (Math.round(v * 100) / 100).toString();
const ask = (msg) => S?.settings?.confirmDelete === false || window.confirm(msg);

// ------------------------------------------------------------------ vignettes
const thumbs = new Map(); // clé -> dataURL
const pending = new Set();
let thumbQueue = Promise.resolve();
function requestThumb(key, make) {
  if (thumbs.has(key) || pending.has(key)) return;
  pending.add(key);
  thumbQueue = thumbQueue.then(() => make().then((url) => { thumbs.set(key, url); }).catch(() => thumbs.set(key, null)).finally(() => { pending.delete(key); scheduleRender(); }));
}
function videoThumb(src) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.muted = true; v.preload = 'auto'; v.src = src;
    const done = () => {
      const c = document.createElement('canvas');
      c.width = 256; c.height = 144;
      const ctx = c.getContext('2d');
      const r = Math.min(256 / v.videoWidth, 144 / v.videoHeight);
      const w = v.videoWidth * r, h = v.videoHeight * r;
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 256, 144);
      ctx.drawImage(v, (256 - w) / 2, (144 - h) / 2, w, h);
      resolve(c.toDataURL('image/jpeg', 0.7));
      v.removeAttribute('src'); v.load();
    };
    v.addEventListener('loadeddata', () => { v.currentTime = Math.min(1, (v.duration || 2) / 3); }, { once: true });
    v.addEventListener('seeked', done, { once: true });
    v.addEventListener('error', () => reject(new Error('vidéo')), { once: true });
    setTimeout(() => reject(new Error('délai')), 8000);
  });
}
const slideThumb = (file, n) => pdfThumb('/media/' + file, n, 256, 144).then((c) => c.toDataURL('image/jpeg', 0.75));

function thumbHtml(cue) {
  if (!cue) return '';
  const m = cue.mediaId ? mediaById(cue.mediaId) : null;
  const img = (src) => `<img src="${esc(src)}" alt="" draggable="false">`;
  const icon = (sub = '') => `<span class="ico">${ICONS[cue.type] || '▫'}</span>${sub ? `<span class="slide-n">${esc(sub)}</span>` : ''}`;
  switch (cue.type) {
    case 'image': return m ? img('/media/' + m.file) : icon();
    case 'video': {
      if (!m) return icon();
      if (m.thumb) return img('/media/' + m.thumb) + (m.width ? `<span class="slide-n">${m.height >= 2000 ? '4K' : m.height >= 1000 ? 'HD' : m.height + 'p'}${m.needsOptimize ? ' ⚠' : ''}</span>` : '');
      if (m.heavy || m.width == null) return icon(m.codec ? '' : 'analyse…');
      const k = 'v:' + m.file;
      requestThumb(k, () => videoThumb('/media/' + m.file));
      return thumbs.get(k) ? img(thumbs.get(k)) : icon();
    }
    case 'slides': {
      if (!m || m.status !== 'ready') return icon(m?.status === 'error' ? 'erreur' : 'conversion…');
      const n = S.live.comp?.slides?.[cue.id] || 1;
      const k = `s:${m.file}:${n}`;
      requestThumb(k, () => slideThumb(m.file, n));
      const tag = `<span class="slide-n">${n}/${m.pages}</span>`;
      return (thumbs.get(k) ? img(thumbs.get(k)) : `<span class="ico">📑</span>`) + tag;
    }
    case 'color': return `<div style="position:absolute;inset:0;background:${esc(cue.color || '#000')}"></div>`;
    case 'title': return `<div style="position:absolute;inset:0;${cue.transparent ? 'background:repeating-conic-gradient(#222 0% 25%,#181818 0% 50%) 50%/12px 12px' : 'background:radial-gradient(ellipse at top,#1e293b,#020617)'}"></div><span class="ttl" style="position:relative;color:${esc(cue.textColor || '#fff')}">${esc(cue.title || cue.name)}</span>`;
    case 'qr': return `<div style="position:absolute;inset:0;background:#1a1a1a"></div><img src="/api/qr.svg?text=${encodeURIComponent(cue.text || voteUrl || ' ')}" alt="" style="position:relative;width:auto;height:80%;background:#fff;padding:3px;border-radius:3px" draggable="false">`;
    case 'ndi': return icon(cue.source?.name?.replace(/^.*\((.*)\)$/, '$1') || '');
    case 'web': return icon(cue.url ? (() => { try { return new URL(cue.url).hostname; } catch { return ''; } })() : 'URL ?');
    case 'poll': return icon(S.polls.find((p) => p.id === cue.pollId)?.question || '');
    case 'guest': {
      const on = S.guests?.some((g) => g.id === cue.guestId);
      return icon(on ? 'en ligne' : 'hors ligne');
    }
    case 'window': return icon(cue.sourceName ? cue.sourceName.slice(0, 22) : 'à choisir');
    default: return icon();
  }
}

// ------------------------------------------------------------------ rendu
let renderT = null;
function scheduleRender() { if (!renderT) renderT = requestAnimationFrame(() => { renderT = null; if (S) renderAll(); }); }

function onState(state) {
  S = state;
  if (!selLayerId || !layerById(selLayerId)) selLayerId = S.comp.layers[S.comp.layers.length - 1]?.id;
  if (sel && (!layerById(sel.layerId) || sel.col >= S.comp.columns.length)) sel = null;
  renderAll();
}

function renderAll() {
  document.documentElement.style.setProperty('--cell-w', (S.settings.cellSize || 132) + 'px');
  keepGuests();
  if (document.activeElement !== $('#show-name')) $('#show-name').value = S.show.name;
  document.title = (PANEL ? (PANEL_NAMES[PANEL] || PANEL) + ' · ' : '') + S.show.name + ' — PresenThor';
  const c = S.clients;
  const nOut = Object.keys(c.outputs).length;
  $('#clients').textContent = `${nOut} écran${nOut > 1 ? 's' : ''} · ${c.audience} participant${c.audience > 1 ? 's' : ''}`;
  $('#blackout').classList.toggle('on', !!S.live.blackout);
  if (document.activeElement !== $('#master')) $('#master').value = S.comp.master ?? 1;
  const d = deckInfo(S);
  $('#deck').hidden = !d;
  if (d) $('#deck-label').textContent = `${d.cue.name} · ${d.slide}/${d.pages}`;
  outMon?.update(S);
  const active = Object.values(S.live.comp.active || {}).length;
  $('#out-info').textContent = S.live.blackout ? 'NOIR' : `${active} calque${active > 1 ? 's' : ''} actif${active > 1 ? 's' : ''}`;
  const cue = selCue();
  pvwMon?.update(S, cue ? describe(S, { cueId: cue.id, slide: S.live.comp.slides?.[cue.id] || 1 }) : { key: 'none', type: 'black' });
  $('#pvw-info').textContent = cue ? cue.name : 'Sélectionnez un clip';
  if (PANEL) return renderBrowser();
  renderGrid();
  renderTransport();
  renderProps();
  renderBrowser();
}

function renderGrid() {
  const comp = S.comp;
  const live = S.live.comp;
  const n = comp.columns.length;
  const g = $('#grid');
  g.style.gridTemplateColumns = `var(--head-w) repeat(${n}, var(--cell-w)) 34px`;
  let h = `<div class="corner"><button class="btn sm" data-act="clear-all" title="Vider tous les calques">✕ Tout</button></div>`;
  comp.columns.forEach((col, i) => {
    h += `<div class="colhead${live.column === i ? ' live' : ''}" data-col="${i}" title="Déclencher la colonne (touche ${i < 9 ? i + 1 : '—'}) · double-clic : renommer"><span class="num">${i + 1}</span> ${esc(col.name)}</div>`;
  });
  h += `<button class="btn sm" data-act="add-col" title="Ajouter une colonne">＋</button>`;
  for (const l of [...comp.layers].reverse()) {
    const idx = comp.layers.indexOf(l) + 1;
    h += `<div class="lhead${l.id === selLayerId ? ' sel' : ''}" data-layer-head="${l.id}">
      <div class="lrow"><span class="lname" title="${esc(l.name)}">${idx}. ${esc(l.name)}</span><span class="spacer"></span>
        <button class="lbtn x" data-lact="clear" title="Vider le calque">X</button>
        <button class="lbtn b${l.bypass ? ' on' : ''}" data-lact="bypass" title="Masquer (bypass)">B</button>
        <button class="lbtn s${l.solo ? ' on' : ''}" data-lact="solo" title="Solo">S</button></div>
      <div class="lrow"><input type="range" min="0" max="1" step="0.01" value="${l.opacity}" data-lop="opacity" title="Opacité du calque"></div>
      <div class="lrow"><select data-lop="blend" title="Mode de fusion">${sel_(BLENDS, l.blend)}</select></div></div>`;
    l.clips.forEach((cid, i) => {
      const cue = cid ? cueById(cid) : null;
      const isLive = cue && live.active?.[l.id] === cid;
      const isSel = sel && sel.layerId === l.id && sel.col === i;
      h += `<div class="cell${cue ? '' : ' empty'}${isLive ? ' live' : ''}${isSel ? ' sel' : ''}" data-layer="${l.id}" data-col="${i}"${cue ? ' draggable="true"' : ''}>
        <div class="thumb">${cue ? thumbHtml(cue) + `<span class="badge">${TYPE_LABEL[cue.type] || ''}</span>` : ''}</div>
        <div class="cname">${cue ? esc(cue.name) : '&nbsp;'}</div></div>`;
    });
    h += '<div></div>';
  }
  h += `<div class="addrow" style="grid-column: 1 / -1"><button class="btn sm" data-act="add-layer">＋ Calque</button>
    <span class="hint">Clic sur une vignette = déclencher · clic sur le nom = sélectionner · glisser = déplacer (Alt = copier) · clic droit = options · 1-9 = colonnes</span></div>`;
  patch(g, h);
}

function renderTransport() {
  const live = S.live.comp;
  let h = '';
  const d = deckInfo(S);
  if (d) h += `<div class="tp-row"><b>📑 ${esc(d.cue.name)}</b><button class="btn sm" data-act="deck-prev">◀</button><span class="t" style="min-width:50px;text-align:center">${d.slide} / ${d.pages}</span><button class="btn sm" data-act="deck-next">▶</button><span class="hint">télécommande / ← →</span></div>`;
  for (const l of [...S.comp.layers].reverse()) {
    const pb = live.pb?.[l.id];
    if (!pb) continue;
    h += `<div class="tp-row" data-tp="${l.id}"><b title="${esc(l.name)}">${esc(l.name)}</b>
      <button class="btn sm" data-act="pb-toggle" data-id="${l.id}">${pb.playing ? '⏸' : '▶'}</button>
      <button class="btn sm" data-act="pb-restart" data-id="${l.id}" title="Recommencer">⏮</button>
      <input type="range" min="0" max="100" step="0.1" value="0" data-seek="${l.id}"><span class="t" data-time="${l.id}"></span></div>`;
  }
  patch($('#transport'), h || '<span class="hint">Les clips vidéo en cours apparaîtront ici (lecture, pause, position).</span>');
}

// ------------------------------------------------------------------ propriétés
// Curseur : glisser (Maj = plus fin), molette pour ajuster, case pour saisir la valeur exacte,
// double-clic sur le libellé = valeur par défaut.
const DEFAULTS = { opacity: 1, volume: 1, master: 1, speed: 1, 'transform.x': 0, 'transform.y': 0, 'transform.scale': 1, 'transform.rotate': 0,
  'crop.t': 0, 'crop.b': 0, 'crop.l': 0, 'crop.r': 0, 'crop.feather': 0, 'key.similarity': 40, 'key.smoothness': 8, 'key.spill': 10 };
function sliderRow(label, bind, value, min, max, step, unit = '') {
  const key = bind.split(':')[1];
  return `<div class="slider"><span data-reset="${bind}" data-def="${DEFAULTS[key] ?? ''}" title="Double-clic : valeur par défaut">${label}</span>
    <input type="range" min="${min}" max="${max}" step="${step}" value="${value}" data-bind="${bind}" data-step="${step}">
    <input type="number" class="num" min="${min}" max="${max}" step="${step}" value="${fmt2(value)}" data-bind="${bind}">${unit ? `<i>${unit}</i>` : '<i></i>'}</div>`;
}
function transformBlock(target, t = {}) {
  return `<div class="box"><b>Position / taille</b>
    ${sliderRow('Position X', target + ':transform.x', t.x ?? 0, -1, 1, 0.005)}
    ${sliderRow('Position Y', target + ':transform.y', t.y ?? 0, -1, 1, 0.005)}
    ${sliderRow('Échelle', target + ':transform.scale', t.scale ?? 1, 0.05, 4, 0.01)}
    ${sliderRow('Rotation', target + ':transform.rotate', t.rotate ?? 0, -180, 180, 1, '°')}
    <div class="row"><button class="btn sm" data-act="reset-transform" data-target="${target}">Réinitialiser</button></div></div>`;
}
function effectsBlock(target, effects = [], mask = 'none') {
  return `<div class="box"><div class="box-head"><b>Effets</b><select data-add-fx="${target}"><option value="">＋ Ajouter un effet</option>${Object.entries(FX).map(([k, f]) => `<option value="${k}">${f.label}</option>`).join('')}</select></div>
    ${effects.map((e, i) => {
      const f = FX[e.type];
      return `<div class="fx"><input type="checkbox" data-fx-on="${target}:${i}"${e.on !== false ? ' checked' : ''}><span>${f.label}</span>
        ${f.min != null ? `<input type="range" min="${f.min}" max="${f.max}" step="${f.step}" value="${e.value}" data-fx-val="${target}:${i}"><output>${fmt2(e.value)}</output>` : '<span></span><span></span>'}
        <button class="btn sm ghost" data-act="fx-remove" data-target="${target}" data-i="${i}">✕</button></div>`;
    }).join('') || '<span class="hint">Aucun effet. Vous pouvez aussi glisser un effet depuis l\'onglet « Effets ».</span>'}
    ${field('Masque', `<select data-bind="${target}:mask">${sel_(MASKS, mask)}</select>`)}</div>`;
}

function renderProps(force = false) {
  for (const b of $('#prop-tabs').children) b.classList.toggle('active', b.dataset.ptab === ptab);
  const el = $('#props');
  let h = '';
  if (ptab === 'comp') {
    h = `${sliderRow('Master', 'comp:master', S.comp.master ?? 1, 0, 1, 0.01)}
      ${check('Télécommande : après la dernière diapo (ou sans présentation), passer à la colonne suivante', 'data-comp-clicker', S.comp.clickerColumns)}
      <div class="box"><b>${S.comp.layers.length} calques · ${S.comp.columns.length} colonnes</b>
        <div class="row wrap"><button class="btn sm" data-act="add-layer">＋ Calque</button><button class="btn sm" data-act="add-col">＋ Colonne</button>
        <button class="btn sm" data-act="clear-all">Vider tous les calques</button></div>
        <span class="hint">Le calque 1 est tout en bas de l'image ; chaque calque au-dessus se superpose avec son opacité et son mode de fusion.</span></div>`;
  } else if (ptab === 'layer') {
    const l = layerById(selLayerId);
    if (!l) h = '<p class="hint">Cliquez sur l\'en-tête d\'un calque.</p>';
    else {
      const idx = S.comp.layers.indexOf(l) + 1;
      h = `${field(`Calque ${idx} — nom`, `<input data-layer-name value="${esc(l.name)}">`)}
        ${sliderRow('Opacité', 'layer:opacity', l.opacity, 0, 1, 0.01)}
        ${sliderRow('Volume', 'layer:volume', l.volume ?? 1, 0, 1, 0.01)}
        <div class="grid2">${field('Mode de fusion', `<select data-bind="layer:blend">${sel_(BLENDS, l.blend)}</select>`)}
          ${field('Transition entre clips', `<select data-bind="layer:transitionMs" data-num>${sel_([[0, 'Cut'], [250, 'Fondu 0,25 s'], [500, 'Fondu 0,5 s'], [1000, 'Fondu 1 s'], [2000, 'Fondu 2 s'], [4000, 'Fondu 4 s']], l.transitionMs || 0)}</select>`)}</div>
        <div class="box"><b>Destination (routage)</b>
          ${check('Composition principale', 'data-route="main"', l.mainOut !== false)}
          ${S.outputs.map((o) => check(`Écran « ${esc(o.name)} »`, `data-route="${o.id}"`, (l.auxOutputs || []).includes(o.id))).join('')}
          <span class="hint">Cochez un écran pour y envoyer ce calque. Décochez « Composition principale » pour qu'il n'apparaisse QUE sur ces écrans (sortie AUX : logo latéral, retour particulier…). Une sortie réglée sur « AUX » n'affiche que les calques qui lui sont envoyés.</span></div>
        ${transformBlock('layer', l.transform)}
        ${effectsBlock('layer', l.effects, l.mask)}
        <div class="row"><button class="btn sm" data-act="layer-up">Monter ▲</button><button class="btn sm" data-act="layer-down">Descendre ▼</button>
          <span class="spacer"></span><button class="btn sm danger" data-act="layer-remove">Supprimer le calque</button></div>`;
    }
  } else {
    h = clipProps();
  }
  patch(el, h, force);
}

function clipProps() {
  const c = selCue();
  if (!sel) return '<p class="hint">Cliquez sur le nom d\'un clip dans la grille pour le régler (un clic sur la vignette le déclenche).</p>';
  if (!c) return `<p class="hint">Case vide (calque « ${esc(layerById(sel.layerId)?.name)} », colonne ${sel.col + 1}). Glissez-y un média ou une source, ou double-cliquez un élément du navigateur.</p>`;
  const f = (k) => `data-cue-field="${k}"`;
  const media = mediaById(c.mediaId);
  const images = S.media.filter((m) => m.kind === 'image');
  let h = `<div class="row">${field('Nom du clip', `<input ${f('name')} value="${esc(c.name)}">`)}</div>`;
  if (['slides', 'video', 'image', 'audio'].includes(c.type)) {
    h += field('Média', `<select ${f('mediaId')}>${sel_([['', '—'], ...S.media.filter((m) => (m.kind === 'office' ? 'slides' : m.kind) === c.type).map((m) => [m.id, m.name])], c.mediaId)}</select>`);
  }
  if (c.type === 'slides' && media?.status === 'ready') {
    const cur = S.live.comp.slides?.[c.id] || 1;
    h += `<div class="box"><div class="box-head"><b>Diapositives</b><span class="row"><button class="btn sm" data-act="slide-delta" data-d="-1">◀</button><span>${cur} / ${media.pages}</span><button class="btn sm" data-act="slide-delta" data-d="1">▶</button></span></div>
      <div class="slides-strip">${Array.from({ length: media.pages }, (_, i) => {
        const k = `s:${media.file}:${i + 1}`;
        requestThumb(k, () => slideThumb(media.file, i + 1));
        return `<div class="thumb${cur === i + 1 ? ' cur' : ''}" data-slide="${i + 1}">${thumbs.get(k) ? `<img src="${thumbs.get(k)}" alt="">` : `<span class="ico">${i + 1}</span>`}<span class="slide-n">${i + 1}</span></div>`;
      }).join('')}</div>
      ${field('Rendu', `<select ${f('engine')}>${sel_([['', `Images${media.videos?.length ? ` + ${media.videos.length} vidéo(s) intégrée(s)` : ''}`], ['powerpoint', 'PowerPoint natif (animations) — app Mac/PC + PowerPoint']], c.engine || '')}</select>`)}
      ${c.engine === 'powerpoint' ? `<span class="hint">${!desktop ? 'Disponible dans l\'app Mac / PC.' : S.nativeInfo?.available ? `${esc(S.nativeInfo.app)} pilote le diaporama.` : 'PowerPoint non détecté : les images sont utilisées.'}${S.live.native?.cueId === c.id && S.live.native.error ? ' Erreur : ' + esc(S.live.native.error) : ''}</span>` : ''}
      ${media.notes?.some(Boolean) ? '<span class="hint">Notes du présentateur importées : visibles sur le retour présentateur et la télécommande.</span>' : ''}</div>`;
  }
  if (c.type === 'video' || c.type === 'audio') {
    const dur = clipDuration(c);
    const inP = +c.inPoint || 0, outP = c.outPoint > inP ? +c.outPoint : dur;
    const pct = (t) => (dur ? Math.max(0, Math.min(100, (t / dur) * 100)) : 0);
    h += `<div class="box timeline-box"><div class="box-head"><b>Timeline</b><span class="hint" data-tl-now="${c.id}"></span></div>
      ${dur ? `<div class="tl" data-tl="${c.id}" data-dur="${dur}">
        <div class="tl-track">
          <div class="tl-out" style="left:0;width:${pct(inP)}%"></div><div class="tl-out" style="left:${pct(outP)}%;right:0"></div>
          <div class="tl-range" style="left:${pct(inP)}%;width:${pct(outP) - pct(inP)}%">
            ${c.fadeIn ? `<i class="tl-fin" style="width:${(c.fadeIn / Math.max(0.01, outP - inP)) * 100}%"></i>` : ''}
            ${c.fadeOut ? `<i class="tl-fout" style="width:${(c.fadeOut / Math.max(0.01, outP - inP)) * 100}%"></i>` : ''}</div>
          <span class="tl-h" data-tl-h="in" style="left:${pct(inP)}%" title="Point de départ (glisser)"></span>
          <span class="tl-h out" data-tl-h="out" style="left:${pct(outP)}%" title="Point de fin (glisser)"></span>
          <span class="tl-head" data-tl-head hidden></span></div>
        <div class="tl-times"><span>0:00</span><span>${fmtTime(dur * 1000)}</span></div></div>`
        : '<span class="hint">Durée en cours d\'analyse…</span>'}
      <div class="grid4">
        ${field('Départ (s)', `<input type="number" min="0" step="0.1" ${f('inPoint')} data-type="number" value="${fmt2(inP)}">`)}
        ${field('Fin (s)', `<input type="number" min="0" step="0.1" ${f('outPoint')} data-type="number" value="${c.outPoint ? fmt2(c.outPoint) : ''}" placeholder="${dur ? fmt2(dur) : 'fin'}">`)}
        ${field('Fondu entrée (s)', `<input type="number" min="0" step="0.1" ${f('fadeIn')} data-type="number" value="${fmt2(c.fadeIn || 0)}">`)}
        ${field('Fondu sortie (s)', `<input type="number" min="0" step="0.1" ${f('fadeOut')} data-type="number" value="${fmt2(c.fadeOut || 0)}">`)}</div>
      <div class="row wrap"><button class="btn sm" data-act="tl-mark" data-k="inPoint" title="Le point de départ prend la position actuelle">⇤ Départ ici</button>
        <button class="btn sm" data-act="tl-mark" data-k="outPoint" title="Le point de fin prend la position actuelle">Fin ici ⇥</button>
        <button class="btn sm" data-act="tl-reset">Tout le média</button>
        <span class="hint">Cliquez dans la barre pour vous déplacer (clip à l'écran).</span></div></div>`;
    h += `<div class="box"><b>Lecture</b>
      ${field('Fin du clip', `<select ${f('loopMode')}>${sel_(LOOP_MODES, c.loopMode || 'loop')}</select>`)}
      ${check('Démarrer automatiquement au déclenchement', `${f('autoplay')} data-type="bool"`, c.autoplay !== false)}
      ${sliderRow('Vitesse', 'clip:speed', c.speed ?? 1, 0.1, 4, 0.05, '×')}
      ${sliderRow('Volume', 'clip:volume', c.volume ?? 1, 0, 1, 0.01)}</div>`;
  }
  if (c.type === 'web') {
    h += field('URL (Zoom, Teams, Meet, sondage, site…)', `<input type="url" ${f('url')} value="${esc(c.url || '')}" placeholder="https://…">`);
    h += field('Zoom de la page', `<select ${f('zoom')} data-type="number">${sel_([[0.5, '50 %'], [0.75, '75 %'], [1, '100 %'], [1.25, '125 %'], [1.5, '150 %'], [2, '200 %']], c.zoom ?? 1)}</select>`);
    h += check('Ne pas charger la page dans les aperçus de la régie (visio, page lourde)', `${f('noPreview')} data-type="bool"`, c.noPreview);
    h += `<span class="hint">${desktop ? 'Dans l\'app, la page s\'ouvre dans un vrai navigateur intégré. Si elle ne charge pas, la raison s\'affiche sur l\'écran.' : 'Dans un navigateur, beaucoup de sites refusent d\'être intégrés : utilisez l\'app Mac / PC.'}</span>`;
  }
  if (c.type === 'camera') {
    h += field('Source (webcam, carte d\'acquisition HDMI/SDI, NDI virtuel…)', `<select ${f('deviceId')}>${sel_([['', 'Par défaut'], ...cameras.map((d) => [d.deviceId, d.label || 'Caméra'])], c.deviceId)}</select>`);
    h += `<button class="btn sm" data-act="cams">Détecter les sources</button>${check('Inclure l\'audio de la source', `${f('withAudio')} data-type="bool"`, c.withAudio)}`;
  }
  if (c.type === 'ndi') {
    const list = S.ndi?.sources || [];
    const cur = c.source?.name;
    h += field('Source NDI', `<select data-ndi-source>${sel_([['', '—'], ...(cur && !list.some((x) => x.name === cur) ? [[cur, cur + ' (absente)']] : []), ...list.map((x) => [x.name, x.name])], cur)}</select>`);
    h += `<span class="hint">${S.ndi?.available ? `${list.length} source(s) sur le réseau.` : 'Module NDI indisponible.'} ${desktop ? '' : 'L\'image NDI s\'affiche dans les sorties de l\'app Mac / PC.'}</span>`;
    h += check('Son de la source NDI', `${f('withAudio')} data-type="bool-true"`, c.withAudio !== false);
  }
  if (c.type === 'title') {
    h += field('Texte', `<input ${f('title')} value="${esc(c.title || '')}">`) + field('Sous-texte', `<input ${f('subtitle')} value="${esc(c.subtitle || '')}">`);
    h += `<div class="row">${field('Couleur du texte', `<input type="color" ${f('textColor')} value="${esc(c.textColor || '#ffffff')}">`)}${check('Fond transparent', `${f('transparent')} data-type="bool"`, c.transparent)}</div>`;
    h += field('Image de fond', `<select ${f('bgMediaId')}>${sel_([['', 'Dégradé'], ...images.map((m) => [m.id, m.name])], c.bgMediaId)}</select>`);
  }
  if (c.type === 'qr') {
    h += field('Lien du QR code (vide = page de vote du public)', `<input ${f('text')} value="${esc(c.text || '')}" placeholder="${esc(voteUrl)}">`);
    h += field('Légende', `<input ${f('caption')} value="${esc(c.caption || '')}" placeholder="Scannez pour participer">`);
    h += check('Fond transparent (à superposer)', `${f('transparent')} data-type="bool"`, c.transparent);
  }
  if (c.type === 'color') h += field('Couleur', `<input type="color" ${f('color')} value="${esc(c.color || '#000000')}">`);
  if (c.type === 'qa') {
    h += field('Titre quand aucune question n\'est affichée', `<input ${f('title')} value="${esc(c.title || '')}" placeholder="Posez vos questions">`);
    h += check('Fond transparent', `${f('transparent')} data-type="bool"`, c.transparent);
  }
  if (c.type === 'window') {
    h += `<div class="box"><b>${esc(c.sourceName || 'Aucune fenêtre choisie')}</b>
      ${desktop?.captureSources ? `<button class="btn primary" data-act="pick-window">Choisir la fenêtre ou l'écran…</button>` : '<span class="hint">Capture disponible dans l\'app Mac / PC.</span>'}
      ${check('Capturer aussi le son de l\'ordinateur', `${f('withAudio')} data-type="bool"`, c.withAudio)}
      <span class="hint">Son : Windows uniquement (son global de l'ordinateur). Sur Mac, autorisez « Enregistrement de l'écran » pour PresenThor dans les Réglages système. Si le logiciel est relancé, la fenêtre est retrouvée par son nom.</span></div>`;
  }
  if (c.type === 'guest') {
    const g = S.guests?.find((x) => x.id === c.guestId);
    h += `<div class="box"><b>${g ? '🟢 ' + esc(g.name) + ' est connecté' : '⚪ Invité hors ligne'}</b>
      ${field('Invité', `<select ${f('guestId')}>${sel_([...(S.guests || []).map((x) => [x.id, x.name]), ...(g ? [] : [[c.guestId, (c.name || 'Invité') + ' (hors ligne)']])], c.guestId)}</select>`)}
      ${sliderRow('Volume', 'clip:volume', c.volume ?? 1, 0, 1, 0.01)}
      ${check('Remplir le cadre (recadrer)', `${f('fill')} data-type="bool"`, c.fill)}
      <span class="hint">Le son de l'invité sort sur les sorties où « Son » est coché. Le retour vers l'invité se règle dans l'onglet Public.</span></div>`;
  }
  if (c.type === 'poll') h += field('Sondage', `<select ${f('pollId')}>${sel_([['', '—'], ...S.polls.map((p) => [p.id, p.question])], c.pollId)}</select>`);
  if (c.type === 'scene') h += `<button class="btn" data-act="scene-edit">Éditer la scène</button>`;
  if (['video', 'image', 'slides', 'camera', 'ndi', 'web', 'scene'].includes(c.type)) {
    h += field('Cadrage', `<select ${f('fit')}>${sel_([['', 'Entier (bandes noires)'], ['cover', 'Remplir (recadré)'], ['fill', 'Étirer']], c.fit || '')}</select>`);
  }
  if (!['audio', 'black', 'color'].includes(c.type)) {
    const cr = c.crop || {};
    h += `<div class="box"><div class="box-head"><b>Rogner</b>
        <select data-crop-opt="mode">${sel_([['', 'Découper (l\'image reste en place)'], ['fill', 'Recadrer et agrandir pour remplir']], cr.mode || '')}</select></div>
      ${sliderRow('Haut', 'clip:crop.t', cr.t || 0, 0, 49, 0.5, '%')}${sliderRow('Bas', 'clip:crop.b', cr.b || 0, 0, 49, 0.5, '%')}
      ${sliderRow('Gauche', 'clip:crop.l', cr.l || 0, 0, 49, 0.5, '%')}${sliderRow('Droite', 'clip:crop.r', cr.r || 0, 0, 49, 0.5, '%')}
      ${sliderRow('Adoucir les bords', 'clip:crop.feather', cr.feather || 0, 0, 25, 0.5, '%')}
      <div class="row wrap">${check('Lier haut et bas', 'data-crop-opt="linkV"', cr.linkV)}${check('Lier gauche et droite', 'data-crop-opt="linkH"', cr.linkH)}
        <span class="spacer"></span><button class="btn sm" data-act="crop-reset">Annuler le rognage</button></div></div>`;
  }
  if (['video', 'image', 'camera', 'ndi', 'guest', 'window'].includes(c.type)) {
    const k = c.key || {};
    h += `<div class="box"><div class="box-head"><b>Incrustation (fond vert)</b>${check('Activer', 'data-key-opt="on"', k.on)}</div>
      <div class="row wrap">
        <input type="color" data-key-opt="color" value="${esc(k.color || '#00ff00')}" style="width:46px;height:28px;padding:2px">
        <button class="btn sm" data-act="key-color" data-color="#00ff00">Vert</button><button class="btn sm" data-act="key-color" data-color="#0047bb">Bleu</button>
        ${'EyeDropper' in window ? '<button class="btn sm" data-act="key-pick" title="Cliquez ensuite sur la couleur à retirer, par ex. dans l\'aperçu">🎯 Pipette</button>' : ''}</div>
      ${sliderRow('Similarité', 'clip:key.similarity', k.similarity ?? 40, 0, 100, 1)}
      ${sliderRow('Adoucissement', 'clip:key.smoothness', k.smoothness ?? 8, 0, 100, 1)}
      ${sliderRow('Anti-débordement', 'clip:key.spill', k.spill ?? 10, 0, 100, 1)}
      <span class="hint">Retire une couleur unie (fond vert, bleu ou autre) : seul le sujet reste, posé sur les calques du dessous. Augmentez « Similarité » si du fond reste visible, baissez-la si le sujet se troue.</span></div>`;
  }
  h += transformBlock('clip', c.transform);
  h += effectsBlock('clip', c.effects, c.mask);
  h += field('Notes pour le présentateur', `<textarea ${f('notes')}>${esc(c.notes || '')}</textarea>`);
  h += `<div class="row"><button class="btn primary" data-act="cell-trigger">Déclencher ▶</button><span class="spacer"></span>
    <button class="btn sm" data-act="cell-unset">Retirer de la case</button><button class="btn sm danger" data-act="cue-delete">Supprimer</button></div>`;
  return h;
}

// ------------------------------------------------------------------ timeline (vidéo / son)
function clipDuration(c) {
  const m = mediaById(c.mediaId);
  if (m?.duration) return m.duration;
  const v = findClipVideo(c.id) || (selCue()?.id === c.id ? pvwMon?.current?.video : null);
  return v?.duration && isFinite(v.duration) ? v.duration : 0;
}
// Vidéo du clip dans le moniteur de sortie (position réelle à l'écran).
function findClipVideo(cueId) {
  for (const [layerId, L] of outMon?.layers || []) if (S.live.comp.active?.[layerId] === cueId && L.stage.current?.video) return L.stage.current.video;
  return null;
}
function clipLayer(cueId) { return Object.entries(S.live.comp.active || {}).find(([, c]) => c === cueId)?.[0] || null; }
function clipPosition(c) {
  const v = findClipVideo(c.id);
  if (v) return v.currentTime;
  if (selCue()?.id === c.id && pvwMon?.current?.video) return pvwMon.current.video.currentTime;
  return null;
}
let tlDrag = null;
document.addEventListener('pointerdown', (e) => {
  const tl = e.target.closest('[data-tl]');
  if (!tl) return;
  const c = cueById(tl.dataset.tl);
  const dur = Number(tl.dataset.dur);
  const track = tl.querySelector('.tl-track').getBoundingClientRect();
  const at = (x) => Math.max(0, Math.min(dur, ((x - track.left) / track.width) * dur));
  const h = e.target.closest('[data-tl-h]');
  if (h) {
    // Glisser une poignée de départ / fin.
    e.preventDefault();
    tlDrag = { el: h, key: h.dataset.tlH === 'in' ? 'inPoint' : 'outPoint', value: null };
    h.setPointerCapture(e.pointerId);
    const move = (ev) => { const t = at(ev.clientX); tlDrag.value = t; h.style.left = (t / dur) * 100 + '%'; tl.closest('.box').querySelector('[data-tl-now]').textContent = (tlDrag.key === 'inPoint' ? 'Départ ' : 'Fin ') + fmtTime(t * 1000); };
    const up = () => {
      h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', up);
      const v = tlDrag.value; const key = tlDrag.key; tlDrag = null;
      if (v != null) send({ type: 'cue.update', id: c.id, patch: { [key]: Math.round(v * 100) / 100 } });
      renderProps(true);
    };
    h.addEventListener('pointermove', move); h.addEventListener('pointerup', up);
    return;
  }
  // Clic dans la barre : déplacement dans le média (si le clip est à l'écran).
  const layerId = clipLayer(c.id);
  if (!layerId || !S.live.comp.pb?.[layerId]) return toast('Déclenchez le clip pour vous déplacer dans le média');
  const t = at(e.clientX);
  send({ type: 'comp.pb.seek', layerId, time: Math.max(0, (t - (+c.inPoint || 0)) / (c.speed || 1)) });
});

// ------------------------------------------------------------------ navigateur
function sourceTemplates() {
  const list = [
    ['title', 'Texte / titre', { type: 'title', title: 'Titre', name: 'Titre' }],
    ['title', 'Texte transparent', { type: 'title', title: 'Texte', transparent: true, name: 'Texte' }],
    ['color', 'Couleur unie', { type: 'color', color: '#c48626', name: 'Couleur' }],
    ['qr', 'QR code (vote du public)', { type: 'qr', transparent: true, caption: 'Scannez pour participer', name: 'QR vote' }],
    ['qr', 'QR code (lien)', { type: 'qr', text: 'https://', transparent: true, name: 'QR code' }],
    ['web', 'Page web / visio', { type: 'web', url: '', name: 'Page web' }],
    ['camera', 'Caméra / capture HDMI', { type: 'camera', name: 'Caméra' }],
    ['window', 'Fenêtre ou écran de l\'ordinateur', { type: 'window', name: 'Fenêtre' }],
    ['qa', 'Questions du public', { type: 'qa', name: 'Questions' }],
    ['scene', 'Scène (composition libre)', { type: 'scene', layers: [], name: 'Scène' }],
    ['black', 'Noir', { type: 'black', name: 'Noir' }],
  ];
  for (const g of S.guests || []) list.push(['guest', 'Invité : ' + g.name, { type: 'guest', guestId: g.id, name: g.name }]);
  for (const n of S.ndi?.sources || []) list.push(['ndi', n.name, { type: 'ndi', source: n, name: n.name }]);
  for (const p of S.polls) list.push(['poll', 'Sondage : ' + p.question, { type: 'poll', pollId: p.id, name: 'Sondage : ' + p.question }]);
  return list;
}

function renderBrowser(force = false) {
  if (!S) return;
  for (const b of $('#br-tabs').children) b.classList.toggle('active', b.dataset.btab === btab);
  $('#popout').title = `Ouvrir « ${PANEL_NAMES[btab] || btab} » dans une fenêtre séparée (autre écran, plein écran…)`;
  const el = $('#browser');
  const html = { media: tabMedia, sources: tabSources, fx: tabFx, outputs: tabOutputs, public: tabPublic, live: tabLive, settings: tabSettings }[btab]();
  patch(el, html, force && !isEditing(el));
  if (btab === 'public' || btab === 'settings') fillQr(el);
  if (btab === 'public') attachGuestPreviews();
}

function tabMedia() {
  return `<div class="row"><button class="btn primary" data-act="import">Importer des fichiers</button><span class="hint">ou glissez-les sur une case de la grille</span></div>
    <div class="items">${S.media.map((m) => {
      const kind = m.kind === 'office' ? 'slides' : m.kind;
      let meta = { video: 'Vidéo', image: 'Image', audio: 'Audio', slides: `${m.pages || '?'} diapos` }[kind] || '';
      let cls = '';
      if (m.status === 'converting' || m.status === 'processing') { meta = 'Conversion' + (m.converter ? ` (${m.converter})` : '') + '…'; cls = 'busy'; }
      if (m.status === 'error') { meta = m.error; cls = 'err'; }
      if (kind === 'video' && m.width) meta = `${m.width}×${m.height} · ${(m.codec || '').toUpperCase()}${m.duration ? ' · ' + fmtTime(m.duration * 1000) : ''}`;
      if (m.optimize?.progress != null) { meta = `Optimisation… ${m.optimize.progress} %`; cls = 'busy'; }
      if (m.optimize?.error) { meta = 'Optimisation échouée'; cls = 'err'; }
      const optFull = kind === 'video' && !m.optimize?.progress && m.needsOptimize;
      const optHd = kind === 'video' && !m.optimize?.progress && m.heavy && (m.height || 0) > 1100;
      const fake = { id: 'media:' + m.id, type: kind, mediaId: m.id, name: m.name };
      return `<div class="item" draggable="true" data-media="${m.id}" title="${esc(m.name)}${m.status === 'error' ? ' — ' + esc(m.error) : ''}"><div class="thumb">${m.status === 'ready' ? thumbHtml(fake) : `<span class="ico">${ICONS[kind] || '📄'}</span>`}</div>
        <div class="cname">${esc(m.name)}</div><div class="meta ${cls}">${esc(meta)}</div>
        ${optFull || optHd ? `<div class="row wrap opt">${optFull ? `<button class="btn sm primary" data-act="media-optimize" data-id="${m.id}" title="Format ${esc((m.codec || '').toUpperCase())} : réencodage en H.264, lisible partout, même résolution">⚡ Optimiser</button>` : ''}
          ${optHd ? `<button class="btn sm" data-act="media-optimize" data-id="${m.id}" data-h="1080" title="Version 1080p : beaucoup plus légère à lire (idéal si la machine peine en 4K)">⚡ 1080p</button>` : ''}</div>` : ''}
        <button class="btn sm del" data-act="media-remove" data-id="${m.id}" title="Supprimer">✕</button></div>`;
    }).join('') || '<p class="hint">Aucun média. Importez PowerPoint, Keynote, PDF, vidéos, images, sons.</p>'}</div>`;
}

function tabSources() {
  return `<span class="hint">Glissez une source sur une case, ou double-cliquez pour la placer dans la case sélectionnée.</span>
    ${sourceTemplates().map(([t, label, tpl], i) => `<div class="list-item" draggable="true" data-src="${i}"><span class="ico">${ICONS[t]}</span><span>${esc(label)}</span></div>`).join('')}`;
}

function tabFx() {
  return `<span class="hint">Glissez un effet sur l'en-tête d'un calque (tout le calque) ou sur un clip.</span>
    ${Object.entries(FX).map(([k, f]) => `<div class="list-item" draggable="true" data-fx="${k}"><span class="ico">✨</span><span>${f.label}</span></div>`).join('')}
    <h2>Masques</h2>
    ${MASKS.slice(1).map(([k, l]) => `<div class="list-item" draggable="true" data-mask="${k}"><span class="ico">◐</span><span>${l}</span></div>`).join('')}
    <span class="hint">Astuce : une image PNG avec transparence (ex. masque ovale) sur un calque du dessus fait office de cache.</span>`;
}

function outputSources() {
  return [['program', 'Composition (sortie principale)'], ['clean', 'Composition sans bandeau'], ['aux', 'AUX : uniquement les calques envoyés à cet écran'], ...S.comp.layers.map((l) => ['layer:' + l.id, 'Calque seul : ' + l.name]),
    ['presenter', 'Retour présentateur'], ['multiview', 'Multiview régie'], ...S.cues.map((c) => ['cue:' + c.id, 'Clip fixe : ' + c.name])];
}

function tabOutputs() {
  let h = `<p class="hint">${desktop ? 'Choisissez l\'écran puis « Plein écran ». Pour revenir : Échap ou double-clic dans la sortie, ou Ctrl+Alt+F (⌘+Alt+F sur Mac) depuis n\'importe où.' : 'Ouvrez le lien de la sortie sur l\'ordinateur relié à l\'écran.'}</p>`;
  for (const o of S.outputs) {
    const n = S.clients.outputs[o.id] || 0;
    const url = `${location.origin}/output/?id=${o.id}`;
    const os = outState[o.id];
    h += `<div class="box" data-out="${o.id}">
      <div class="box-head"><span class="row"><span class="dot${n ? ' on' : ''}"></span><input data-out-field="name" value="${esc(o.name)}" style="font-weight:700"></span>
        <button class="btn sm ghost" data-act="out-remove" data-id="${o.id}" title="Supprimer la sortie">✕</button></div>
      ${field('Contenu', `<select data-out-field="source">${sel_(outputSources(), o.source)}</select>`)}
      <div class="row wrap">${check('Son', 'data-out-field="audio" data-type="bool"', o.audio)} ${check('Mire', 'data-out-field="testPattern" data-type="bool"', o.testPattern)}
        <button class="btn sm" data-act="out-mapping" data-id="${o.id}">Mapping…</button>
        ${o.zones?.length ? `<span class="tag">${o.zones.length} zone(s)${o.mapping ? '' : ' off'}</span>` : ''}
        ${desktop?.ndi ? check('NDI', 'data-out-field="ndi" data-type="bool"', o.ndi) : ''}</div>
      ${desktop ? `<div class="row"><select data-out-display="${o.id}">${sel_(displays.map((d) => [d.id, d.label]), o.displayId ?? displays.find((d) => !d.primary)?.id ?? displays[0]?.id)}</select>
          ${os?.open ? `<button class="btn sm ${os.fullscreen ? '' : 'primary'}" data-act="out-fs" data-id="${o.id}" data-on="${os.fullscreen ? 0 : 1}">${os.fullscreen ? 'Fenêtre' : 'Plein écran'}</button><button class="btn sm" data-act="out-close" data-id="${o.id}">Fermer</button>`
            : `<button class="btn sm primary" data-act="out-open" data-id="${o.id}">Plein écran</button><button class="btn sm" data-act="out-open-win" data-id="${o.id}">Fenêtre</button>`}</div>`
        : `<div class="row"><button class="btn sm primary" data-act="out-window" data-id="${o.id}">Ouvrir</button><button class="btn sm" data-act="copy" data-text="${esc(url)}">Copier le lien</button></div>`}
      ${o.ndi && S.ndiOut?.[o.id] ? `<span class="hint">NDI : ${esc(S.ndiOut[o.id])}</span>` : ''}
    </div>`;
  }
  h += `<div class="row"><button class="btn" data-act="out-add">＋ Ajouter une sortie</button>${desktop ? '<button class="btn" data-act="displays-identify">Identifier les écrans</button>' : ''}</div>`;
  return h;
}

function tabLive() {
  const t = S.timer, o = S.live.overlay;
  return `<div class="box"><b>Message au présentateur</b>
      <textarea id="msg-text" placeholder="Ex. : Il reste 5 minutes">${esc(S.message?.text || '')}</textarea>
      <div class="row wrap"><button class="btn primary" data-act="msg-send">Envoyer</button><button class="btn" data-act="msg-clear">Effacer</button>
      ${['5 min', 'Plus fort', 'Questions', 'Conclure'].map((q) => `<button class="btn sm" data-act="msg-quick" data-text="${q}">${q}</button>`).join('')}</div></div>
    <div class="box"><b>Bandeau (lower-third)</b>
      <input id="lt-text" placeholder="Nom de l'intervenant" value="${esc(o?.text || '')}">
      <input id="lt-sub" placeholder="Fonction / société" value="${esc(o?.sub || '')}">
      <div class="row"><button class="btn primary" data-act="lt-show">Afficher</button><button class="btn" data-act="lt-hide"${o ? '' : ' disabled'}>Masquer</button></div></div>
    <div class="box"><b>Chronomètre présentateur</b>
      <div class="grid2">${field('Mode', `<select id="timer-mode">${sel_([['down', 'Compte à rebours'], ['up', 'Chronomètre']], t.mode)}</select>`)}
      ${field('Durée (min)', `<input id="timer-min" type="number" min="0" step="1" value="${Math.round(t.duration / 60000)}">`)}</div>
      <div class="row wrap"><button class="btn" data-act="timer-apply">Appliquer</button>${[5, 10, 15, 20, 30, 45].map((m) => `<button class="btn sm" data-act="timer-preset" data-min="${m}">${m}′</button>`).join('')}</div></div>`;
}

function tabPublic() {
  const kinds = [['choice', 'Choix unique'], ['multi', 'Choix multiples'], ['rating', 'Note de 1 à 5'], ['words', 'Nuage de mots']];
  const guests = S.guests || [];
  const rs = retSettings();
  let h = `<div class="box"><div class="box-head"><b>Visio : intervenants à distance</b><button class="btn sm primary" data-act="guest-copy">Copier le lien invité</button></div>
    <span class="hint">L'intervenant ouvre le lien dans son navigateur (caméra + micro, partage d'écran possible). Il apparaît ici, puis dans Sources pour le mettre à l'écran.</span>
    <div class="guests">${guests.map((g) => `<div class="guest"><video data-guest="${g.id}" autoplay muted playsinline></video>
      <div class="row"><b>${esc(g.name)}</b><span class="spacer"></span><button class="btn sm primary" data-act="guest-place" data-id="${g.id}">À la grille</button></div></div>`).join('') || '<span class="hint">Aucun invité connecté.</span>'}</div>
    <b>Retour vers les invités</b>
    <div class="grid2">${field('Son envoyé (console, micro…)', `<select data-ret="audio">${sel_([['', 'Aucun'], ...audioInputs.map((d) => [d.deviceId, d.label || 'Entrée audio'])], rs.audio)}</select>`)}
      ${field('Image envoyée', `<select data-ret="video">${sel_([['', 'Aucune (ils voient la diffusion recomposée)'], ...S.outputs.filter(() => desktop).map((o) => ['out:' + o.id, 'Sortie : ' + o.name]), ...cameras.map((d) => ['cam:' + d.deviceId, 'Caméra : ' + (d.label || 'caméra')])], rs.video)}</select>`)}</div>
    <span class="hint">${desktop ? 'Une sortie doit être ouverte pour être envoyée. ' : ''}Pour éviter l'écho, envoyez un mix sans la voix de l'invité (mix-minus) et demandez-lui un casque.</span></div>
    `;
  h += `<div class="box"><div class="row"><img class="qr" data-qr="vote" alt=""><div><b>Lien participants</b><div class="link"></div>
    <p class="hint">${S.clients.audience} connecté(s)</p></div></div></div>
    <div class="box"><b>Nouveau sondage</b><input id="poll-q" placeholder="Votre question"><select id="poll-kind">${sel_(kinds, 'choice')}</select>
    <textarea id="poll-opts" placeholder="Une réponse par ligne">Oui\nNon</textarea><button class="btn primary" data-act="poll-create">Créer</button></div>`;
  for (const p of S.polls) {
    const open = S.activePollId === p.id;
    const r = p.results || {};
    const labels = p.kind === 'rating' ? ['1★', '2★', '3★', '4★', '5★'] : p.options;
    const bars = p.kind === 'words' ? (r.words || []).slice(0, 8).map(([w, n]) => `<div class="mini-bar"><span>${esc(w)}</span><span></span><span>${n}</span></div>`).join('')
      : labels.map((l, i) => { const pc = r.total ? Math.round(((r.counts?.[i] || 0) / r.total) * 100) : 0; return `<div class="mini-bar"><span>${esc(l)}</span><span><i style="width:${pc}%"></i></span><span>${pc}%</span></div>`; }).join('');
    h += `<div class="box"><div class="box-head"><b>${esc(p.question)}</b><span class="hint">${r.total || 0} rép.</span></div><div class="mini-bars">${bars}</div>
      <div class="row wrap"><button class="btn sm ${open ? 'on' : 'primary'}" data-act="poll-open" data-id="${p.id}">${open ? 'Fermer le vote' : 'Ouvrir le vote'}</button>
        <label class="check"><input type="checkbox" data-poll="${p.id}" data-poll-field="showResults"${p.showResults ? ' checked' : ''}> Résultats</label>
        <button class="btn sm" data-act="poll-place" data-id="${p.id}">Ajouter à la grille</button><button class="btn sm" data-act="poll-reset" data-id="${p.id}">RAZ</button>
        <button class="btn sm ghost" data-act="poll-remove" data-id="${p.id}">✕</button></div></div>`;
  }
  const order = { shown: 0, approved: 1, pending: 2, done: 3, rejected: 4 };
  const qs = [...S.questions].sort((a, b) => order[a.status] - order[b.status] || a.at - b.at);
  h += `<div class="box"><div class="box-head"><b>Questions du public</b><button class="btn sm ${S.qa.open ? 'on' : ''}" data-act="qa-toggle">${S.qa.open ? 'Fermer' : 'Ouvrir'} la saisie</button></div>
    ${qs.map((q) => `<div class="q ${q.status}"><div>${esc(q.text)}</div><small>${esc(q.author || 'Anonyme')} · ${{ pending: 'à modérer', approved: 'validée', shown: 'À L\'ÉCRAN', done: 'traitée', rejected: 'rejetée' }[q.status]}</small>
      <div class="row">${q.status !== 'shown' ? `<button class="btn sm primary" data-act="qa-set" data-id="${q.id}" data-status="shown">À l'écran</button>` : `<button class="btn sm" data-act="qa-set" data-id="${q.id}" data-status="done">Retirer</button>`}
      ${q.status === 'pending' ? `<button class="btn sm" data-act="qa-set" data-id="${q.id}" data-status="approved">Valider</button>` : ''}
      ${q.status !== 'rejected' ? `<button class="btn sm ghost" data-act="qa-set" data-id="${q.id}" data-status="rejected">Rejeter</button>` : ''}</div></div>`).join('') || '<p class="hint">Aucune question. Placez une source « Questions du public » dans la grille pour les afficher.</p>'}</div>`;
  return h;
}

function tabSettings() {
  const s = S.settings;
  const conv = info.converters || [];
  return `${field('Couleur d\'accent (sondages, bandeaux)', `<input type="color" data-set-field="accent" value="${esc(s.accent)}">`)}
    ${field('NDI : adresses IP à interroger (si les sources n\'apparaissent pas)', `<input data-set-field="ndiExtraIps" value="${esc(s.ndiExtraIps || '')}" placeholder="192.168.1.20, 192.168.1.21">`)}
    ${field('URL publique (serveur en ligne, pour le QR code de vote)', `<input type="url" data-set-field="publicUrl" value="${esc(s.publicUrl)}" placeholder="https://…">`)}
    <div class="box"><div class="row"><img class="qr" data-qr="remote" alt=""><div><b>Télécommande smartphone</b><div class="link"></div></div></div></div>
    <div class="box"><b>Conversion PowerPoint / Keynote</b><span class="hint">${conv.length ? 'Disponible via : ' + conv.map((c) => ({ libreoffice: 'LibreOffice', powerpoint: 'PowerPoint', keynote: 'Keynote' }[c])).join(', ') : 'Aucun logiciel trouvé : installez LibreOffice (gratuit, libreoffice.org) ou PowerPoint, ou importez vos présentations en PDF.'}</span></div>
    <div class="box"><b>Réseau</b>${(info.lan || []).map((u) => `<div class="link">${esc(u)}</div>`).join('')}
      <span class="hint">${info.pinRequired ? 'Régie protégée par code PIN.' : 'Régie non protégée (PRESENTHOR_PIN pour un usage en ligne).'}</span></div>
    <div class="row"><a class="btn" href="/api/export${getPin() ? '?pin=' + encodeURIComponent(getPin()) : ''}">Exporter le show</a></div>`;
}

function fillQr(el) {
  joinUrl(S).then((url) => {
    for (const img of el.querySelectorAll('[data-qr]')) {
      const u = img.dataset.qr === 'remote' ? url.replace(/\/vote\/$/, '/remote/') : url;
      const src = '/api/qr.svg?text=' + encodeURIComponent(u);
      if (img.getAttribute('src') !== src) img.src = src;
      const link = img.parentElement.querySelector('.link');
      if (link) link.textContent = u;
    }
  });
}

// ------------------------------------------------------------------ actions
function firstFreeCell(layerId) {
  const l = layerById(layerId) || S.comp.layers[S.comp.layers.length - 1];
  const i = l.clips.findIndex((c) => !c);
  return { layerId: l.id, col: i >= 0 ? i : l.clips.length };
}
async function placeCue(cue, at) {
  const target = at || (sel && !layerById(sel.layerId)?.clips[sel.col] ? sel : firstFreeCell(sel?.layerId || selLayerId));
  if (target.col >= S.comp.columns.length) await send({ type: 'comp.column.add' });
  const r = await send({ type: 'comp.cell.create', layerId: target.layerId, col: target.col, cue });
  if (r?.id) {
    sel = { layerId: target.layerId, col: target.col }; ptab = 'clip'; renderAll();
    if (cue.type === 'window' && desktop?.captureSources) pickWindow(r.id);
  }
  return r;
}
const mediaCue = (m) => ({ type: m.kind === 'office' ? 'slides' : m.kind, mediaId: m.id });

function setTarget(target, patchObj) {
  if (target === 'layer') return send({ type: 'comp.layer.update', id: selLayerId, patch: patchObj });
  if (target === 'comp') return patchObj.master != null && send({ type: 'comp.master', value: patchObj.master });
  const c = selCue();
  if (c) return send({ type: 'cue.update', id: c.id, patch: patchObj });
}
function targetObj(target) { return target === 'layer' ? layerById(selLayerId) : target === 'comp' ? S.comp : selCue(); }

// Envois limités pendant qu'on manipule un curseur (≈ 20 / s).
const throttles = new Map();
function throttled(key, fn) {
  const t = throttles.get(key);
  if (t) { t.fn = fn; return; }
  fn();
  const entry = { fn: null };
  throttles.set(key, entry);
  setTimeout(() => { throttles.delete(key); entry.fn?.(); }, 50);
}

document.addEventListener('click', async (e) => {
  const t = e.target;
  closeMenu();
  // Grille : colonnes
  const ch = t.closest('.colhead');
  if (ch) return send({ type: 'comp.column.trigger', col: +ch.dataset.col });
  // Grille : cases
  const cell = t.closest('.cell');
  if (cell) {
    const pos = { layerId: cell.dataset.layer, col: +cell.dataset.col };
    sel = pos; selLayerId = pos.layerId; ptab = 'clip';
    const has = layerById(pos.layerId)?.clips[pos.col];
    if (has && !t.closest('.cname')) send({ type: 'comp.trigger', ...pos });
    if (cueById(has)?.type === 'camera') detectCameras();
    return renderAll();
  }
  // Grille : en-têtes de calques
  const lh = t.closest('[data-layer-head]');
  if (lh) {
    const id = lh.dataset.layerHead;
    const la = t.closest('[data-lact]')?.dataset.lact;
    const l = layerById(id);
    if (la === 'clear') return send({ type: 'comp.layer.clear', layerId: id });
    if (la === 'bypass') return send({ type: 'comp.layer.update', id, patch: { bypass: !l.bypass } });
    if (la === 'solo') return send({ type: 'comp.layer.update', id, patch: { solo: !l.solo } });
    if (t.closest('input, select')) return;
    selLayerId = id; ptab = 'layer';
    return renderAll();
  }
  const pt = t.closest('[data-ptab]');
  if (pt) { ptab = pt.dataset.ptab; return renderProps(true); }
  const bt = t.closest('[data-btab]');
  if (bt) {
    btab = bt.dataset.btab;
    if (btab === 'outputs' && desktop) displays = await desktop.listDisplays();
    if (btab === 'public') { await listAudioInputs(); if (!cameras.length) detectCameras(); }
    return renderBrowser(true);
  }
  const sl = t.closest('.slides-strip [data-slide]');
  if (sl) { const c = selCue(); return c && send({ type: 'comp.slide', cueId: c.id, slide: +sl.dataset.slide }); }

  const b = t.closest('[data-act]');
  if (!b) return;
  const id = b.dataset.id;
  const c = selCue();
  const A = {
    'clear-all': () => send({ type: 'comp.clear' }),
    'add-col': () => send({ type: 'comp.column.add' }),
    'add-layer': () => send({ type: 'comp.layer.add' }),
    'deck-prev': () => send({ type: 'prev' }),
    'deck-next': () => send({ type: 'next' }),
    'pb-toggle': () => send({ type: S.live.comp.pb?.[id]?.playing ? 'comp.pb.pause' : 'comp.pb.play', layerId: id }),
    'pb-restart': () => send({ type: 'comp.pb.restart', layerId: id }),
    'slide-delta': () => c && send({ type: 'comp.slide', cueId: c.id, delta: +b.dataset.d }),
    'cell-trigger': () => sel && send({ type: 'comp.trigger', ...sel }),
    'cell-unset': () => sel && send({ type: 'comp.cell.set', ...sel, cueId: null }),
    'cue-delete': () => c && ask(`Supprimer le clip « ${c.name} » ?`) && send({ type: 'cue.remove', id: c.id }),
    'pick-window': () => c && pickWindow(c.id),
    'guest-place': () => { const g = S.guests.find((x) => x.id === id); if (g) placeCue({ type: 'guest', guestId: g.id, name: g.name }); },
    'guest-copy': () => navigator.clipboard.writeText(guestLink()).then(() => toast('Lien invité copié')),
    'scene-edit': () => c && openSceneEditor({ getState: () => S, send, cueId: c.id, client }),
    popout: () => {
      const w = window.open(`/control/?panel=${btab}`, 'presenthor_' + btab, 'width=980,height=900');
      if (!w) toast('Fenêtre bloquée par le navigateur : autorisez les fenêtres pop-up.');
    },
    'panel-fullscreen': () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen().catch(() => {})),
    'tl-mark': () => { const pos = c && clipPosition(c); if (pos == null) return toast('Lancez le clip (ou sélectionnez-le pour l\'aperçu) pour marquer la position'); send({ type: 'cue.update', id: c.id, patch: { [b.dataset.k]: Math.round(pos * 100) / 100 } }); },
    'tl-reset': () => c && send({ type: 'cue.update', id: c.id, patch: { inPoint: 0, outPoint: null, fadeIn: 0, fadeOut: 0 } }),
    'crop-reset': () => c && send({ type: 'cue.update', id: c.id, patch: { crop: { ...(c.crop || {}), t: 0, r: 0, b: 0, l: 0, feather: 0 } } }),
    'key-color': () => c && send({ type: 'cue.update', id: c.id, patch: { key: { ...(c.key || {}), on: true, color: b.dataset.color } } }),
    'key-pick': async () => {
      if (!c) return;
      try {
        const r = await new window.EyeDropper().open();
        send({ type: 'cue.update', id: c.id, patch: { key: { ...(c.key || {}), on: true, color: r.sRGBHex } } });
      } catch { /* annulé */ }
    },
    'media-optimize': () => { send({ type: 'media.optimize', id, height: Number(b.dataset.h) || undefined }); toast('Optimisation lancée en arrière-plan : le clip bascule tout seul sur la nouvelle version.'); },
    'reset-transform': () => setTarget(b.dataset.target, { transform: { x: 0, y: 0, scale: 1, rotate: 0 } }),
    'fx-remove': () => { const o = targetObj(b.dataset.target); setTarget(b.dataset.target, { effects: o.effects.filter((_, i) => i !== +b.dataset.i) }); },
    'layer-up': () => send({ type: 'comp.layer.move', id: selLayerId, dir: 1 }),
    'layer-down': () => send({ type: 'comp.layer.move', id: selLayerId, dir: -1 }),
    'layer-remove': () => ask('Supprimer ce calque et ses cases ?') && send({ type: 'comp.layer.remove', id: selLayerId }),
    cams: () => detectCameras(true),
    import: () => $('#file-input').click(),
    'media-remove': () => ask('Supprimer ce média ?') && send({ type: 'media.remove', id }),
    'out-add': () => send({ type: 'output.add', name: 'Écran ' + (S.outputs.length + 1) }),
    'out-remove': () => ask('Supprimer cette sortie ?') && (desktop?.closeOutput(id), send({ type: 'output.remove', id })),
    'out-window': () => window.open(`/output/?id=${id}`, 'out_' + id, 'popup,width=960,height=540'),
    'out-open': () => {
      const v = Number(document.querySelector(`[data-out-display="${id}"]`)?.value);
      send({ type: 'output.update', id, patch: { displayId: v } });
      desktop.openOutput(id, v);
    },
    'out-open-win': () => desktop.openOutput(id, null),
    'out-fs': () => desktop.setOutputFullscreen(id, b.dataset.on === '1'),
    'out-close': () => desktop.closeOutput(id),
    'out-mapping': () => openMappingEditor({ getState: () => S, send, outputId: id }),
    'displays-identify': () => desktop.identifyDisplays(),
    copy: () => navigator.clipboard.writeText(b.dataset.text).then(() => toast('Lien copié')),
    'msg-send': () => send({ type: 'message.send', text: $('#msg-text').value }),
    'msg-quick': () => send({ type: 'message.send', text: b.dataset.text }),
    'msg-clear': () => { $('#msg-text').value = ''; send({ type: 'message.send', text: '' }); },
    'lt-show': () => send({ type: 'overlay.set', overlay: { text: $('#lt-text').value, sub: $('#lt-sub').value } }),
    'lt-hide': () => send({ type: 'overlay.set', overlay: null }),
    'timer-apply': () => send({ type: 'timer.set', mode: $('#timer-mode').value, duration: Number($('#timer-min').value) * 60000 }),
    'timer-preset': () => send({ type: 'timer.set', mode: 'down', duration: Number(b.dataset.min) * 60000 }),
    'poll-create': async () => {
      const options = $('#poll-opts').value.split('\n').map((x) => x.trim()).filter(Boolean);
      const r = await send({ type: 'poll.create', poll: { question: $('#poll-q').value.trim() || 'Votre avis ?', kind: $('#poll-kind').value, options } });
      if (r?.ok) $('#poll-q').value = '';
    },
    'poll-open': () => send({ type: 'poll.open', id: S.activePollId === id ? null : id }),
    'poll-reset': () => ask('Effacer les réponses ?') && send({ type: 'poll.reset', id }),
    'poll-remove': () => ask('Supprimer ce sondage ?') && send({ type: 'poll.remove', id }),
    'poll-place': () => { const p = S.polls.find((x) => x.id === id); placeCue({ type: 'poll', pollId: id, name: 'Sondage : ' + p.question }); },
    'qa-toggle': () => send({ type: 'qa.toggle' }),
    'qa-set': () => send({ type: 'qa.update', id, status: b.dataset.status }),
  };
  A[b.dataset.act]?.();
});

document.addEventListener('dblclick', (e) => {
  const rs = e.target.closest('[data-reset]');
  if (rs && rs.dataset.def !== '') {
    const v = Number(rs.dataset.def);
    const row = rs.parentElement;
    row.querySelector('input[type=range]').value = v;
    row.querySelector('input.num').value = fmt2(v);
    return sendBound(rs.dataset.reset, v);
  }
  const ch = e.target.closest('.colhead');
  if (ch) {
    const i = +ch.dataset.col;
    const name = prompt('Nom de la colonne :', S.comp.columns[i].name);
    if (name != null) send({ type: 'comp.column.update', index: i, name });
    return;
  }
  const lh = e.target.closest('.lname');
  if (lh) {
    const id = lh.closest('[data-layer-head]').dataset.layerHead;
    const name = prompt('Nom du calque :', layerById(id).name);
    if (name != null) send({ type: 'comp.layer.update', id, patch: { name } });
    return;
  }
  const m = e.target.closest('[data-media]');
  if (m) return placeCue(mediaCue(mediaById(m.dataset.media)));
  const src = e.target.closest('[data-src]');
  if (src) return placeCue(structuredClone(sourceTemplates()[+src.dataset.src][2]));
});

// Envoi d'une valeur de curseur : au rythme de l'affichage (≈ 60 / s), dernière valeur garantie.
const pendingBound = new Map();
let boundRaf = 0;
function sendBound(bind, v) {
  const [target, path] = bind.split(':');
  const cr = target === 'clip' && path.startsWith('crop.') ? selCue()?.crop : null;
  const twin = cr && ((cr.linkV && { 'crop.t': 'crop.b', 'crop.b': 'crop.t' }[path]) || (cr.linkH && { 'crop.l': 'crop.r', 'crop.r': 'crop.l' }[path]));
  if (twin && !sendBound.linking) {
    // Côté opposé lié : même valeur, curseur et case mis à jour.
    sendBound.linking = true;
    for (const el of document.querySelectorAll(`[data-bind="clip:${twin}"]`)) el.value = el.type === 'number' ? fmt2(v) : v;
    sendBound('clip:' + twin, v);
    sendBound.linking = false;
  }
  const obj = targetObj(target);
  if (obj && path.includes('.')) { const [a, b2] = path.split('.'); obj[a] = { ...(obj[a] || {}), [b2]: v }; } else if (obj) obj[path] = v;
  pendingBound.set(bind, () => setTarget(target, setPath(obj, path, v)));
  boundRaf ||= requestAnimationFrame(() => { boundRaf = 0; for (const fn of pendingBound.values()) fn(); pendingBound.clear(); });
}
// Molette sur un curseur : pas fin (Maj = x10).
document.addEventListener('wheel', (e) => {
  const el = e.target;
  if (!el.matches?.('input[type=range]')) return;
  e.preventDefault();
  const step = Number(el.step) || 0.01;
  el.value = Math.min(Number(el.max), Math.max(Number(el.min), Number(el.value) - Math.sign(e.deltaY) * step * (e.shiftKey ? 10 : 1)));
  el.dispatchEvent(new Event('input', { bubbles: true }));
}, { passive: false });
// Maj pendant le glissé = réglage fin.
document.addEventListener('keydown', (e) => { if (e.key === 'Shift' && dragRange) dragRange.step = Number(dragRange.dataset.step || dragRange.step) / 10; });
document.addEventListener('keyup', (e) => { if (e.key === 'Shift' && dragRange) dragRange.step = dragRange.dataset.step || dragRange.step; });

// Champs : curseurs (input), listes et cases (change)
function readValue(el) {
  if (el.type === 'checkbox') return el.dataset.type === 'bool-true' ? el.checked : el.checked;
  if (el.dataset.type === 'number' || el.type === 'range' || el.dataset.num !== undefined) return Number(el.value);
  return el.value;
}
function setPath(obj, path, value) {
  const [a, b] = path.split('.');
  return b ? { [a]: { ...(obj?.[a] || {}), [b]: value } } : { [a]: value };
}
document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.dataset.lop) {
    const id = el.closest('[data-layer-head]').dataset.layerHead;
    if (el.dataset.lop === 'opacity') { const l = layerById(id); if (l) l.opacity = Number(el.value); pendingBound.set('op' + id, () => send({ type: 'comp.layer.update', id, patch: { opacity: Number(el.value) } })); boundRaf ||= requestAnimationFrame(() => { boundRaf = 0; for (const fn of pendingBound.values()) fn(); pendingBound.clear(); }); }
    return;
  }
  if (el.dataset.bind && el.type === 'range') {
    const v = Number(el.value);
    const num = el.parentElement.querySelector('input.num');
    if (num) num.value = fmt2(v);
    return sendBound(el.dataset.bind, v);
  }
  if (el.dataset.fxVal) {
    const [target, i] = el.dataset.fxVal.split(':');
    const o = targetObj(target);
    const fx = o.effects.map((x, k) => (k === +i ? { ...x, value: Number(el.value) } : x));
    o.effects = fx;
    el.parentElement.querySelector('output').textContent = fmt2(Number(el.value));
    throttled('fx' + target + i, () => setTarget(target, { effects: fx }));
    return;
  }
  if (el.dataset.seek) el.dataset.dragging = '1';
});
document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset.lop === 'blend') { el.blur(); return send({ type: 'comp.layer.update', id: el.closest('[data-layer-head]').dataset.layerHead, patch: { blend: el.value } }); }
  if (el.dataset.lop === 'opacity') { el.blur(); return; }
  if (el.dataset.seek) { delete el.dataset.dragging; el.blur(); return send({ type: 'comp.pb.seek', layerId: el.dataset.seek, time: Number(el.value) }); }
  if (el.dataset.bind && el.type === 'number') {
    const v = Math.min(Number(el.max), Math.max(Number(el.min), Number(el.value) || 0));
    const r = el.parentElement.querySelector('input[type=range]');
    if (r) r.value = v;
    return sendBound(el.dataset.bind, v);
  }
  if (el.dataset.bind && el.type !== 'range') {
    const [target, path] = el.dataset.bind.split(':');
    return setTarget(target, setPath(targetObj(target), path, readValue(el)));
  }
  if (el.dataset.addFx !== undefined && el.value) {
    const target = el.dataset.addFx;
    const o = targetObj(target);
    const def = FX[el.value];
    setTarget(target, { effects: [...(o.effects || []), { type: el.value, value: def.def ?? 1, on: true }] });
    el.value = '';
    return;
  }
  if (el.dataset.fxOn) {
    const [target, i] = el.dataset.fxOn.split(':');
    const o = targetObj(target);
    return setTarget(target, { effects: o.effects.map((x, k) => (k === +i ? { ...x, on: el.checked } : x)) });
  }
  if (el.dataset.compClicker !== undefined) return send({ type: 'comp.settings', clickerColumns: el.checked });
  if (el.dataset.route) {
    const l = layerById(selLayerId);
    if (el.dataset.route === 'main') return send({ type: 'comp.layer.update', id: l.id, patch: { mainOut: el.checked } });
    const aux = new Set(l.auxOutputs || []);
    el.checked ? aux.add(el.dataset.route) : aux.delete(el.dataset.route);
    return send({ type: 'comp.layer.update', id: l.id, patch: { auxOutputs: [...aux] } });
  }
  if (el.dataset.ret) return applyReturn(el.dataset.ret, el.value);
  if (el.dataset.cropOpt || el.dataset.keyOpt) {
    const c = selCue();
    if (!c) return;
    const [field, k] = el.dataset.cropOpt ? ['crop', el.dataset.cropOpt] : ['key', el.dataset.keyOpt];
    const v = el.type === 'checkbox' ? el.checked : el.value || null;
    return send({ type: 'cue.update', id: c.id, patch: { [field]: { ...(c[field] || {}), [k]: v } } });
  }
  if (el.dataset.layerName !== undefined) return send({ type: 'comp.layer.update', id: selLayerId, patch: { name: el.value } });
  if (el.dataset.cueField) {
    const c = selCue();
    if (!c) return;
    const k = el.dataset.cueField;
    let v = readValue(el);
    const p = { [k]: v === '' && /Id$/.test(k) ? null : v };
    if (k === 'deviceId') p.deviceLabel = cameras.find((d) => d.deviceId === v)?.label || '';
    if (k === 'fit' && v === '') p.fit = null;
    if (k === 'engine' && v === '') p.engine = null;
    if (k === 'outPoint' && (el.value === '' || !(v > 0))) p.outPoint = null;
    return send({ type: 'cue.update', id: c.id, patch: p });
  }
  if (el.dataset.ndiSource !== undefined) {
    const c = selCue();
    const src = (S.ndi?.sources || []).find((x) => x.name === el.value) || (el.value ? { name: el.value } : null);
    return c && send({ type: 'cue.update', id: c.id, patch: { source: src, name: src ? src.name : c.name } });
  }
  if (el.dataset.outField) {
    const id = el.closest('[data-out]').dataset.out;
    return send({ type: 'output.update', id, patch: { [el.dataset.outField]: readValue(el) } });
  }
  if (el.dataset.pollField) return send({ type: 'poll.update', id: el.dataset.poll, patch: { [el.dataset.pollField]: el.checked } });
  if (el.dataset.setField) return send({ type: 'settings.update', patch: { [el.dataset.setField]: readValue(el) } });
});

$('#prefs-btn').onclick = () => openPrefs({ getState: () => S, send, info, toast });
$('#show-name').addEventListener('change', (e) => send({ type: 'show.rename', name: e.target.value }));
$('#blackout').onclick = () => send({ type: 'blackout.toggle' });
$('#clear-all').onclick = () => send({ type: 'comp.clear' });
$('#master').oninput = (e) => sendBound('comp:master', Number(e.target.value));
$('#master').onchange = (e) => e.target.blur();
$('#timer-toggle').onclick = () => send({ type: S.timer.running ? 'timer.pause' : 'timer.start' });
$('#timer-reset').onclick = () => send({ type: 'timer.reset' });
// Réglage rapide du chrono (clic sur l'affichage).
$('#timer-display').onclick = (e) => {
  const t = S.timer, st = S.settings;
  const r = e.target.getBoundingClientRect();
  const m = $('#menu');
  m.innerHTML = `<div class="timer-pop">
    <b>Chronomètre</b>
    <div class="row"><select id="tp-mode">${sel_([['down', 'Compte à rebours'], ['up', 'Chronomètre']], t.mode)}</select>
      <input id="tp-min" type="number" min="0" step="1" value="${Math.round(t.duration / 60000)}" style="width:70px"><span class="hint">min</span></div>
    <div class="row wrap">${[5, 10, 15, 20, 30, 45, 60].map((n) => `<button class="btn sm" data-tp-preset="${n}">${n}′</button>`).join('')}</div>
    <div class="row"><button class="btn sm primary" data-tp="apply">Appliquer</button><button class="btn sm" data-tp="start">${t.running ? 'Pause' : 'Démarrer'}</button><button class="btn sm" data-tp="reset">Remettre à zéro</button></div>
    <b>Affichage</b>
    <select id="tp-show">${sel_([['always', 'Toujours affiché'], ['running', 'Seulement quand il tourne'], ['never', 'Jamais (désactivé)']], st.timerShow || 'running')}</select>
    <label class="check"><input type="checkbox" id="tp-pres"${st.timerOnPresenter !== false ? ' checked' : ''}> Retour présentateur</label>
    <label class="check"><input type="checkbox" id="tp-rem"${st.timerOnRemote !== false ? ' checked' : ''}> Télécommande smartphone</label>
    <label class="check"><input type="checkbox" id="tp-reg"${st.timerOnRegie !== false ? ' checked' : ''}> Régie</label></div>`;
  m.hidden = false;
  m.style.left = Math.min(r.left, innerWidth - 300) + 'px';
  m.style.top = r.bottom + 6 + 'px';
  m.onclick = (ev) => {
    ev.stopPropagation();
    const b = ev.target.closest('[data-tp], [data-tp-preset]');
    if (!b) return;
    if (b.dataset.tpPreset) { $('#tp-min').value = b.dataset.tpPreset; send({ type: 'timer.set', mode: $('#tp-mode').value, duration: Number(b.dataset.tpPreset) * 60000 }); return; }
    if (b.dataset.tp === 'apply') send({ type: 'timer.set', mode: $('#tp-mode').value, duration: Number($('#tp-min').value) * 60000 });
    if (b.dataset.tp === 'start') { send({ type: S.timer.running ? 'timer.pause' : 'timer.start' }); closeMenu(); }
    if (b.dataset.tp === 'reset') send({ type: 'timer.reset' });
  };
  m.onchange = (ev) => {
    const id = ev.target.id;
    const map = { 'tp-show': ['timerShow', ev.target.value], 'tp-pres': ['timerOnPresenter', ev.target.checked], 'tp-rem': ['timerOnRemote', ev.target.checked], 'tp-reg': ['timerOnRegie', ev.target.checked] };
    if (map[id]) send({ type: 'settings.update', patch: { [map[id][0]]: map[id][1] } });
  };
  e.stopPropagation();
};

// ------------------------------------------------------------------ menu contextuel
function openMenu(x, y, items) {
  const m = $('#menu');
  m.innerHTML = items.map((it, i) => (it === '-' ? '<hr>' : `<button data-mi="${i}">${esc(it[0])}</button>`)).join('');
  m.hidden = false;
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  m.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
  m.onclick = (e) => { const i = e.target.closest('[data-mi]')?.dataset.mi; if (i != null) { closeMenu(); items[+i][1](); } };
}
function closeMenu() { $('#menu').hidden = true; }
document.addEventListener('contextmenu', (e) => {
  const cell = e.target.closest('.cell');
  const ch = e.target.closest('.colhead');
  if (!cell && !ch) return;
  e.preventDefault();
  if (ch) {
    const i = +ch.dataset.col;
    return openMenu(e.clientX, e.clientY, [
      ['Déclencher la colonne', () => send({ type: 'comp.column.trigger', col: i })],
      ['Renommer…', () => { const n = prompt('Nom de la colonne :', S.comp.columns[i].name); if (n != null) send({ type: 'comp.column.update', index: i, name: n }); }],
      ['Insérer une colonne après', () => send({ type: 'comp.column.add', index: i })],
      '-',
      ['Supprimer la colonne', () => ask('Supprimer cette colonne ?') && send({ type: 'comp.column.remove', index: i })],
    ]);
  }
  const pos = { layerId: cell.dataset.layer, col: +cell.dataset.col };
  const cid = layerById(pos.layerId).clips[pos.col];
  sel = pos; selLayerId = pos.layerId; renderAll();
  if (!cid) return openMenu(e.clientX, e.clientY, [['Importer des fichiers ici…', () => { pendingDrop = pos; $('#file-input').click(); }]]);
  const next = () => { const l = layerById(pos.layerId); const i = l.clips.findIndex((c, k) => k > pos.col && !c); return i >= 0 ? i : l.clips.length; };
  openMenu(e.clientX, e.clientY, [
    ['Déclencher', () => send({ type: 'comp.trigger', ...pos })],
    ['Dupliquer dans la case libre suivante', async () => { const col = next(); if (col >= S.comp.columns.length) await send({ type: 'comp.column.add' }); send({ type: 'comp.cell.move', from: pos, to: { layerId: pos.layerId, col }, copy: true }); }],
    ['Retirer de la case', () => send({ type: 'comp.cell.set', ...pos, cueId: null })],
    '-',
    ...S.outputs.map((o) => [`Afficher seul sur « ${o.name} »`, () => { send({ type: 'output.update', id: o.id, patch: { source: 'cue:' + cid } }); toast(`« ${o.name} » affiche maintenant ce clip (onglet Sorties pour revenir)`); }]),
    '-',
    ['Supprimer le clip', () => ask('Supprimer ce clip ?') && send({ type: 'cue.remove', id: cid })],
  ]);
});

// ------------------------------------------------------------------ glisser-déposer
let dragData = null;
document.addEventListener('dragstart', (e) => {
  const t = e.target;
  if (t.closest?.('.cell[draggable]')) { const c = t.closest('.cell'); dragData = { kind: 'cell', layerId: c.dataset.layer, col: +c.dataset.col }; }
  else if (t.closest?.('[data-media]')) dragData = { kind: 'media', id: t.closest('[data-media]').dataset.media };
  else if (t.closest?.('[data-src]')) dragData = { kind: 'src', i: +t.closest('[data-src]').dataset.src };
  else if (t.closest?.('[data-fx]')) dragData = { kind: 'fx', fx: t.closest('[data-fx]').dataset.fx };
  else if (t.closest?.('[data-mask]')) dragData = { kind: 'mask', mask: t.closest('[data-mask]').dataset.mask };
  else return;
  e.dataTransfer.setData('text/plain', 'presenthor');
  e.dataTransfer.effectAllowed = 'copyMove';
});
document.addEventListener('dragend', () => { dragData = null; clearDropMarks(); });
const clearDropMarks = () => document.querySelectorAll('.drop-target').forEach((x) => x.classList.remove('drop-target'));
let dragDepth = 0;
document.addEventListener('dragenter', (e) => { if (e.dataTransfer.types.includes('Files')) { dragDepth++; $('#drop').hidden = false; } });
document.addEventListener('dragleave', (e) => { if (e.dataTransfer.types.includes('Files') && --dragDepth <= 0) { dragDepth = 0; $('#drop').hidden = true; } });
document.addEventListener('dragover', (e) => {
  const target = e.target.closest('.cell') || e.target.closest('[data-layer-head]');
  e.preventDefault();
  clearDropMarks();
  if (target) target.classList.add('drop-target');
  e.dataTransfer.dropEffect = e.altKey ? 'copy' : 'move';
});
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  clearDropMarks();
  dragDepth = 0; $('#drop').hidden = true;
  const cell = e.target.closest('.cell');
  const lh = e.target.closest('[data-layer-head]');
  if (e.dataTransfer.files.length) {
    const pos = cell ? { layerId: cell.dataset.layer, col: +cell.dataset.col } : null;
    return upload([...e.dataTransfer.files], pos);
  }
  const d = dragData;
  dragData = null;
  if (!d) return;
  if (d.kind === 'fx' || d.kind === 'mask') {
    let target = null;
    if (lh) { selLayerId = lh.dataset.layerHead; target = 'layer'; }
    else if (cell && layerById(cell.dataset.layer).clips[+cell.dataset.col]) { sel = { layerId: cell.dataset.layer, col: +cell.dataset.col }; target = 'clip'; }
    if (!target) return;
    ptab = target;
    const o = targetObj(target);
    if (d.kind === 'mask') return setTarget(target, { mask: d.mask });
    return setTarget(target, { effects: [...(o.effects || []), { type: d.fx, value: FX[d.fx].def ?? 1, on: true }] });
  }
  if (!cell) return;
  const to = { layerId: cell.dataset.layer, col: +cell.dataset.col };
  if (d.kind === 'cell') {
    if (d.layerId === to.layerId && d.col === to.col) return;
    return send({ type: 'comp.cell.move', from: { layerId: d.layerId, col: d.col }, to, copy: e.altKey });
  }
  if (d.kind === 'media') return placeCue(mediaCue(mediaById(d.id)), to);
  if (d.kind === 'src') return placeCue(structuredClone(sourceTemplates()[d.i][2]), to);
});

// ------------------------------------------------------------------ import
let pendingDrop = null;
function upload(files, pos) {
  if (!files.length) return;
  const fd = new FormData();
  for (const f of files) fd.append('files', f);
  const q = pos ? `?layer=${encodeURIComponent(pos.layerId)}&col=${pos.col}` : '';
  toast(`Import de ${files.length} fichier(s)…`);
  const xhr = new XMLHttpRequest();
  xhr.onloadend = () => {
    if (xhr.status !== 200) return toast('Import échoué (' + xhr.status + ')');
    const n = JSON.parse(xhr.responseText).media.length;
    toast(n ? `${n} fichier(s) importé(s)` : 'Format non pris en charge');
  };
  xhr.open('POST', '/api/media' + q);
  xhr.setRequestHeader('x-pin', getPin());
  xhr.send(fd);
}
$('#file-input').onchange = (e) => { upload([...e.target.files], pendingDrop); pendingDrop = null; e.target.value = ''; };

// ------------------------------------------------------------------ clavier
window.addEventListener('keydown', (e) => {
  const t = e.target;
  if (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && !['range', 'checkbox'].includes(t.type)) return;
  if (e.key === 'Escape') return closeMenu();
  if (/^[1-9]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const i = +e.key - 1;
    if (i < S.comp.columns.length) send({ type: 'comp.column.trigger', col: i });
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && sel && selCue()) { e.preventDefault(); send({ type: 'comp.cell.set', ...sel, cueId: null }); }
});

// ------------------------------------------------------------------ visio : invités et retour
let audioInputs = [];
const guestLink = () => `${(S.settings.publicUrl || '').replace(/\/$/, '') || location.origin}/guest/?k=${S.settings.guestToken}`;
const retSettings = () => { try { return JSON.parse(localStorage.getItem('presenthor.return') || '{}'); } catch { return {}; } };
// La régie garde une connexion avec chaque invité : aperçu ici + envoi du retour.
const guestStreams = new Map();
function keepGuests() {
  for (const g of S.guests || []) {
    const known = guestStreams.get(g.id);
    if (known?.cid === g.cid) continue;
    const entry = { cid: g.cid, stream: null };
    guestStreams.set(g.id, entry);
    guestStream(client, () => S, g.id).then((st) => { entry.stream = st; attachGuestPreviews(); }).catch(() => { if (guestStreams.get(g.id) === entry) guestStreams.delete(g.id); });
  }
  for (const id of guestStreams.keys()) if (!S.guests?.some((g) => g.id === id)) guestStreams.delete(id);
  attachGuestPreviews();
}
function attachGuestPreviews() {
  for (const v of document.querySelectorAll('video[data-guest]')) {
    const st = guestStreams.get(v.dataset.guest)?.stream;
    if (st && v.srcObject !== st) v.srcObject = st;
  }
}
async function applyReturn(kind, value, fromPanel = false) {
  const rs = retSettings();
  rs[kind] = value;
  try { localStorage.setItem('presenthor.return', JSON.stringify(rs)); } catch {}
  // Une fenêtre détachée confie l'envoi du retour à la régie principale (un seul envoi par invité).
  if (PANEL) { bc?.postMessage({ type: 'return', kind, value }); toast('Retour mis à jour'); return; }
  try {
    if (kind === 'audio') {
      const st = value ? await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: value }, echoCancellation: false, noiseSuppression: false, autoGainControl: false } }) : null;
      setReturnTracks({ audio: st?.getAudioTracks()[0] || null });
    } else {
      let st = null;
      if (value.startsWith('cam:')) st = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: value.slice(4) }, height: { ideal: 720 } } });
      if (value.startsWith('out:')) {
        const sid = await desktop?.outputMediaSource(value.slice(4));
        if (!sid) { toast('Ouvrez d\'abord cette sortie'); return; }
        st = await navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sid, maxWidth: 1280, maxHeight: 720, maxFrameRate: 30 } } });
      }
      setReturnTracks({ video: st?.getVideoTracks()[0] || null });
    }
    toast('Retour mis à jour');
  } catch (e) { toast('Retour impossible : ' + e.message); }
}
async function listAudioInputs() {
  try { audioInputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput'); } catch {}
}
listAudioInputs();
// Rétablit le retour choisi lors de la dernière session.
if (!PANEL) {
  setTimeout(() => { const rs = retSettings(); if (rs.audio) applyReturn('audio', rs.audio); if (rs.video) applyReturn('video', rs.video); }, 1500);
  if (bc) bc.onmessage = (e) => { if (e.data?.type === 'return') applyReturn(e.data.kind, e.data.value); };
}

// ------------------------------------------------------------------ capture de fenêtre
async function pickWindow(cueId) {
  const list = await desktop.captureSources(true);
  const root = document.createElement('div');
  root.className = 'modal';
  root.innerHTML = `<div class="modal-box picker"><header class="modal-head"><b>Choisir une fenêtre ou un écran</b><span class="hint">Mac : autorisez « Enregistrement de l'écran » pour PresenThor si la liste est vide.</span><div class="spacer"></div><button class="btn" data-x>Annuler</button></header>
    <div class="win-grid">${list.map((w) => `<button class="win" data-id="${esc(w.id)}" data-name="${esc(w.name)}"><img src="${w.thumb}" alt=""><span>${w.screen ? '🖥 ' : ''}${esc(w.name)}</span></button>`).join('') || '<p class="hint">Aucune fenêtre capturable.</p>'}</div></div>`;
  document.body.append(root);
  root.addEventListener('click', (e) => {
    const b = e.target.closest('.win');
    if (b) send({ type: 'cue.update', id: cueId, patch: { sourceId: b.dataset.id, sourceName: b.dataset.name, name: b.dataset.name.slice(0, 40) } });
    if (b || e.target.closest('[data-x]') || e.target === root) root.remove();
  });
}

// ------------------------------------------------------------------ caméras
async function detectCameras(ask = false) {
  try {
    let devs = await navigator.mediaDevices.enumerateDevices();
    if (ask || devs.some((d) => d.kind === 'videoinput' && !d.label)) {
      const st = await navigator.mediaDevices.getUserMedia({ video: true }).catch(() => null);
      st?.getTracks().forEach((x) => x.stop());
      devs = await navigator.mediaDevices.enumerateDevices();
    }
    cameras = devs.filter((d) => d.kind === 'videoinput');
    renderProps(true);
  } catch { toast('Accès aux caméras impossible'); }
}

// ------------------------------------------------------------------ horloges et lecture
setInterval(() => {
  if (!S) return;
  const now = client.now();
  $('#clock').textContent = new Date(now).toLocaleTimeString('fr-FR');
  const v = timerValue(S.timer, now);
  const td = $('#timer-display');
  // En régie, le chrono reste accessible (bouton ⏱) même masqué, sauf s'il est désactivé ici.
  const shown = timerVisible(S, 'Regie');
  $('.timer-box').hidden = S.settings.timerOnRegie === false || S.settings.timerShow === 'never';
  td.classList.toggle('idle', !shown);
  td.textContent = fmtTime(v, true);
  td.className = 'timer-display' + (shown ? '' : ' idle') + (S.timer.mode === 'down' ? (v < 0 ? ' over' : v < (S.settings.timerWarnSec ?? 120) * 1000 ? ' warn' : '') : '');
  if (!shown) td.textContent = '⏱ ' + fmtTime(S.timer.duration);
  $('#timer-toggle').textContent = S.timer.running ? '⏸' : '▶';
  for (const tl of document.querySelectorAll('[data-tl]')) {
    const c = cueById(tl.dataset.tl);
    const head = tl.querySelector('[data-tl-head]');
    const pos = c && clipPosition(c);
    const label = tl.closest('.box').querySelector('[data-tl-now]');
    if (pos == null || tlDrag) { head.hidden = true; if (!tlDrag) label.textContent = ''; continue; }
    head.hidden = false;
    head.style.left = (pos / Number(tl.dataset.dur)) * 100 + '%';
    label.textContent = (clipLayer(c.id) ? '▶ ' : 'aperçu ') + fmtTime(pos * 1000) + ' / ' + fmtTime(Number(tl.dataset.dur) * 1000);
  }
  for (const [layerId, pb] of Object.entries(S.live.comp.pb || {})) {
    const row = document.querySelector(`[data-tp="${layerId}"]`);
    if (!row) continue;
    const L = outMon?.layers.get(layerId)?.stage.current;
    const vid = L?.video;
    const cue = cueById(S.live.comp.active?.[layerId]);
    // Position dans la fenêtre de lecture (départ → fin) du clip.
    const dur = L?.clipLen && isFinite(L.clipLen) ? L.clipLen : vid?.duration || mediaById(cue?.mediaId)?.duration || 0;
    let tt = L?.clipT ?? (pb.playing ? ((now - pb.startedAt) / 1000) * (cue?.speed || 1) : pb.offset);
    tt = Math.max(0, dur ? Math.min(dur, tt) : tt);
    const seek = row.querySelector('[data-seek]');
    if (dur) seek.max = dur;
    if (!seek.dataset.dragging) seek.value = tt;
    row.querySelector('[data-time]').textContent = `${fmtTime(tt * 1000)} / ${fmtTime(dur * 1000)}`;
  }
}, 200);

let toastT;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 2600);
}
