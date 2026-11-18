// Éditeur de scène : placement des sources (calques) à la souris, avec rendu réel
// en fond. Chaque modification part en direct : si la scène est à l'antenne,
// l'écran public se met à jour pendant le réglage.
import { esc } from '/shared/client.js';
import { Stage, describe } from '/shared/renderer.js';

const ICON = { slides: '📑', video: '🎬', image: '🖼', audio: '🎵', web: '🌐', camera: '🎥', ndi: '📡', poll: '📊', qa: '💬', title: '🅃', black: '⬛' };
const uid = () => 'ly_' + Math.random().toString(36).slice(2, 10);
const round = (v) => Math.round(v * 1000) / 1000;
const SNAP = 0.012;

const PRESETS = {
  full: { label: 'Plein écran', boxes: [[0, 0, 1, 1]] },
  side: { label: 'Côte à côte', boxes: [[0.02, 0.235, 0.47, 0.53], [0.51, 0.235, 0.47, 0.53]] },
  pip: { label: 'Incrustation', boxes: [[0, 0, 1, 1], [0.68, 0.64, 0.28, 0.28]] },
  talk: { label: 'Diapo + intervenant', boxes: [[0.03, 0.14, 0.64, 0.64], [0.7, 0.3, 0.27, 0.4]] },
  grid: { label: 'Grille 2×2', boxes: [[0, 0, 0.5, 0.5], [0.5, 0, 0.5, 0.5], [0, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]] },
};

