// Pupitre de caméra PTZ : joystick pan / tilt, zoom, mise au point, préréglages.
// Utilisé dans les propriétés d'un clip caméra et dans l'onglet « PTZ » (détachable,
// utilisable sur tablette). Les mouvements sont renvoyés tant qu'on les tient :
// si la liaison se coupe, la caméra s'arrête d'elle-même.
import { esc } from '/shared/client.js';

export const isPtzCue = (c) => !!c && (c.type === 'ndi' || (c.type === 'camera' && c.ptz?.host)) && c.ptz?.enabled !== false;
export const ptzCapable = (c) => !!c && (c.type === 'ndi' || c.type === 'camera');

const PRESETS = 8;

// Réglages de liaison (dans les propriétés du clip).
export function ptzSettingsHtml(c, ndiAvailable) {
  const p = c.ptz || {};
  const via = p.via || (c.type === 'ndi' ? 'ndi' : 'visca');
  const vias = [...(c.type === 'ndi' ? [['ndi', 'Par le NDI (recommandé)']] : []), ['visca', 'VISCA sur IP (adresse de la caméra)']];
  return `<div class="box ptz-set" data-ptz-cue="${c.id}"><div class="box-head"><b>Caméra PTZ</b>
      <label class="check"><input type="checkbox" data-ptz-set="enabled"${p.enabled !== false ? ' checked' : ''}> Pilotage</label></div>
    ${p.enabled === false ? '' : `
    <label class="field"><span>Commande</span><select data-ptz-set="via">${vias.map(([v, l]) => `<option value="${v}"${v === via ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
    ${via === 'visca' ? `<div class="grid2"><label class="field"><span>Adresse IP</span><input data-ptz-set="host" value="${esc(p.host || '')}" placeholder="192.168.1.50"></label>
      <label class="field"><span>Protocole</span><select data-ptz-set="protocol">${[['sony', 'UDP 52381 (Sony, Avonic, BirdDog…)'], ['udp', 'UDP 1259 (PTZOptics…)'], ['tcp', 'TCP 5678 (PTZOptics…)']].map(([v, l]) => `<option value="${v}"${v === (p.protocol || 'sony') ? ' selected' : ''}>${l}</option>`).join('')}</select></label></div>
      <label class="field"><span>Port (vide = port du protocole)</span><input type="number" data-ptz-set="port" value="${esc(p.port || '')}" placeholder="auto"></label>`
      : `<span class="hint">${ndiAvailable ? 'Les commandes passent par la liaison NDI de la caméra (BirdDog, PTZOptics, Panasonic, Avonic, NDI|HX…).' : 'NDI indisponible sur cet ordinateur : utilisez VISCA sur IP.'}</span>`}
    <div class="row wrap"><label class="check"><input type="checkbox" data-ptz-set="invertPan"${p.invertPan ? ' checked' : ''}> Inverser gauche / droite</label>
      <label class="check"><input type="checkbox" data-ptz-set="invertTilt"${p.invertTilt ? ' checked' : ''}> Inverser haut / bas</label></div>
    ${ptzPadHtml(c)}`}</div>`;
}

// Pupitre (joystick, zoom, focus, préréglages).
export function ptzPadHtml(c, big = false) {
  const p = c.ptz || {};
  const names = p.presets || [];
  return `<div class="ptz${big ? ' big' : ''}" data-ptz="${c.id}">
    <div class="ptz-main">
      <div class="ptz-joy" data-ptz-joy title="Glisser : pan / tilt (plus loin = plus vite). Flèches du clavier aussi."><div class="ptz-knob"></div>
        <span class="ptz-arrow u">▲</span><span class="ptz-arrow d">▼</span><span class="ptz-arrow l">◀</span><span class="ptz-arrow r">▶</span></div>
      <div class="ptz-zoom">
        <button class="btn sm" data-ptz-hold="zoom" data-v="1" title="Zoom avant (maintenir)">＋</button>
        <input type="range" min="-1" max="1" step="0.01" value="0" data-ptz-rocker="zoom" orient="vertical" title="Zoom : pousser / tirer, revient au centre">
        <button class="btn sm" data-ptz-hold="zoom" data-v="-1" title="Zoom arrière (maintenir)">－</button>
        <span class="hint">Zoom</span>
      </div>
    </div>
    <div class="ptz-row"><span class="hint">Vitesse</span><input type="range" min="0.05" max="1" step="0.05" value="${p.speed ?? 0.5}" data-ptz-speed><output>${Math.round((p.speed ?? 0.5) * 100)} %</output></div>
    <div class="ptz-row">
      <button class="btn sm" data-ptz-op="home" title="Position de repos">⌂ Repos</button>
      <button class="btn sm" data-ptz-op="autofocus" title="Mise au point automatique">AF auto</button>
      <button class="btn sm" data-ptz-hold="focus" data-v="-1" title="Mise au point proche (maintenir)">Net −</button>
      <button class="btn sm" data-ptz-hold="focus" data-v="1" title="Mise au point loin (maintenir)">Net ＋</button>
      <button class="btn sm" data-ptz-op="auto" title="Balance des blancs et exposition automatiques">Auto WB/Expo</button>
      <button class="btn sm danger" data-ptz-op="stop" title="Arrêt immédiat">■ Stop</button>
    </div>
    <div class="ptz-presets-head"><b>Préréglages</b><label class="check"><input type="checkbox" data-ptz-store> Mémoriser</label>
      <span class="hint">clic = rappeler · « Mémoriser » puis clic = enregistrer la position · double-clic = renommer</span></div>
    <div class="ptz-presets">${Array.from({ length: PRESETS }, (_, i) => `<button class="btn ptz-pre" data-ptz-pre="${i}">${i + 1}<small>${esc(names[i] || '')}</small></button>`).join('')}</div>
    <div class="ptz-status hint" data-ptz-status></div>
  </div>`;
}

// Branchement des gestes (une seule fois, par délégation).
export function bindPtz({ send, getCue, toast }) {
  const cmd = (cueId, a) => send({ type: 'ptz', cueId, ...a });
  const speedOf = (cueId) => getCue(cueId)?.ptz?.speed ?? 0.5;
  const padOf = (el) => el.closest('[data-ptz]');
  let active = null; // { cueId, kind, vals, timer }

  // Mouvement tenu : envoyé tout de suite, puis confirmé toutes les 300 ms.
  function hold(cueId, kind, vals) {
    if (active && (active.cueId !== cueId || active.kind !== kind)) release();
    const send1 = () => active && cmd(active.cueId, { op: active.kind, ...active.vals, speed: speedOf(active.cueId) });
    if (!active) active = { cueId, kind, vals, timer: setInterval(send1, 300) };
    active.vals = vals;
    send1();
  }
  function release() {
    if (!active) return;
    clearInterval(active.timer);
    const { cueId, kind } = active;
    active = null;
    cmd(cueId, kind === 'move' ? { op: 'move', pan: 0, tilt: 0 } : kind === 'zoom' ? { op: 'zoom', zoom: 0 } : { op: 'focus', focus: 0 });
  }
  window.addEventListener('blur', release);
  document.addEventListener('visibilitychange', () => { if (document.hidden) release(); });

  document.addEventListener('pointerdown', (e) => {
    const joy = e.target.closest('[data-ptz-joy]');
    const holdBtn = e.target.closest('[data-ptz-hold]');
    if (!joy && !holdBtn) return;
    const pad = padOf(e.target);
    if (!pad) return;
    const cueId = pad.dataset.ptz;
    e.preventDefault();
    const tgt = joy || holdBtn;
    tgt.setPointerCapture?.(e.pointerId);
    if (holdBtn) {
      hold(cueId, holdBtn.dataset.ptzHold, { [holdBtn.dataset.ptzHold]: +holdBtn.dataset.v });
      holdBtn.classList.add('on');
      const up = () => { holdBtn.classList.remove('on'); release(); holdBtn.removeEventListener('pointerup', up); holdBtn.removeEventListener('pointercancel', up); };
      holdBtn.addEventListener('pointerup', up); holdBtn.addEventListener('pointercancel', up);
      return;
    }
    const knob = joy.querySelector('.ptz-knob');
    const r = joy.getBoundingClientRect();
    let raf = 0, last = e;
    const apply = () => {
      raf = 0;
      let x = ((last.clientX - r.left) / r.width) * 2 - 1, y = ((last.clientY - r.top) / r.height) * 2 - 1;
      const d = Math.hypot(x, y);
      if (d > 1) { x /= d; y /= d; }
      knob.style.transform = `translate(${x * r.width / 2}px, ${y * r.height / 2}px)`;
      // Zone morte au centre ; courbe douce pour les petits réglages.
      const curve = (v) => (Math.abs(v) < 0.08 ? 0 : Math.sign(v) * Math.pow((Math.abs(v) - 0.08) / 0.92, 1.6));
      hold(cueId, 'move', { pan: +curve(x).toFixed(3), tilt: +(-curve(y)).toFixed(3) });
    };
    apply();
    joy.classList.add('on');
    const move = (ev) => { last = ev; raf ||= requestAnimationFrame(apply); };
    const up = () => {
      cancelAnimationFrame(raf); raf = 0;
      knob.style.transform = '';
      joy.classList.remove('on');
      release();
      joy.removeEventListener('pointermove', move); joy.removeEventListener('pointerup', up); joy.removeEventListener('pointercancel', up);
    };
    joy.addEventListener('pointermove', move);
    joy.addEventListener('pointerup', up);
    joy.addEventListener('pointercancel', up);
  });

  // Curseur de zoom à ressort : la valeur est la vitesse, retour au centre au lâcher.
  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.ptzRocker) { const pad = padOf(t); if (pad) hold(pad.dataset.ptz, 'zoom', { zoom: +t.value }); return; }
    if (t.dataset.ptzSpeed !== undefined) { t.nextElementSibling.textContent = Math.round(t.value * 100) + ' %'; }
  });
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.ptzRocker) { t.value = 0; release(); t.blur(); return; }
    if (t.dataset.ptzSpeed !== undefined) { const pad = padOf(t); send({ type: 'cue.update', id: pad.dataset.ptz, patch: { ptz: { speed: +t.value } } }); t.blur(); return; }
    if (t.dataset.ptzSet) {
      const box = t.closest('[data-ptz-cue]');
      const k = t.dataset.ptzSet;
      const v = t.type === 'checkbox' ? t.checked : k === 'port' ? +t.value || '' : t.value;
      send({ type: 'cue.update', id: box.dataset.ptzCue, patch: { ptz: { [k]: v } } });
    }
  });
  document.addEventListener('pointerup', (e) => { if (e.target.dataset?.ptzRocker) { e.target.value = 0; release(); } });

  document.addEventListener('click', async (e) => {
    const op = e.target.closest('[data-ptz-op]');
    const pre = e.target.closest('[data-ptz-pre]');
    if (!op && !pre) return;
    const pad = padOf(e.target);
    if (!pad) return;
    const cueId = pad.dataset.ptz;
    if (op) { release(); const r = await cmd(cueId, { op: op.dataset.ptzOp }); showStatus(pad, r); return; }
    const i = +pre.dataset.ptzPre;
    const storeMode = pad.querySelector('[data-ptz-store]');
    if (storeMode?.checked) {
      const r = await cmd(cueId, { op: 'preset.store', index: i });
      storeMode.checked = false;
      pre.classList.add('flash'); setTimeout(() => pre.classList.remove('flash'), 600);
      if (!r?.error) toast?.(`Préréglage ${i + 1} enregistré`);
      showStatus(pad, r);
    } else {
      const r = await cmd(cueId, { op: 'preset.recall', index: i, speed: speedOf(cueId) });
      showStatus(pad, r);
    }
  });
  document.addEventListener('dblclick', (e) => {
    const pre = e.target.closest('[data-ptz-pre]');
    const pad = pre && padOf(pre);
    if (!pad) return;
    const c = getCue(pad.dataset.ptz);
    const names = [...(c?.ptz?.presets || [])];
    const i = +pre.dataset.ptzPre;
    const n = prompt(`Nom du préréglage ${i + 1} :`, names[i] || '');
    if (n == null) return;
    names[i] = n;
    send({ type: 'cue.update', id: c.id, patch: { ptz: { presets: Array.from({ length: Math.max(names.length, i + 1) }, (_, k) => names[k] || '') } } });
  });

  // Flèches du clavier quand la souris est sur un pupitre (Maj = plus vite).
  let hoverPad = null;
  document.addEventListener('pointerover', (e) => { hoverPad = padOf(e.target) || hoverPad; if (!e.target.closest('[data-ptz]')) hoverPad = null; });
  const keys = new Set();
  const keyVec = () => ({ pan: (keys.has('ArrowRight') ? 1 : 0) - (keys.has('ArrowLeft') ? 1 : 0), tilt: (keys.has('ArrowUp') ? 1 : 0) - (keys.has('ArrowDown') ? 1 : 0) });
  window.addEventListener('keydown', (e) => {
    if (!hoverPad || !/^Arrow/.test(e.key) || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    e.preventDefault(); e.stopPropagation();
    if (e.repeat) return;
    keys.add(e.key);
    const v = keyVec(), m = e.shiftKey ? 1 : 0.5;
    hold(hoverPad.dataset.ptz, 'move', { pan: v.pan * m, tilt: v.tilt * m });
  }, true);
  window.addEventListener('keyup', (e) => {
    if (!keys.delete(e.key) || !active) return;
    const v = keyVec();
    if (!v.pan && !v.tilt) release(); else hold(active.cueId, 'move', { pan: v.pan * 0.5, tilt: v.tilt * 0.5 });
  }, true);

  function showStatus(pad, r) {
    const el = pad.querySelector('[data-ptz-status]');
    if (el && r?.error) el.textContent = '⚠ ' + r.error;
  }

  // État de la liaison (affiché sous le pupitre).
  async function refresh() {
    for (const pad of document.querySelectorAll('[data-ptz]')) {
      if (active) continue;
      const r = await cmd(pad.dataset.ptz, { op: 'status' });
      const el = pad.querySelector('[data-ptz-status]');
      if (!el) continue;
      if (r?.error) el.textContent = '⚠ ' + r.error;
      else if (r.via === 'ndi') el.textContent = r.connected ? (r.supported ? '🟢 Caméra PTZ reliée par NDI' : '🟢 Reliée par NDI (PTZ non annoncé par la source : si rien ne bouge, passez en VISCA)') : '🟠 Connexion NDI à la caméra…';
      else el.textContent = r.connected ? `🟢 VISCA ${r.host}:${r.port} répond` : `⚪ VISCA ${r.host}:${r.port} (pas de réponse pour l'instant : vérifiez l'adresse et le protocole)`;
    }
  }
  setInterval(refresh, 3000);
  return { refresh, release };
}
