// Régie PresenThor : grille calques × colonnes (déclenchement de clips en direct),
// moniteurs, propriétés Composition / Calque / Clip, navigateur de médias et sources.
import { Client, bindClicker, esc, fmtTime, timerValue, getPin } from '/shared/client.js';
import { Stage, describe, pdfThumb, joinUrl } from '/shared/renderer.js';
import { CompositionView, deckInfo } from '/shared/composition.js';
import { openSceneEditor } from '/control/scene-editor.js';
import { openMappingEditor } from '/control/mapping-editor.js';

const $ = (s, r = document) => r.querySelector(s);
const desktop = window.presenthor || null; // API de l'app Mac / PC
const ICONS = { slides: '📑', video: '🎬', image: '🖼', audio: '🎵', web: '🌐', camera: '🎥', ndi: '📡', scene: '🧩', poll: '📊', qa: '💬', title: '🅃', black: '⬛', color: '🎨', qr: '▦' };
const TYPE_LABEL = { slides: 'PRÉSENTATION', video: 'VIDÉO', image: 'IMAGE', audio: 'AUDIO', web: 'WEB', camera: 'CAMÉRA', ndi: 'NDI', scene: 'SCÈNE', poll: 'SONDAGE', qa: 'Q&R', title: 'TEXTE', black: 'NOIR', color: 'COULEUR', qr: 'QR' };
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

let S = null;
let sel = null; // { layerId, col } case sélectionnée
let selLayerId = null;
let ptab = 'clip';
let btab = 'media';
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

const outMon = new CompositionView($('#out-mon'), { client, monitor: true, overlays: true, reportEnded: true });
const pvwMon = new Stage($('#pvw-mon'), { client, monitor: true, clipStyle: true, free: true });

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
const isEditing = (el) => { const a = document.activeElement; return a && el.contains(a) && (a.isContentEditable || a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && !['range', 'checkbox', 'color'].includes(a.type))); };
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
  if (document.activeElement !== $('#show-name')) $('#show-name').value = S.show.name;
  document.title = S.show.name + ' — PresenThor';
  const c = S.clients;
  const nOut = Object.keys(c.outputs).length;
  $('#clients').textContent = `${nOut} écran${nOut > 1 ? 's' : ''} · ${c.audience} participant${c.audience > 1 ? 's' : ''}`;
  $('#blackout').classList.toggle('on', !!S.live.blackout);
  if (document.activeElement !== $('#master')) $('#master').value = S.comp.master ?? 1;
  const d = deckInfo(S);
  $('#deck').hidden = !d;
  if (d) $('#deck-label').textContent = `${d.cue.name} · ${d.slide}/${d.pages}`;
  outMon.update(S);
  const active = Object.values(S.live.comp.active || {}).length;
  $('#out-info').textContent = S.live.blackout ? 'NOIR' : `${active} calque${active > 1 ? 's' : ''} actif${active > 1 ? 's' : ''}`;
  const cue = selCue();
  pvwMon.update(S, cue ? describe(S, { cueId: cue.id, slide: S.live.comp.slides?.[cue.id] || 1 }) : { key: 'none', type: 'black' });
  $('#pvw-info').textContent = cue ? cue.name : 'Sélectionnez un clip';
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
function sliderRow(label, bind, value, min, max, step, unit = '') {
  return `<label class="slider"><span>${label}</span><input type="range" min="${min}" max="${max}" step="${step}" value="${value}" data-bind="${bind}"><output>${fmt2(value)}${unit}</output></label>`;
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
    h += `<div class="box"><b>Lecture</b>
      ${field('Fin du clip', `<select ${f('loopMode')}>${sel_(LOOP_MODES, c.loopMode || 'loop')}</select>`)}
      ${check('Démarrer automatiquement au déclenchement', `${f('autoplay')} data-type="bool"`, c.autoplay !== false)}
      ${sliderRow('Vitesse', 'clip:speed', c.speed ?? 1, 0.1, 4, 0.05, '×')}
      ${sliderRow('Volume', 'clip:volume', c.volume ?? 1, 0, 1, 0.01)}</div>`;
  }
  if (c.type === 'web') {
    h += field('URL (Zoom, Teams, Meet, sondage, site…)', `<input type="url" ${f('url')} value="${esc(c.url || '')}" placeholder="https://…">`);
    h += field('Zoom de la page', `<select ${f('zoom')} data-type="number">${sel_([[0.5, '50 %'], [0.75, '75 %'], [1, '100 %'], [1.25, '125 %'], [1.5, '150 %'], [2, '200 %']], c.zoom ?? 1)}</select>`);
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
  if (c.type === 'poll') h += field('Sondage', `<select ${f('pollId')}>${sel_([['', '—'], ...S.polls.map((p) => [p.id, p.question])], c.pollId)}</select>`);
  if (c.type === 'scene') h += `<button class="btn" data-act="scene-edit">Éditer la scène</button>`;
  if (['video', 'image', 'slides', 'camera', 'ndi', 'web', 'scene'].includes(c.type)) {
    h += field('Cadrage', `<select ${f('fit')}>${sel_([['', 'Entier (bandes noires)'], ['cover', 'Remplir (recadré)'], ['fill', 'Étirer']], c.fit || '')}</select>`);
  }
  h += transformBlock('clip', c.transform);
  h += effectsBlock('clip', c.effects, c.mask);
  h += field('Notes pour le présentateur', `<textarea ${f('notes')}>${esc(c.notes || '')}</textarea>`);
  h += `<div class="row"><button class="btn primary" data-act="cell-trigger">Déclencher ▶</button><span class="spacer"></span>
    <button class="btn sm" data-act="cell-unset">Retirer de la case</button><button class="btn sm danger" data-act="cue-delete">Supprimer</button></div>`;
  return h;
}

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
    ['qa', 'Questions du public', { type: 'qa', name: 'Questions' }],
    ['scene', 'Scène (composition libre)', { type: 'scene', layers: [], name: 'Scène' }],
    ['black', 'Noir', { type: 'black', name: 'Noir' }],
  ];
  for (const n of S.ndi?.sources || []) list.push(['ndi', n.name, { type: 'ndi', source: n, name: n.name }]);
  for (const p of S.polls) list.push(['poll', 'Sondage : ' + p.question, { type: 'poll', pollId: p.id, name: 'Sondage : ' + p.question }]);
  return list;
}