export function openSceneEditor({ getState, send, cueId, client }) {
  const S0 = getState();
  const cue = S0.cues.find((c) => c.id === cueId);
  if (!cue) return;
  let layers = structuredClone(cue.layers || []);
  let background = cue.background || '#000000';
  let selId = layers[layers.length - 1]?.id || null;

  const root = document.createElement('div');
  root.className = 'modal';
  root.innerHTML = `<div class="modal-box scene-ed">
    <header class="modal-head"><b>Scène</b><input class="se-name" value="${esc(cue.name)}">
      <div class="spacer"></div>
      <span class="hint">Préréglages</span>${Object.entries(PRESETS).map(([k, p]) => `<button class="btn sm" data-preset="${k}">${p.label}</button>`).join('')}
      <button class="btn primary" data-close>Terminer</button></header>
    <div class="se-body">
      <div class="se-main">
        <div class="se-canvas"><div class="se-stage"></div><div class="se-boxes"></div></div>
        <div class="se-toolbar">
          <select class="se-add-src"></select><button class="btn sm primary" data-se-add>＋ Ajouter le calque</button>
          <div class="spacer"></div>
          <label class="check"><input type="checkbox" class="se-transparent"> Fond transparent (habillage)</label>
          <input type="color" class="se-bg">
        </div>
        <p class="hint">Glissez pour déplacer, tirez les coins pour redimensionner (Maj = garder les proportions). Flèches = ajuster finement, Suppr = retirer.</p>
      </div>
      <aside class="se-side"><h2>Calques <span class="hint">(le dernier est au-dessus)</span></h2><div class="se-layers"></div><div class="se-props"></div></aside>
    </div></div>`;
  document.body.append(root);
  const $ = (s) => root.querySelector(s);
  const canvas = $('.se-canvas');
  const boxes = $('.se-boxes');
  const preview = new Stage($('.se-stage'), { client, monitor: true });

  const sources = () => getState().cues.filter((c) => c.type !== 'scene');
  const srcName = (id) => { const c = getState().cues.find((x) => x.id === id); return c ? c.name : 'Aucune source'; };
  const sel = () => layers.find((l) => l.id === selId);

  // ---------- envoi au serveur (limité à ~12 fois / s pendant un glisser)
  let pushT = null, pushPending = false;
  function push() {
    pushPending = true;
    if (pushT) return;
    pushT = setTimeout(() => { pushT = null; if (pushPending) { pushPending = false; send({ type: 'cue.update', id: cueId, patch: { layers, background } }); } }, 80);
  }

  function draftState() {
    const st = getState();
    return { ...st, cues: st.cues.map((c) => (c.id === cueId ? { ...c, layers, background } : c)) };
  }

  function render(full = true) {
    const st = draftState();
    preview.update(st, describe(st, { cueId, slide: 1 }));
    boxes.innerHTML = layers.map((l, i) => `<div class="se-box${l.id === selId ? ' sel' : ''}${l.visible === false ? ' off' : ''}" data-id="${l.id}"
        style="left:${l.x * 100}%;top:${l.y * 100}%;width:${l.w * 100}%;height:${l.h * 100}%;z-index:${i + 1}">
        <span class="se-label">${i + 1}. ${esc(l.name || srcName(l.cueId))}</span>
        ${['nw', 'ne', 'se', 'sw'].map((h) => `<i data-h="${h}" class="h-${h}"></i>`).join('')}</div>`).join('');
    if (!full) return;
    $('.se-layers').innerHTML = [...layers].reverse().map((l) => {
      const c = getState().cues.find((x) => x.id === l.cueId);
      return `<div class="se-li${l.id === selId ? ' sel' : ''}" data-id="${l.id}"><span>${ICON[c?.type] || '▫'}</span>
        <span class="nm">${esc(l.name || srcName(l.cueId))}</span>${l.main ? '<span class="tag flag">PRINCIPAL</span>' : ''}
        <button class="btn sm ghost" data-vis="${l.id}" title="Afficher / masquer">${l.visible === false ? '◌' : '●'}</button></div>`;
    }).join('') || '<p class="hint">Aucun calque : ajoutez une source ci-dessous.</p>';
    $('.se-add-src').innerHTML = sources().map((c) => `<option value="${c.id}">${ICON[c.type] || ''} ${esc(c.name)}</option>`).join('');
    $('.se-transparent').checked = background === 'transparent';
    $('.se-bg').value = background === 'transparent' ? '#000000' : background;
    renderProps();
  }

  function renderProps() {
    const l = sel();
    const p = $('.se-props');
    if (!l) { p.innerHTML = ''; return; }
    const c = getState().cues.find((x) => x.id === l.cueId);
    const pct = (v) => Math.round(v * 1000) / 10;
    const num = (k, v, step = 0.5) => `<label class="field"><span>${k.toUpperCase()} %</span><input type="number" step="${step}" data-k="${k}" value="${pct(v)}"></label>`;
    p.innerHTML = `
      <label class="field"><span>Source</span><select data-k="cueId">${sources().map((s) => `<option value="${s.id}"${s.id === l.cueId ? ' selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
      <label class="field"><span>Nom du calque</span><input data-k="name" value="${esc(l.name || '')}" placeholder="${esc(srcName(l.cueId))}"></label>
      <div class="grid4">${num('x', l.x)}${num('y', l.y)}${num('w', l.w)}${num('h', l.h)}</div>
      <label class="field"><span>Opacité ${Math.round((l.opacity ?? 1) * 100)} %</span><input type="range" min="0" max="1" step="0.01" data-k="opacity" value="${l.opacity ?? 1}"></label>
      <div class="grid2"><label class="field"><span>Ajustement</span><select data-k="fit">
        ${[['contain', 'Entier (bandes)'], ['cover', 'Remplir (recadré)'], ['fill', 'Étirer']].map(([v, t]) => `<option value="${v}"${l.fit === v ? ' selected' : ''}>${t}</option>`).join('')}</select></label>
        <label class="field"><span>Arrondi %</span><input type="number" min="0" max="50" step="1" data-k="radius" value="${pct(l.radius || 0)}"></label></div>
      <div class="field"><span>Recadrage % (gauche, haut, droite, bas)</span><div class="grid4">
        ${['l', 't', 'r', 'b'].map((k) => `<input type="number" min="0" max="90" step="0.5" data-crop="${k}" value="${pct(l.crop?.[k] || 0)}">`).join('')}</div></div>
      ${c?.type === 'slides' ? `<label class="check"><input type="checkbox" data-k="main"${l.main ? ' checked' : ''}> Calque principal : suivant / précédent pilote cette présentation</label>
        ${l.main ? '' : `<label class="field"><span>Diapo affichée</span><input type="number" min="1" data-k="slide" value="${l.slide || 1}"></label>`}` : ''}
      <div class="row wrap"><button class="btn sm" data-op="front">Premier plan</button><button class="btn sm" data-op="up">▲</button><button class="btn sm" data-op="down">▼</button>
        <button class="btn sm" data-op="fill">Plein cadre</button><button class="btn sm" data-op="center">Centrer</button>
        <button class="btn sm" data-op="dup">Dupliquer</button><button class="btn sm danger" data-op="del">Supprimer</button></div>`;
  }

  // ---------- interactions
  root.addEventListener('click', (e) => {
    const t = e.target;
    if (t.closest('[data-close]')) return close();
    const pre = t.closest('[data-preset]')?.dataset.preset;
    if (pre) {
      const list = PRESETS[pre].boxes;
      // Complète avec des calques vides si besoin, en reprenant les sources dans l'ordre du conducteur.
      while (layers.length < list.length) {
        const used = new Set(layers.map((l) => l.cueId));
        const src = sources().find((c) => !used.has(c.id)) || sources()[0];
        if (!src) break;
        layers.push(newLayer(src.id));
      }
      list.forEach(([x, y, w, h], i) => layers[i] && Object.assign(layers[i], { x, y, w, h, crop: { l: 0, t: 0, r: 0, b: 0 } }));
      push(); render();
      return;
    }
    if (t.closest("[data-se-add]")) {
      const id = $('.se-add-src').value;
      if (!id) return;
      const n = layers.length;
      const l = newLayer(id);
      if (n) Object.assign(l, { x: 0.55, y: 0.55, w: 0.4, h: 0.4 });
      layers.push(l); selId = l.id; push(); render();
      return;
    }
    const vis = t.closest('[data-vis]')?.dataset.vis;
    if (vis) { const l = layers.find((x) => x.id === vis); l.visible = l.visible === false; push(); render(); return; }
    const li = t.closest('.se-li');
    if (li) { selId = li.dataset.id; render(); return; }
    const op = t.closest('[data-op]')?.dataset.op;
    const l = sel();
    if (op && l) {
      const i = layers.indexOf(l);
      if (op === 'del') { layers.splice(i, 1); selId = layers[layers.length - 1]?.id; }
      if (op === 'dup') { const d = { ...structuredClone(l), id: uid(), x: round(l.x + 0.03), y: round(l.y + 0.03), main: false }; layers.splice(i + 1, 0, d); selId = d.id; }
      if (op === 'up' && i < layers.length - 1) [layers[i], layers[i + 1]] = [layers[i + 1], layers[i]];
      if (op === 'down' && i > 0) [layers[i], layers[i - 1]] = [layers[i - 1], layers[i]];
      if (op === 'front') { layers.splice(i, 1); layers.push(l); }
      if (op === 'fill') Object.assign(l, { x: 0, y: 0, w: 1, h: 1 });
      if (op === 'center') Object.assign(l, { x: round((1 - l.w) / 2), y: round((1 - l.h) / 2) });
      push(); render();
    }
  });

  root.addEventListener('change', (e) => {
    const t = e.target;
    if (t.classList.contains('se-name')) send({ type: 'cue.update', id: cueId, patch: { name: t.value } });
    if (t.classList.contains('se-transparent')) { background = t.checked ? 'transparent' : $('.se-bg').value; push(); render(); }
    if (t.classList.contains('se-bg')) { background = t.value; $('.se-transparent').checked = false; push(); render(); }
  });
  root.addEventListener('input', (e) => {
    const t = e.target, l = sel();
    if (!l || !t.closest('.se-props')) return;
    const k = t.dataset.k;
    if (t.dataset.crop) l.crop = { ...l.crop, [t.dataset.crop]: Math.max(0, Math.min(0.9, +t.value / 100)) };
    else if (['x', 'y', 'w', 'h', 'radius'].includes(k)) l[k] = (+t.value || 0) / 100;
    else if (k === 'opacity') l.opacity = +t.value;
    else if (k === 'main') { for (const o of layers) o.main = false; l.main = t.checked; }
    else if (k === 'slide') l.slide = Math.max(1, +t.value || 1);
    else if (k) l[k] = t.value;
    push();
    // Les champs texte gardent le focus : on ne reconstruit que les boîtes.
    render(t.type === 'checkbox' || t.tagName === 'SELECT');
  });

  // Glisser / redimensionner
  canvas.addEventListener('pointerdown', (e) => {
    const box = e.target.closest('.se-box');
    if (!box) return;
    e.preventDefault();
    selId = box.dataset.id;
    const l = sel();
    const handle = e.target.dataset.h;
    const r = canvas.getBoundingClientRect();
    const start = { x: l.x, y: l.y, w: l.w, h: l.h, px: e.clientX, py: e.clientY };
    const others = layers.filter((o) => o !== l && o.visible !== false);
    const xs = [0, 0.5, 1, ...others.flatMap((o) => [o.x, o.x + o.w])];
    const ys = [0, 0.5, 1, ...others.flatMap((o) => [o.y, o.y + o.h])];
    const snap = (v, list) => { for (const s of list) if (Math.abs(v - s) < SNAP) return s; return v; };
    canvas.setPointerCapture(e.pointerId);
    render();
    const move = (ev) => {
      const dx = (ev.clientX - start.px) / r.width, dy = (ev.clientY - start.py) / r.height;
      if (!handle) {
        let x = start.x + dx, y = start.y + dy;
        // Aimantation sur les bords, le centre et les autres calques.
        const sx = snap(x, xs), sx2 = snap(x + l.w, xs) - l.w;
        x = sx !== x ? sx : sx2;
        const sy = snap(y, ys), sy2 = snap(y + l.h, ys) - l.h;
        y = sy !== y ? sy : sy2;
        if (Math.abs(x + l.w / 2 - 0.5) < SNAP) x = 0.5 - l.w / 2;
        if (Math.abs(y + l.h / 2 - 0.5) < SNAP) y = 0.5 - l.h / 2;
        l.x = round(x); l.y = round(y);
      } else {
        let { x, y, w, h } = start;
        if (handle.includes('e')) w = snap(start.x + start.w + dx, xs) - x;
        if (handle.includes('s')) h = snap(start.y + start.h + dy, ys) - y;
        if (handle.includes('w')) { const nx = snap(start.x + dx, xs); w = start.x + start.w - nx; x = nx; }
        if (handle.includes('n')) { const ny = snap(start.y + dy, ys); h = start.y + start.h - ny; y = ny; }
        if (ev.shiftKey) {
          const ratio = start.w / start.h;
          h = w / ratio;
          if (handle.includes('n')) y = start.y + start.h - h;
        }
        if (w > 0.02 && h > 0.02) Object.assign(l, { x: round(x), y: round(y), w: round(w), h: round(h) });
      }
      push();
      render(false);
    };
    const up = () => { canvas.removeEventListener('pointermove', move); canvas.removeEventListener('pointerup', up); render(); };
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
  });

  // Clavier : capturé pour ne pas déclencher les raccourcis de régie (TAKE, suivant…)
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); return close(); }
    const t = e.target;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName);
    e.stopPropagation();
    if (typing) return;
    const l = sel();
    if (!l) return;
    const step = e.shiftKey ? 0.05 : 0.005;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (d) { e.preventDefault(); l.x = round(l.x + d[0]); l.y = round(l.y + d[1]); push(); render(false); renderProps(); }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); layers = layers.filter((x) => x !== l); selId = layers[layers.length - 1]?.id; push(); render(); }
  };
  window.addEventListener('keydown', onKey, true);

  function newLayer(cid) {
    const c = getState().cues.find((x) => x.id === cid);
    const hasMain = layers.some((x) => x.main);
    return { id: uid(), cueId: cid, name: '', x: 0, y: 0, w: 1, h: 1, opacity: 1, fit: 'contain', crop: { l: 0, t: 0, r: 0, b: 0 }, radius: 0, visible: true, main: !hasMain && c?.type === 'slides', slide: 1 };
  }

  function close() {
    if (pushT) { clearTimeout(pushT); pushT = null; }
    send({ type: 'cue.update', id: cueId, patch: { layers, background } });
    window.removeEventListener('keydown', onKey, true);
    preview.destroy();
    root.remove();
  }

  render();
}
