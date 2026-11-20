// Éditeur de mapping d'une sortie : zones de projection déformables par leurs
// 4 coins (avec cadenas de proportions), grille de déformation, masques
// dessinés, une source par zone, recadrage et fondu de bord. L'aperçu est la
// vraie page de sortie et chaque réglage part en direct.
import { esc } from '/shared/client.js';
import { homography, applyH, invertH, quadOk, meshOffset } from '/shared/mapping.js';

const uid = (p = 'zn_') => p + Math.random().toString(36).slice(2, 10);
const r4 = (v) => Math.round(v * 10000) / 10000;
const CORNER_NAMES = ['haut-gauche', 'haut-droite', 'bas-droite', 'bas-gauche'];
const COLORS = ['#22d3ee', '#f472b6', '#a3e635', '#facc15'];
const GRIDS = [[0, 'Aucune'], [2, '3 × 3 points'], [3, '4 × 4 points'], [4, '5 × 5 points'], [6, '7 × 7 points'], [8, '9 × 9 points']];

const newZone = (n, patch = {}) => ({
  id: uid(), name: `Zone ${n}`, source: '', corners: [[0, 0], [1, 0], [1, 1], [0, 1]],
  crop: { x: 0, y: 0, w: 1, h: 1 }, blend: { l: 0, r: 0, t: 0, b: 0 }, gamma: 2.2, opacity: 1, visible: true,
  lock: false, mesh: null, masks: [], ...patch,
});

