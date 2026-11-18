// Éditeur de mapping d'une sortie : zones de projection déformables par leurs
// 4 coins, recadrage de la source, fondu de bord. L'aperçu est la vraie page de
// sortie (même rendu que le projecteur) et chaque réglage part en direct.
import { esc } from '/shared/client.js';

const uid = () => 'zn_' + Math.random().toString(36).slice(2, 10);
const r4 = (v) => Math.round(v * 10000) / 10000;
const CORNER_NAMES = ['haut-gauche', 'haut-droite', 'bas-droite', 'bas-gauche'];
const COLORS = ['#22d3ee', '#f472b6', '#a3e635', '#facc15'];

const newZone = (n, patch = {}) => ({
  id: uid(), name: `Zone ${n}`, source: '', corners: [[0, 0], [1, 0], [1, 1], [0, 1]],
  crop: { x: 0, y: 0, w: 1, h: 1 }, blend: { l: 0, r: 0, t: 0, b: 0 }, gamma: 2.2, opacity: 1, visible: true, ...patch,
});

export function openMappingEditor({ getState, send, outputId }) {
  const out0 = getState().outputs.find((o) => o.id === outputId);
  if (!out0) return;
  let zones = structuredClone(out0.zones?.length ? out0.zones : [newZone(1)]);
  let selZone = zones[0].id;
  let selCorner = null;
  const res = out0.resolution || { w: 1920, h: 1080 };

  const root = document.createElement('div');
  root.className = 'modal';
  root.innerHTML = `<div class="modal-box map-ed">
    <header class="modal-head"><b>Mapping — ${esc(out0.name)}</b><span class="hint">${res.w}×${res.h}${out0.resolution ? '' : ' (résolution supposée : ouvrez la sortie pour la détecter)'}</span>
      <div class="spacer"></div>
      <label class="check"><input type="checkbox" class="me-on"> Mapping actif</label>
      <label class="check"><input type="checkbox" class="me-test"> Mire de calage</label>
      <button class="btn primary" data-close>Terminer</button></header>
    <div class="se-body">
      <div class="se-main">
        <div class="me-canvas" style="aspect-ratio:${res.w}/${res.h}">
          <iframe class="me-frame" src="/output/?id=${encodeURIComponent(outputId)}&preview=1" tabindex="-1"></iframe>
          <svg class="me-svg" viewBox="0 0 1000 ${Math.round((1000 * res.h) / res.w)}" preserveAspectRatio="none"></svg>
        </div>
        <p class="hint">Tirez les poignées pour caler chaque coin sur la surface réelle (trapèze, écran incliné, décor). Glissez l'intérieur pour déplacer la zone. Flèches = 1 pixel (Maj = 10).</p>
      </div>
      <aside class="se-side">
        <div class="row wrap"><button class="btn sm primary" data-add-zone>＋ Zone</button>
          <button class="btn sm" data-preset="left">Raccord : gauche</button><button class="btn sm" data-preset="right">Raccord : droite</button></div>
        <div class="me-zones"></div><div class="se-props me-props"></div>
      </aside>
    </div></div>`;
  document.body.append(root);
  const $ = (s) => root.querySelector(s);
  const svg = $('.me-svg');
  const VW = 1000, VH = Math.round((1000 * res.h) / res.w);
  $('.me-on').checked = out0.mapping !== false || !out0.zones?.length;
  $('.me-test').checked = !!out0.testPattern;

  let pushT = null;
  const push = () => {
    if (pushT) return;
    pushT = setTimeout(() => { pushT = null; send({ type: 'output.update', id: outputId, patch: { zones, mapping: $('.me-on').checked } }); }, 60);
  };
  push();
  const zone = () => zones.find((z) => z.id === selZone);

  function drawSvg() {
    svg.innerHTML = zones.map((z, i) => {
      const col = COLORS[i % 4];
      const pts = z.corners.map(([x, y]) => `${x * VW},${y * VH}`).join(' ');
      const sel = z.id === selZone;
      return `<g data-zone="${z.id}" class="${sel ? 'sel' : ''}">
        <polygon points="${pts}" fill="${sel ? 'rgba(59,130,246,.10)' : 'transparent'}" stroke="${col}" stroke-width="${sel ? 3 : 1.5}" vector-effect="non-scaling-stroke" data-move="${z.id}"/>
        ${sel ? z.corners.map(([x, y], k) => `<circle cx="${x * VW}" cy="${y * VH}" r="10" fill="${selCorner === k ? col : '#fff'}" stroke="${col}" stroke-width="3" data-corner="${k}" vector-effect="non-scaling-stroke"/>`).join('') : ''}
      </g>`;
    }).join('');
  }

  function renderSide() {
    $('.me-zones').innerHTML = zones.map((z, i) => `<div class="se-li${z.id === selZone ? ' sel' : ''}" data-zsel="${z.id}">
      <span style="color:${COLORS[i % 4]}">■</span><span class="nm">${esc(z.name)}</span><span class="hint">${z.visible === false ? 'masquée' : ''}</span><span></span></div>`).join('');
    const z = zone();
    if (!z) { $('.me-props').innerHTML = ''; return; }
    const S = getState();
    const sources = [['', 'Comme la sortie'], ['program', 'Programme'], ['clean', 'Programme sans habillage'], ['preview', 'Preview'], ...S.cues.map((c) => ['cue:' + c.id, 'Fixe : ' + c.name])];
    const pct = (v) => Math.round(v * 1000) / 10;
    const inp = (grp, k, v, max = 100) => `<input type="number" step="0.5" min="0" max="${max}" data-grp="${grp}" data-k="${k}" value="${pct(v)}">`;
    const cornerInfo = selCorner != null
      ? `<div class="field"><span>Coin ${CORNER_NAMES[selCorner]} (pixels)</span><div class="grid2">
          <input type="number" step="1" data-corner-axis="0" value="${Math.round(z.corners[selCorner][0] * res.w)}">
          <input type="number" step="1" data-corner-axis="1" value="${Math.round(z.corners[selCorner][1] * res.h)}"></div></div>` : '<span class="hint">Cliquez une poignée pour la régler au pixel près.</span>';
    $('.me-props').innerHTML = `
      <label class="field"><span>Nom</span><input data-k="name" value="${esc(z.name)}"></label>
      <label class="field"><span>Source affichée</span><select data-k="source">${sources.map(([v, l]) => `<option value="${esc(v)}"${v === (z.source || '') ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
      ${cornerInfo}
      <div class="field"><span>Partie de la source (x, y, largeur, hauteur %)</span><div class="grid4">${inp('crop', 'x', z.crop.x)}${inp('crop', 'y', z.crop.y)}${inp('crop', 'w', z.crop.w)}${inp('crop', 'h', z.crop.h)}</div></div>
      <div class="field"><span>Fondu de bord % (gauche, droite, haut, bas)</span><div class="grid4">${inp('blend', 'l', z.blend.l, 50)}${inp('blend', 'r', z.blend.r, 50)}${inp('blend', 't', z.blend.t, 50)}${inp('blend', 'b', z.blend.b, 50)}</div></div>
      <div class="grid2"><label class="field"><span>Gamma du fondu</span><input type="number" step="0.1" min="1" max="3" data-k="gamma" value="${z.gamma ?? 2.2}"></label>
        <label class="field"><span>Opacité %</span><input type="number" step="1" min="0" max="100" data-k="opacity" value="${pct(z.opacity ?? 1)}"></label></div>
      <label class="check"><input type="checkbox" data-k="visible"${z.visible !== false ? ' checked' : ''}> Zone visible</label>
      <div class="row wrap"><button class="btn sm" data-op="reset">Coins par défaut</button><button class="btn sm" data-op="dup">Dupliquer</button><button class="btn sm danger" data-op="del">Supprimer</button></div>`;
  }
  const renderAll = () => { drawSvg(); renderSide(); };

  // ---- glisser coins / zone
  const toNorm = (e) => {
    const r = svg.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  };
  svg.addEventListener('pointerdown', (e) => {
    const g = e.target.closest('[data-zone]');
    if (!g) return;
    e.preventDefault();
    const z = zones.find((x) => x.id === g.dataset.zone);
    selZone = z.id;
    const k = e.target.dataset.corner;
    selCorner = k != null ? +k : null;
    const start = toNorm(e);
    const orig = structuredClone(z.corners);
    svg.setPointerCapture(e.pointerId);
    renderAll();
    const move = (ev) => {
      const [x, y] = toNorm(ev);
      const dx = x - start[0], dy = y - start[1];
      if (selCorner != null) z.corners[selCorner] = [r4(orig[selCorner][0] + dx), r4(orig[selCorner][1] + dy)];
      else z.corners = orig.map(([cx, cy]) => [r4(cx + dx), r4(cy + dy)]);
      drawSvg();
      push();
    };
    const up = () => { svg.removeEventListener('pointermove', move); svg.removeEventListener('pointerup', up); renderSide(); };
    svg.addEventListener('pointermove', move);
    svg.addEventListener('pointerup', up);
  });

  root.addEventListener('click', (e) => {
    const t = e.target;
    if (t.closest('[data-close]')) return close();
    const zs = t.closest('[data-zsel]');
    if (zs) { selZone = zs.dataset.zsel; selCorner = null; renderAll(); return; }
    if (t.closest('[data-add-zone]')) {
      const z = newZone(zones.length + 1, { corners: [[0.25, 0.25], [0.75, 0.25], [0.75, 0.75], [0.25, 0.75]] });
      zones.push(z); selZone = z.id; selCorner = null; push(); renderAll(); return;
    }
    const pre = t.closest('[data-preset]')?.dataset.preset;
    if (pre) {
      // Raccord de 2 projecteurs : chacun affiche un peu plus de la moitié de l'image,
      // avec une zone de recouvrement de 10 % fondue de chaque côté.
      const overlap = 0.1, w = 0.5 + overlap / 2;
      const z = zone() || zones[0];
      Object.assign(z, pre === 'left'
        ? { crop: { x: 0, y: 0, w, h: 1 }, blend: { l: 0, r: r4(overlap / w), t: 0, b: 0 } }
        : { crop: { x: r4(1 - w), y: 0, w, h: 1 }, blend: { l: r4(overlap / w), r: 0, t: 0, b: 0 } });
      push(); renderAll(); return;
    }
    const op = t.closest('[data-op]')?.dataset.op;
    const z = zone();
    if (op && z) {
      if (op === 'reset') z.corners = [[0, 0], [1, 0], [1, 1], [0, 1]];
      if (op === 'dup') { const d = { ...structuredClone(z), id: uid(), name: z.name + ' (copie)' }; zones.push(d); selZone = d.id; }
      if (op === 'del') { zones = zones.filter((x) => x !== z); selZone = zones[0]?.id; }
      selCorner = null; push(); renderAll();
    }
  });
  root.addEventListener('change', (e) => {
    const t = e.target;
    if (t.classList.contains('me-on')) push();
    if (t.classList.contains('me-test')) send({ type: 'output.update', id: outputId, patch: { testPattern: t.checked } });
  });
  root.addEventListener('input', (e) => {
    const t = e.target, z = zone();
    if (!z || !t.closest('.me-props')) return;
    if (t.dataset.cornerAxis != null) {
      const ax = +t.dataset.cornerAxis;
      z.corners[selCorner][ax] = r4((+t.value || 0) / (ax ? res.h : res.w));
    } else if (t.dataset.grp) z[t.dataset.grp] = { ...z[t.dataset.grp], [t.dataset.k]: (+t.value || 0) / 100 };
    else if (t.dataset.k === 'visible') z.visible = t.checked;
    else if (t.dataset.k === 'opacity') z.opacity = (+t.value || 0) / 100;
    else if (t.dataset.k === 'gamma') z.gamma = +t.value || 2.2;
    else if (t.dataset.k) z[t.dataset.k] = t.value;
    push();
    drawSvg();
    if (t.tagName === 'SELECT' || t.type === 'checkbox') renderSide();
  });

  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); return close(); }
    e.stopPropagation();
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    const z = zone();
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!z || !d) return;
    e.preventDefault();
    const m = e.shiftKey ? 10 : 1;
    const dx = (d[0] * m) / res.w, dy = (d[1] * m) / res.h;
    const idx = selCorner != null ? [selCorner] : [0, 1, 2, 3];
    for (const k of idx) z.corners[k] = [r4(z.corners[k][0] + dx), r4(z.corners[k][1] + dy)];
    push(); renderAll();
  };
  window.addEventListener('keydown', onKey, true);

  function close() {
    clearTimeout(pushT); pushT = null;
    send({ type: 'output.update', id: outputId, patch: { zones, mapping: $('.me-on').checked } });
    window.removeEventListener('keydown', onKey, true);
    root.remove();
  }
  renderAll();
}