function renderBrowser(force = false) {
  if (!S) return;
  for (const b of $('#br-tabs').children) b.classList.toggle('active', b.dataset.btab === btab);
  const el = $('#browser');
  const html = { media: tabMedia, sources: tabSources, fx: tabFx, outputs: tabOutputs, public: tabPublic, live: tabLive, settings: tabSettings }[btab]();
  patch(el, html, force && !isEditing(el));
  if (btab === 'public' || btab === 'settings') fillQr(el);
}

function tabMedia() {
  return `<div class="row"><button class="btn primary" data-act="import">Importer des fichiers</button><span class="hint">ou glissez-les sur une case de la grille</span></div>
    <div class="items">${S.media.map((m) => {
      const kind = m.kind === 'office' ? 'slides' : m.kind;
      let meta = { video: 'Vidéo', image: 'Image', audio: 'Audio', slides: `${m.pages || '?'} diapos` }[kind] || '';
      let cls = '';
      if (m.status === 'converting' || m.status === 'processing') { meta = 'Conversion' + (m.converter ? ` (${m.converter})` : '') + '…'; cls = 'busy'; }
      if (m.status === 'error') { meta = m.error; cls = 'err'; }
      const fake = { id: 'media:' + m.id, type: kind, mediaId: m.id, name: m.name };
      return `<div class="item" draggable="true" data-media="${m.id}" title="${esc(m.name)}${m.status === 'error' ? ' — ' + esc(m.error) : ''}"><div class="thumb">${m.status === 'ready' ? thumbHtml(fake) : `<span class="ico">${ICONS[kind] || '📄'}</span>`}</div>
        <div class="cname">${esc(m.name)}</div><div class="meta ${cls}">${esc(meta)}</div>
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
  return [['program', 'Composition (sortie principale)'], ['clean', 'Composition sans bandeau'], ...S.comp.layers.map((l) => ['layer:' + l.id, 'Calque seul : ' + l.name]),
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
  let h = `<div class="box"><div class="row"><img class="qr" data-qr="vote" alt=""><div><b>Lien participants</b><div class="link"></div>
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
  if (r?.id) { sel = { layerId: target.layerId, col: target.col }; ptab = 'clip'; renderAll(); }
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
  if (bt) { btab = bt.dataset.btab; if (btab === 'outputs' && desktop) displays = await desktop.listDisplays(); return renderBrowser(true); }
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
    'cue-delete': () => c && confirm(`Supprimer le clip « ${c.name} » ?`) && send({ type: 'cue.remove', id: c.id }),
    'scene-edit': () => c && openSceneEditor({ getState: () => S, send, cueId: c.id, client }),
    'reset-transform': () => setTarget(b.dataset.target, { transform: { x: 0, y: 0, scale: 1, rotate: 0 } }),
    'fx-remove': () => { const o = targetObj(b.dataset.target); setTarget(b.dataset.target, { effects: o.effects.filter((_, i) => i !== +b.dataset.i) }); },
    'layer-up': () => send({ type: 'comp.layer.move', id: selLayerId, dir: 1 }),
    'layer-down': () => send({ type: 'comp.layer.move', id: selLayerId, dir: -1 }),
    'layer-remove': () => confirm('Supprimer ce calque et ses cases ?') && send({ type: 'comp.layer.remove', id: selLayerId }),
    cams: () => detectCameras(true),
    import: () => $('#file-input').click(),
    'media-remove': () => confirm('Supprimer ce média ?') && send({ type: 'media.remove', id }),
    'out-add': () => send({ type: 'output.add', name: 'Écran ' + (S.outputs.length + 1) }),
    'out-remove': () => confirm('Supprimer cette sortie ?') && (desktop?.closeOutput(id), send({ type: 'output.remove', id })),
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
    'poll-reset': () => confirm('Effacer les réponses ?') && send({ type: 'poll.reset', id }),
    'poll-remove': () => confirm('Supprimer ce sondage ?') && send({ type: 'poll.remove', id }),
    'poll-place': () => { const p = S.polls.find((x) => x.id === id); placeCue({ type: 'poll', pollId: id, name: 'Sondage : ' + p.question }); },
    'qa-toggle': () => send({ type: 'qa.toggle' }),
    'qa-set': () => send({ type: 'qa.update', id, status: b.dataset.status }),
  };
  A[b.dataset.act]?.();
});

document.addEventListener('dblclick', (e) => {
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
    if (el.dataset.lop === 'opacity') throttled('op' + id, () => send({ type: 'comp.layer.update', id, patch: { opacity: Number(el.value) } }));
    return;
  }
  if (el.dataset.bind && el.type === 'range') {
    const [target, path] = el.dataset.bind.split(':');
    const v = Number(el.value);
    const out = el.parentElement.querySelector('output');
    if (out) out.textContent = fmt2(v) + (out.textContent.endsWith('°') ? '°' : out.textContent.endsWith('×') ? '×' : '');
    const obj = targetObj(target);
    throttled('b' + el.dataset.bind, () => setTarget(target, setPath(obj, path, v)));
    if (obj && path.includes('.')) { const [a, b2] = path.split('.'); obj[a] = { ...(obj[a] || {}), [b2]: v }; } // garde la valeur locale pour les envois suivants
    return;
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

$('#show-name').addEventListener('change', (e) => send({ type: 'show.rename', name: e.target.value }));
$('#blackout').onclick = () => send({ type: 'blackout.toggle' });
$('#clear-all').onclick = () => send({ type: 'comp.clear' });
$('#master').oninput = (e) => throttled('master', () => send({ type: 'comp.master', value: Number(e.target.value) }));
$('#master').onchange = (e) => e.target.blur();
$('#timer-toggle').onclick = () => send({ type: S.timer.running ? 'timer.pause' : 'timer.start' });
$('#timer-reset').onclick = () => send({ type: 'timer.reset' });

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
      ['Supprimer la colonne', () => confirm('Supprimer cette colonne ?') && send({ type: 'comp.column.remove', index: i })],
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
    ['Supprimer le clip', () => confirm('Supprimer ce clip ?') && send({ type: 'cue.remove', id: cid })],
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
  td.textContent = fmtTime(v, true);
  td.className = 'timer-display' + (S.timer.mode === 'down' ? (v < 0 ? ' over' : v < 120000 ? ' warn' : '') : '');
  $('#timer-toggle').textContent = S.timer.running ? '⏸' : '▶';
  for (const [layerId, pb] of Object.entries(S.live.comp.pb || {})) {
    const row = document.querySelector(`[data-tp="${layerId}"]`);
    if (!row) continue;
    const vid = outMon.layers.get(layerId)?.stage.current?.video;
    const dur = vid?.duration || 0;
    const cue = cueById(S.live.comp.active?.[layerId]);
    let tt = pb.playing ? ((now - pb.startedAt) / 1000) * (cue?.speed || 1) : pb.offset;
    if (dur && (cue?.loopMode || 'loop') === 'loop') tt %= dur;
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