export function openMappingEditor({ getState, send, outputId }) {
  const out0 = getState().outputs.find((o) => o.id === outputId);
  if (!out0) return;
  let zones = structuredClone(out0.zones?.length ? out0.zones : [newZone(1)]);
  for (const z of zones) { z.masks ||= []; z.mesh ||= null; }
  let selZone = zones[0].id;
  let selCorner = null;
  let mode = 'corners'; // corners | mesh | masks
  let selMask = null;
  let drawing = null; // masque en cours de tracé : [[u, v], …]
  const res = out0.resolution || { w: 1920, h: 1080 };

  const root = document.createElement('div');
  root.className = 'modal';
  root.innerHTML = `<div class="modal-box map-ed">
    <header class="modal-head"><b>Mapping — ${esc(out0.name)}</b><span class="hint">${res.w}×${res.h}${out0.resolution ? '' : ' (résolution supposée : ouvrez la sortie pour la détecter)'}</span>
      <div class="seg me-modes"><button data-mode="corners">Coins</button><button data-mode="mesh">Grille</button><button data-mode="masks">Masques</button></div>
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
        <p class="hint me-help"></p>
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

  // Envoi au rythme de l'écran (30 par seconde au plus) : glissé fluide, jamais d'empilement.
  let pushRaf = null, lastPush = 0;
  const sendNow = () => send({ type: 'output.update', id: outputId, patch: { zones, mapping: $('.me-on').checked } });
  const push = () => {
    if (pushRaf) return;
    pushRaf = requestAnimationFrame(function tick() {
      if (performance.now() - lastPush < 33) { pushRaf = requestAnimationFrame(tick); return; }
      pushRaf = null; lastPush = performance.now(); sendNow();
    });
  };
  push();
  const zone = () => zones.find((z) => z.id === selZone);
  const Hof = (z) => homography(z.corners);
  const toView = (H, u, v) => { const [x, y] = applyH(H, u, v); return [x * VW, y * VH]; };

  const HELP = {
    corners: "Tirez les poignées pour caler chaque coin sur la surface réelle. Glissez l'intérieur pour déplacer la zone. Cadenas : un coin tiré agrandit ou réduit toute la zone en gardant son format. Flèches = 1 pixel (Maj = 10).",
    mesh: 'Choisissez une grille puis tirez ses points pour tordre l’image (surface courbe, décor, colonne…). Double-clic sur un point : le remettre à sa place.',
    masks: '« ＋ Masque » puis cliquez pour poser les points ; cliquez le premier point (ou Entrée) pour fermer. Tirez les points pour ajuster ; double-clic sur un point pour le supprimer.',
  };

  function drawSvg() {
    let html = '';
    zones.forEach((z, i) => {
      const col = COLORS[i % 4];
      const sel = z.id === selZone;
      const H = Hof(z);
      const pts = z.corners.map(([x, y]) => `${x * VW},${y * VH}`).join(' ');
      html += `<g data-zone="${z.id}" class="${sel ? 'sel' : ''}">
        <polygon points="${pts}" fill="${sel && mode === 'corners' ? 'rgba(59,130,246,.10)' : 'transparent'}" stroke="${col}" stroke-width="${sel ? 3 : 1.5}" vector-effect="non-scaling-stroke" data-move="${z.id}"/>`;
      if (sel && mode === 'corners') {
        html += z.corners.map(([x, y], k) => `<circle cx="${x * VW}" cy="${y * VH}" r="10" fill="${selCorner === k ? col : '#fff'}" stroke="${col}" stroke-width="3" data-corner="${k}" vector-effect="non-scaling-stroke"/>`).join('');
        if (z.lock) { const [cx, cy] = toView(H, 0.5, 0.5); html += `<text x="${cx}" y="${cy}" fill="#fff" font-size="26" text-anchor="middle" pointer-events="none">🔒</text>`; }
      }
      if (sel && mode === 'mesh' && z.mesh) {
        const { cols, rows, points } = z.mesh;
        const P = (a, b) => { const o = points[b * (cols + 1) + a]; return toView(H, a / cols + o[0], b / rows + o[1]); };
        let lines = '';
        for (let b = 0; b <= rows; b++) lines += `<polyline points="${Array.from({ length: cols + 1 }, (_, a) => P(a, b).join(',')).join(' ')}"/>`;
        for (let a = 0; a <= cols; a++) lines += `<polyline points="${Array.from({ length: rows + 1 }, (_, b) => P(a, b).join(',')).join(' ')}"/>`;
        html += `<g fill="none" stroke="${col}" stroke-width="1" opacity=".8" pointer-events="none">${lines}</g>`;
        for (let b = 0; b <= rows; b++) for (let a = 0; a <= cols; a++) {
          const [x, y] = P(a, b);
          html += `<circle cx="${x}" cy="${y}" r="7" fill="#fff" stroke="${col}" stroke-width="2" data-mesh="${b * (cols + 1) + a}" vector-effect="non-scaling-stroke"/>`;
        }
      }
      if (sel && mode === 'masks') {
        for (const m of z.masks) {
          const mp = m.points.map(([u, v]) => toView(H, u, v));
          const on = m.id === selMask;
          html += `<polygon points="${mp.map((p) => p.join(',')).join(' ')}" fill="${m.invert ? 'rgba(34,197,94,.18)' : 'rgba(239,68,68,.25)'}" stroke="${on ? '#fff' : '#ef4444'}" stroke-width="${on ? 2.5 : 1.5}" stroke-dasharray="${m.invert ? '6 4' : ''}" vector-effect="non-scaling-stroke" data-mask="${m.id}"/>`;
          if (on) html += mp.map(([x, y], k) => `<circle cx="${x}" cy="${y}" r="7" fill="#fff" stroke="#ef4444" stroke-width="2" data-mpt="${k}" vector-effect="non-scaling-stroke"/>`).join('');
        }
        if (drawing) {
          const dp = drawing.map(([u, v]) => toView(H, u, v));
          html += `<polyline points="${dp.map((p) => p.join(',')).join(' ')}" fill="none" stroke="#facc15" stroke-width="2" vector-effect="non-scaling-stroke" pointer-events="none"/>`;
          html += dp.map(([x, y], k) => `<circle cx="${x}" cy="${y}" r="${k ? 6 : 9}" fill="${k ? '#facc15' : '#111'}" stroke="#facc15" stroke-width="2" ${k ? '' : 'data-close-mask="1"'} vector-effect="non-scaling-stroke"/>`).join('');
        }
      }
      html += '</g>';
    });
    svg.innerHTML = html;
    root.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
    $('.me-help').textContent = HELP[mode];
    svg.style.cursor = drawing ? 'crosshair' : '';
  }

  function sourcesList(S) {
    return [['', 'Comme la sortie'], ['program', 'Programme'], ['clean', 'Programme sans habillage'], ['aux', 'Sortie AUX'],
      ...(S.comp?.layers || []).map((l, i) => ['layer:' + l.id, 'Calque : ' + (l.name || 'Calque ' + (i + 1))]),
      ...S.cues.map((c) => ['cue:' + c.id, 'Fixe : ' + c.name])];
  }

  function renderSide() {
    $('.me-zones').innerHTML = zones.map((z, i) => `<div class="se-li${z.id === selZone ? ' sel' : ''}" data-zsel="${z.id}">
      <span style="color:${COLORS[i % 4]}">■</span><span class="nm">${esc(z.name)}</span><span class="hint">${z.visible === false ? 'masquée' : ''}${z.lock ? ' 🔒' : ''}</span><span></span></div>`).join('');
    const z = zone();
    if (!z) { $('.me-props').innerHTML = ''; return; }
    const S = getState();
    const sources = sourcesList(S);
    const pct = (v) => Math.round(v * 1000) / 10;
    const inp = (grp, k, v, max = 100) => `<input type="number" step="0.5" min="0" max="${max}" data-grp="${grp}" data-k="${k}" value="${pct(v)}">`;
    const head = `
      <label class="field"><span>Nom</span><input data-k="name" value="${esc(z.name)}"></label>
      <label class="field"><span>Source de cette zone</span><select data-k="source">${sources.map(([v, l]) => `<option value="${esc(v)}"${v === (z.source || '') ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
    let body = '';
    if (mode === 'corners') {
      const cornerInfo = selCorner != null
        ? `<div class="field"><span>Coin ${CORNER_NAMES[selCorner]} (pixels)</span><div class="grid2">
            <input type="number" step="1" data-corner-axis="0" value="${Math.round(z.corners[selCorner][0] * res.w)}">
            <input type="number" step="1" data-corner-axis="1" value="${Math.round(z.corners[selCorner][1] * res.h)}"></div></div>` : '<span class="hint">Cliquez une poignée pour la régler au pixel près.</span>';
      body = `
        <label class="check"><input type="checkbox" data-k="lock"${z.lock ? ' checked' : ''}> 🔒 Cadenas : garder le format (un coin tiré met toute la zone à l'échelle)</label>
        <div class="row wrap"><span class="hint">Échelle</span><button class="btn sm" data-scale="0.98">−</button><button class="btn sm" data-scale="1.02">＋</button><button class="btn sm" data-op="fit">Format de la source</button></div>
        ${cornerInfo}
        <div class="field"><span>Partie de la source (x, y, largeur, hauteur %)</span><div class="grid4">${inp('crop', 'x', z.crop.x)}${inp('crop', 'y', z.crop.y)}${inp('crop', 'w', z.crop.w)}${inp('crop', 'h', z.crop.h)}</div></div>
        <div class="field"><span>Fondu de bord % (gauche, droite, haut, bas)</span><div class="grid4">${inp('blend', 'l', z.blend.l, 50)}${inp('blend', 'r', z.blend.r, 50)}${inp('blend', 't', z.blend.t, 50)}${inp('blend', 'b', z.blend.b, 50)}</div></div>
        <div class="grid2"><label class="field"><span>Gamma du fondu</span><input type="number" step="0.1" min="1" max="3" data-k="gamma" value="${z.gamma ?? 2.2}"></label>
          <label class="field"><span>Opacité %</span><input type="number" step="1" min="0" max="100" data-k="opacity" value="${pct(z.opacity ?? 1)}"></label></div>
        <label class="check"><input type="checkbox" data-k="visible"${z.visible !== false ? ' checked' : ''}> Zone visible</label>
        <div class="row wrap"><button class="btn sm" data-op="reset">Coins par défaut</button><button class="btn sm" data-op="dup">Dupliquer</button><button class="btn sm danger" data-op="del">Supprimer</button></div>`;
    } else if (mode === 'mesh') {
      const n = z.mesh?.cols || 0;
      body = `
        <label class="field"><span>Grille de déformation</span><select data-k="meshSize">${GRIDS.map(([v, l]) => `<option value="${v}"${v === n ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
        <span class="hint">Plus de points = déformation plus fine. La grille suit les 4 coins de la zone.</span>
        ${n ? '<div class="row wrap"><button class="btn sm" data-op="mesh-reset">Remettre la grille à plat</button></div>' : ''}`;
    } else {
      const m = z.masks.find((x) => x.id === selMask);
      body = `
        <div class="row wrap"><button class="btn sm primary" data-op="mask-draw">${drawing ? 'Fermer le masque' : '＋ Masque'}</button><button class="btn sm" data-op="mask-rect">＋ Rectangle</button>
          ${drawing ? '<button class="btn sm" data-op="mask-cancel">Annuler</button>' : ''}</div>
        <div class="se-layers">${z.masks.map((x, k) => `<div class="se-li${x.id === selMask ? ' sel' : ''}" data-msel="${x.id}"><span>${x.invert ? '◩' : '◼'}</span><span class="nm">Masque ${k + 1}</span><span class="hint">${x.invert ? 'garde l’intérieur' : 'cache'}</span><span></span></div>`).join('') || '<span class="hint">Aucun masque.</span>'}</div>
        ${m ? `<label class="check"><input type="checkbox" data-mk="invert"${m.invert ? ' checked' : ''}> Inverser : ne garder que l'intérieur</label>
          <label class="field"><span>Adoucissement du bord</span><input type="range" min="0" max="20" step="0.5" data-mk="feather" value="${m.feather || 0}"></label>
          <div class="row wrap"><button class="btn sm danger" data-op="mask-del">Supprimer ce masque</button></div>` : ''}`;
    }
    $('.me-props').innerHTML = head + body;
  }
  const renderAll = () => { drawSvg(); renderSide(); };

  // ---- glisser coins / zone / grille / masques
  const toNorm = (e) => {
    const r = svg.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  };
  const toUnit = (z, e) => { const [x, y] = toNorm(e); return applyH(invertH(Hof(z)), x, y); };
  const setCorners = (z, c) => { if (quadOk(c)) { z.corners = c.map(([x, y]) => [r4(x), r4(y)]); return true; } return false; };

  function drag(e, onMove) {
    svg.setPointerCapture(e.pointerId);
    let raf = null, lastEv = null;
    const move = (ev) => {
      lastEv = ev;
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = null; onMove(lastEv); drawSvg(); push(); });
    };
    const up = () => {
      cancelAnimationFrame(raf); raf = null;
      if (lastEv) { onMove(lastEv); drawSvg(); push(); }
      svg.removeEventListener('pointermove', move); svg.removeEventListener('pointerup', up); svg.removeEventListener('pointercancel', up);
      renderSide();
    };
    svg.addEventListener('pointermove', move);
    svg.addEventListener('pointerup', up);
    svg.addEventListener('pointercancel', up);
  }

  svg.addEventListener('pointerdown', (e) => {
    const z0 = zone();
    // Tracé d'un masque : chaque clic pose un point (dans le repère de la zone).
    if (mode === 'masks' && drawing && z0) {
      e.preventDefault();
      if (e.target.dataset.closeMask && drawing.length >= 3) return finishMask();
      const [u, v] = toUnit(z0, e);
      drawing.push([r4(u), r4(v)]);
      return drawSvg();
    }
    const g = e.target.closest('[data-zone]');
    if (!g) return;
    e.preventDefault();
    const z = zones.find((x) => x.id === g.dataset.zone);
    if (z.id !== selZone) { selZone = z.id; selCorner = null; selMask = null; renderAll(); if (mode !== 'corners') return; }
    const t = e.target;
    if (mode === 'mesh' && t.dataset.mesh != null && z.mesh) {
      const idx = +t.dataset.mesh, cols = z.mesh.cols;
      const base = [(idx % (cols + 1)) / cols, Math.floor(idx / (cols + 1)) / z.mesh.rows];
      return drag(e, (ev) => {
        const [u, v] = toUnit(z, ev);
        z.mesh.points[idx] = [r4(Math.max(-1, Math.min(1, u - base[0]))), r4(Math.max(-1, Math.min(1, v - base[1])))];
      });
    }
    if (mode === 'masks') {
      if (t.dataset.mpt != null) {
        const m = z.masks.find((x) => x.id === selMask), k = +t.dataset.mpt;
        return drag(e, (ev) => { const [u, v] = toUnit(z, ev); m.points[k] = [r4(Math.max(-1, Math.min(2, u))), r4(Math.max(-1, Math.min(2, v)))]; });
      }
      if (t.dataset.mask) {
        selMask = t.dataset.mask;
        const m = z.masks.find((x) => x.id === selMask);
        const start = toUnit(z, e), orig = structuredClone(m.points);
        renderSide();
        return drag(e, (ev) => { const [u, v] = toUnit(z, ev); m.points = orig.map(([a, b]) => [r4(a + u - start[0]), r4(b + v - start[1])]); });
      }
      return;
    }
    if (mode !== 'corners') return;
    const k = t.dataset.corner;
    selCorner = k != null ? +k : null;
    const start = toNorm(e);
    const orig = structuredClone(z.corners);
    renderAll();
    drag(e, (ev) => {
      const [x, y] = toNorm(ev);
      const dx = x - start[0], dy = y - start[1];
      if (selCorner == null) return setCorners(z, orig.map(([cx, cy]) => [cx + dx, cy + dy]));
      if (z.lock) {
        // Cadenas : mise à l'échelle autour du coin opposé, en gardant le format.
        const o = orig[(selCorner + 2) % 4], c = orig[selCorner];
        const vx = (c[0] - o[0]) * res.w, vy = (c[1] - o[1]) * res.h;
        const px = (c[0] + dx - o[0]) * res.w, py = (c[1] + dy - o[1]) * res.h;
        const s = Math.max(0.03, (px * vx + py * vy) / (vx * vx + vy * vy || 1));
        return setCorners(z, orig.map(([cx, cy]) => [o[0] + (cx - o[0]) * s, o[1] + (cy - o[1]) * s]));
      }
      const c = structuredClone(z.corners);
      c[selCorner] = [orig[selCorner][0] + dx, orig[selCorner][1] + dy];
      setCorners(z, c);
    });
  });

  svg.addEventListener('dblclick', (e) => {
    const z = zone(), t = e.target;
    if (!z) return;
    if (t.dataset.mesh != null && z.mesh) { z.mesh.points[+t.dataset.mesh] = [0, 0]; push(); drawSvg(); }
    if (t.dataset.mpt != null) {
      const m = z.masks.find((x) => x.id === selMask);
      if (m && m.points.length > 3) { m.points.splice(+t.dataset.mpt, 1); push(); drawSvg(); }
    }
  });

  function finishMask() {
    const z = zone();
    if (z && drawing?.length >= 3) { const m = { id: uid('mk_'), points: drawing, invert: false, feather: 0 }; z.masks.push(m); selMask = m.id; push(); }
    drawing = null; renderAll();
  }

  // Grille : changer sa finesse conserve la déformation déjà faite.
  function setMesh(z, n) {
    if (!n) { z.mesh = null; return; }
    const old = z.mesh;
    const points = [];
    for (let b = 0; b <= n; b++) for (let a = 0; a <= n; a++) points.push(old ? meshOffset(old, a / n, b / n).map(r4) : [0, 0]);
    z.mesh = { cols: n, rows: n, points };
  }

  function scaleZone(z, s) {
    const cx = z.corners.reduce((a, p) => a + p[0], 0) / 4, cy = z.corners.reduce((a, p) => a + p[1], 0) / 4;
    setCorners(z, z.corners.map(([x, y]) => [cx + (x - cx) * s, cy + (y - cy) * s]));
  }

  root.addEventListener('click', (e) => {
    const t = e.target;
    if (t.closest('[data-close]')) return close();
    const md = t.closest('[data-mode]')?.dataset.mode;
    if (md) { mode = md; drawing = null; selCorner = null; renderAll(); return; }
    const zs = t.closest('[data-zsel]');
    if (zs) { selZone = zs.dataset.zsel; selCorner = null; selMask = null; drawing = null; renderAll(); return; }
    const ms = t.closest('[data-msel]');
    if (ms) { selMask = ms.dataset.msel; renderAll(); return; }
    if (t.closest('[data-add-zone]')) {
      const z = newZone(zones.length + 1, { corners: [[0.25, 0.25], [0.75, 0.25], [0.75, 0.75], [0.25, 0.75]] });
      zones.push(z); selZone = z.id; selCorner = null; push(); renderAll(); return;
    }
    const sc = t.closest('[data-scale]')?.dataset.scale;
    if (sc && zone()) { scaleZone(zone(), +sc); push(); renderAll(); return; }
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
      if (op === 'fit') {
        // Rectangle centré au format de la partie de source affichée, même surface.
        const cx = z.corners.reduce((a, p) => a + p[0], 0) / 4, cy = z.corners.reduce((a, p) => a + p[1], 0) / 4;
        const ar = (z.crop.w * res.w) / (z.crop.h * res.h);
        const cur = Math.abs(((z.corners[1][0] - z.corners[0][0]) * res.w) * ((z.corners[3][1] - z.corners[0][1]) * res.h)) || res.w * res.h / 4;
        const hp = Math.sqrt(cur / ar), wp = hp * ar;
        const hw = wp / res.w / 2, hh = hp / res.h / 2;
        setCorners(z, [[cx - hw, cy - hh], [cx + hw, cy - hh], [cx + hw, cy + hh], [cx - hw, cy + hh]]);
      }
      if (op === 'dup') { const d = { ...structuredClone(z), id: uid(), name: z.name + ' (copie)' }; zones.push(d); selZone = d.id; }
      if (op === 'del') { zones = zones.filter((x) => x !== z); selZone = zones[0]?.id; }
      if (op === 'mesh-reset' && z.mesh) z.mesh.points = z.mesh.points.map(() => [0, 0]);
      if (op === 'mask-draw') { if (drawing) return finishMask(); drawing = []; selMask = null; }
      if (op === 'mask-cancel') drawing = null;
      if (op === 'mask-rect') {
        const m = { id: uid('mk_'), points: [[0.35, 0.35], [0.65, 0.35], [0.65, 0.65], [0.35, 0.65]], invert: false, feather: 0 };
        z.masks.push(m); selMask = m.id;
      }
      if (op === 'mask-del') { z.masks = z.masks.filter((m) => m.id !== selMask); selMask = null; }
      if (!['mask-draw', 'mask-cancel'].includes(op)) selCorner = null;
      push(); renderAll();
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
      const ax = +t.dataset.cornerAxis, c = structuredClone(z.corners);
      c[selCorner][ax] = (+t.value || 0) / (ax ? res.h : res.w);
      setCorners(z, c);
    } else if (t.dataset.mk) {
      const m = z.masks.find((x) => x.id === selMask);
      if (m) m[t.dataset.mk] = t.type === 'checkbox' ? t.checked : +t.value;
      if (t.type === 'checkbox') renderSide();
    } else if (t.dataset.grp) z[t.dataset.grp] = { ...z[t.dataset.grp], [t.dataset.k]: (+t.value || 0) / 100 };
    else if (t.dataset.k === 'visible' || t.dataset.k === 'lock') z[t.dataset.k] = t.checked;
    else if (t.dataset.k === 'opacity') z.opacity = (+t.value || 0) / 100;
    else if (t.dataset.k === 'gamma') z.gamma = +t.value || 2.2;
    else if (t.dataset.k === 'meshSize') setMesh(z, +t.value);
    else if (t.dataset.k) z[t.dataset.k] = t.value;
    push();
    drawSvg();
    if (t.tagName === 'SELECT' || t.type === 'checkbox') renderSide();
  });

  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); if (drawing) { drawing = null; renderAll(); return; } return close(); }
    e.stopPropagation();
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (e.key === 'Enter' && drawing) { e.preventDefault(); return finishMask(); }
    const z = zone();
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!z || !d || mode !== 'corners') return;
    e.preventDefault();
    const m = e.shiftKey ? 10 : 1;
    const dx = (d[0] * m) / res.w, dy = (d[1] * m) / res.h;
    const idx = selCorner != null ? [selCorner] : [0, 1, 2, 3];
    const c = structuredClone(z.corners);
    for (const k of idx) c[k] = [c[k][0] + dx, c[k][1] + dy];
    setCorners(z, c);
    push(); renderAll();
  };
  window.addEventListener('keydown', onKey, true);

  function close() {
    cancelAnimationFrame(pushRaf); pushRaf = null;
    sendNow();
    window.removeEventListener('keydown', onKey, true);
    root.remove();
  }
  renderAll();
}
