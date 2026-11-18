// Régie : conducteur, preview/programme, sorties, interaction public.
import { Client, bindClicker, esc, fmtTime, timerValue, getPin } from '/shared/client.js';
import { Stage, describe, stepFrom, pdfThumb, joinUrl } from '/shared/renderer.js';
import { openSceneEditor } from '/control/scene-editor.js';
import { openMappingEditor } from '/control/mapping-editor.js';

const $ = (s, r = document) => r.querySelector(s);
const desktop = window.presenthor || null; // API exposée par l'app Mac/PC
const ICONS = { slides: '📑', video: '🎬', image: '🖼', audio: '🎵', web: '🌐', camera: '🎥', ndi: '📡', scene: '🧩', poll: '📊', qa: '💬', title: '🅃', black: '⬛' };
const SOURCE_LABELS = { program: 'Programme', clean: 'Programme sans habillage', preview: 'Preview', presenter: 'Retour présentateur', multiview: 'Multiview régie' };

let S = null; // dernier état reçu
let selectedId = null;
let tab = 'cue';
let displays = [];
let cameras = [];
let info = { lan: [] };

const client = new Client({ role: 'control', onState, onStatus: (s) => { $('#conn').classList.toggle('on', s === 'online'); $('#conn').textContent = s === 'online' ? '● En ligne' : '● Hors ligne'; } });
const send = async (action) => {
  const r = await client.send(action);
  if (r?.error) toast(r.error);
  return r;
};
bindClicker(client);
window.__presenthorAction = (a) => send(a); // télécommande globale (app desktop)

const pvwStage = new Stage($('#pvw-stage'), { client, monitor: true });
const pgmStage = new Stage($('#pgm-stage'), { client, monitor: true, reportEnded: true });

fetch('/api/info').then((r) => r.json()).then((i) => { info = i; renderTab(true); });
if (desktop) {
  desktop.listDisplays().then((d) => { displays = d; renderTab(true); });
  desktop.onDisplaysChanged((d) => { displays = d; renderTab(true); });
}

// ------------------------------------------------------------------ rendu
function onState(state) {
  S = state;
  for (const el of [$('#pvw-stage'), $('#pgm-stage')]) el.style.setProperty('--accent', state.settings.accent);
  if (selectedId && !S.cues.some((c) => c.id === selectedId)) selectedId = null;
  if (!selectedId) selectedId = S.live.preview?.cueId || S.cues[0]?.id || null;

  if (document.activeElement !== $('#show-name')) $('#show-name').value = S.show.name;
  document.title = S.show.name + ' — Régie';
  const c = S.clients;
  const nOut = Object.keys(c.outputs).length;
  $('#clients').textContent = `${nOut} sortie${nOut > 1 ? 's' : ''} · ${c.audience} participant${c.audience > 1 ? 's' : ''}`;

  pvwStage.update(S, describe(S, S.live.preview));
  pgmStage.update(S, describe(S, S.live.program, { blackout: S.live.blackout, logo: S.live.logo }), S.live.overlay, S.live.blackout ? null : S.live.overlayScenes);
  $('#pvw-name').textContent = posName(S.live.preview);
  $('#pgm-name').textContent = posName(S.live.program);
  $('#blackout').classList.toggle('on', S.live.blackout);
  $('#logo').classList.toggle('on', S.live.logo);
  if (document.activeElement !== $('#transition')) $('#transition').value = S.settings.transition;
  if (document.activeElement !== $('#transition-ms')) $('#transition-ms').value = S.settings.transitionMs;

  const pgmCue = cueById(S.live.program?.cueId);
  const pages = pgmCue?.type === 'slides' ? mediaById(pgmCue.mediaId)?.pages : null;
  $('#slide-count').textContent = pages ? `Diapo ${S.live.program.slide} / ${pages}` : '';
  $('#media-ctl').hidden = !S.live.playback;

  renderMedia();
  renderCues();
  renderStrip();
  renderTab();
}

const cueTypeFor = (m) => (m.kind === 'office' ? 'slides' : m.kind);
const cueById = (id) => S?.cues.find((c) => c.id === id);
const mediaById = (id) => S?.media.find((m) => m.id === id);
function posName(p) {
  const c = cueById(p?.cueId);
  if (!c) return '—';
  return c.name + (c.type === 'slides' ? ` · ${p.slide}` : '');
}

// Ne remplace le HTML que s'il a changé et que l'utilisateur n'y est pas en train de saisir.
const isEditing = (el) => { const a = document.activeElement; return a && el.contains(a) && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)); };
function patch(el, html, force = false) {
  if (!force && isEditing(el)) return;
  if (el._html === html) return;
  el._html = html;
  el.innerHTML = html;
}

function renderMedia() {
  patch($('#media-list'), S.media.length ? S.media.map((m) => {
    const icon = ICONS[m.kind === 'office' ? 'slides' : m.kind] || '📄';
    let meta = { video: 'Vidéo', image: 'Image', audio: 'Audio', slides: `${m.pages || '?'} diapo${m.pages > 1 ? 's' : ''}` }[m.kind] || '';
    let cls = '';
    if (m.status === 'converting' || m.status === 'processing') { meta = 'Conversion…'; cls = 'busy'; }
    if (m.status === 'error') { meta = m.error; cls = 'err'; }
    return `<div class="media" draggable="true" data-media="${m.id}" title="${esc(m.name)}">
      <span>${icon}</span><div style="min-width:0"><div class="name">${esc(m.name)}</div><div class="meta ${cls}">${esc(meta)}</div></div>
      <div class="acts"><button class="btn sm" data-act="media-add" data-id="${m.id}" title="Ajouter au conducteur">＋</button>
      <button class="btn sm ghost" data-act="media-remove" data-id="${m.id}" title="Supprimer">✕</button></div></div>`;
  }).join('') : '<div class="hint" style="padding:6px">Aucun média importé.</div>');
}

function cueDetail(c) {
  const m = mediaById(c.mediaId);
  if (c.type === 'slides') return m ? (m.status === 'ready' ? `${m.pages} diapos` : m.status === 'error' ? 'erreur' : 'conversion…') : 'média manquant';
  if (c.type === 'web') return c.url ? new URL(c.url, location.href).hostname : 'URL à définir';
  if (c.type === 'camera') return c.deviceLabel || 'source par défaut';
  if (c.type === 'ndi') return c.source?.name || 'source à choisir';
  if (c.type === 'scene') return `${(c.layers || []).length} calque${(c.layers || []).length > 1 ? 's' : ''}${S.live.overlayScenes?.includes(c.id) ? ' · habillage actif' : ''}`;
  if (c.type === 'poll') return S.polls.find((p) => p.id === c.pollId)?.question || 'sondage à choisir';
  if ((c.type === 'video' || c.type === 'image' || c.type === 'audio') && !m) return 'média manquant';
  return '';
}

function renderCues() {
  const html = S.cues.length ? S.cues.map((c, i) => {
    const pgm = S.live.program?.cueId === c.id, pvw = S.live.preview?.cueId === c.id;
    const flags = [c.loop && 'BOUCLE', c.autoNext && 'AUTO ▶'].filter(Boolean);
    return `<li class="cue${c.id === selectedId ? ' sel' : ''}${pgm ? ' pgm' : ''}${pvw ? ' pvw' : ''}" draggable="true" data-cue="${c.id}">
      <span class="idx">${i + 1}</span><span class="ico">${ICONS[c.type]}</span>
      <span class="nm">${esc(c.name)}</span><span class="det">${esc(cueDetail(c))}</span>
      <span class="tags">${flags.map((f) => `<span class="tag flag">${f}</span>`).join('')}${pvw ? '<span class="tag pvw">PVW</span>' : ''}${pgm ? '<span class="tag pgm">PGM</span>' : ''}</span></li>`;
  }).join('') : '<li class="empty">Le conducteur est vide : importez des médias ou ajoutez un élément.</li>';
  patch($('#cue-list'), html, true);
}

// Bande de miniatures des diapositives (cue sélectionné)
let stripKey = '';
function renderStrip() {
  const strip = $('#slides-strip');
  const cue = cueById(selectedId);
  const m = cue?.type === 'slides' ? mediaById(cue.mediaId) : null;
  const key = m?.status === 'ready' ? cue.id + m.file + m.pages : '';
  if (key !== stripKey) {
    stripKey = key;
    strip.innerHTML = '';
    if (key) {
      const io = new IntersectionObserver((entries) => {
        for (const e of entries) if (e.isIntersecting && !e.target.dataset.done) {
          e.target.dataset.done = 1;
          pdfThumb('/media/' + m.file, +e.target.dataset.slide, 256, 144).then((c) => e.target.prepend(c)).catch(() => {});
        }
      }, { root: strip });
      for (let n = 1; n <= m.pages; n++) {
        const t = document.createElement('div');
        t.className = 'thumb'; t.dataset.slide = n; t.innerHTML = `<span>${n}</span>`;
        strip.append(t); io.observe(t);
      }
    }
  }
  for (const t of strip.children) {
    const n = +t.dataset.slide;
    t.classList.toggle('pgm', S.live.program?.cueId === cue?.id && S.live.program?.slide === n);
    t.classList.toggle('pvw', S.live.preview?.cueId === cue?.id && S.live.preview?.slide === n);
  }
  const cur = strip.querySelector('.pgm') || strip.querySelector('.pvw');
  if (cur && strip._last !== cur) { strip._last = cur; cur.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' }); }
}

// ------------------------------------------------------------------ onglets
function renderTab(force = false) {
  if (!S) return;
  const el = $('#tab-' + tab);
  const html = { cue: tabCue, outputs: tabOutputs, live: tabLive, interact: tabInteract, settings: tabSettings }[tab]();
  patch(el, html, force && !isEditing(el));
  if (tab === 'interact' || tab === 'settings') fillJoin(el);
}

function fillJoin(el) {
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

const sel = (opts, value) => opts.map(([v, l]) => `<option value="${esc(v)}"${String(v) === String(value ?? '') ? ' selected' : ''}>${esc(l)}</option>`).join('');
const field = (label, input) => `<label class="field"><span>${label}</span>${input}</label>`;
const check = (label, attr, on) => `<label class="check"><input type="checkbox" ${attr}${on ? ' checked' : ''}> ${label}</label>`;

function tabCue() {
  const c = cueById(selectedId);
  if (!c) return '<p class="hint">Sélectionnez un élément du conducteur.</p>';
  const f = (k) => `data-cue-field="${k}"`;
  const media = mediaById(c.mediaId);
  const images = S.media.filter((m) => m.kind === 'image');
  let h = field('Nom', `<input ${f('name')} value="${esc(c.name)}">`);
  if (c.type === 'slides' || c.type === 'video' || c.type === 'image' || c.type === 'audio') {
    const kinds = c.type === 'slides' ? ['slides'] : [c.type];
    h += field('Média', `<select ${f('mediaId')}>${sel([['', '—'], ...S.media.filter((m) => kinds.includes(m.kind)).map((m) => [m.id, m.name])], c.mediaId)}</select>`);
    if (media?.notes?.some(Boolean)) h += `<p class="hint">Notes du présentateur importées depuis le PowerPoint (${media.notes.filter(Boolean).length} diapos).</p>`;
    if (c.type === 'slides') {
      const vids = media?.videos?.length || 0;
      const native = S.nativeInfo?.available;
      const isPpt = /\.(pptx|ppt|pps|ppsx)$/i.test(media?.source || '');
      h += field('Rendu', `<select ${f('engine')}>${sel([['', 'Images' + (vids ? ` + ${vids} vidéo(s) intégrée(s)` : '') + ' — fonctionne partout'], ['powerpoint', 'PowerPoint natif — animations et transitions']], c.engine || '')}</select>`);
      if (c.engine === 'powerpoint') {
        const nat = S.live.native?.cueId === c.id ? S.live.native : null;
        h += `<div class="box"><span class="hint">${!desktop ? 'Le mode natif fonctionne dans l\'app Mac / PC où PowerPoint est installé ; ailleurs les images sont utilisées.'
          : !native ? 'PowerPoint n\'a pas été détecté sur cet ordinateur : les images sont utilisées.'
          : !isPpt ? 'Ce média n\'est pas un fichier PowerPoint (PDF) : réimportez le .pptx.'
          : `${esc(S.nativeInfo.app)} pilote le diaporama : la télécommande déclenche les animations une à une.`}</span>
          ${nat ? `<span class="hint">${nat.error ? 'Erreur : ' + esc(nat.error) : `Diapo ${nat.slide}/${nat.total || '?'}${nat.clicks ? ` · animation ${nat.click}/${nat.clicks}` : ''}${nat.sourceId ? ' · fenêtre capturée' : ' · fenêtre introuvable'}`}</span>` : ''}
          <div class="field"><span>Recadrage de la capture % (haut, droite, bas, gauche) — retire la barre de titre</span><div class="grid4">
          ${['t', 'r', 'b', 'l'].map((k) => `<input type="number" step="0.5" min="0" max="40" data-crop-k="${k}" value="${(c.captureCrop || {})[k] || 0}">`).join('')}</div></div></div>`;
      } else if (vids) h += `<p class="hint">Les vidéos intégrées au PowerPoint sont rejouées à leur place sur la diapo.</p>`;
    }
  }
  if (c.type === 'video' || c.type === 'audio') {
    h += `<div class="box">${check('Lecture automatique au passage à l\'antenne', `${f('autoplay')} data-type="bool-default-true"`, c.autoplay !== false)}
      ${check('Lecture en boucle', `${f('loop')} data-type="bool"`, c.loop)}
      ${check('Enchaîner automatiquement à la fin', `${f('autoNext')} data-type="bool"`, c.autoNext)}
      ${field(`Volume (${Math.round((c.volume ?? 1) * 100)} %)`, `<input type="range" min="0" max="1" step="0.05" value="${c.volume ?? 1}" ${f('volume')} data-type="number">`)}</div>`;
  }
  if (c.type === 'web') {
    h += field('URL (Zoom, Teams, Meet, Jitsi, sondage externe, site…)', `<input type="url" ${f('url')} value="${esc(c.url || '')}" placeholder="https://…">`);
    h += field('Zoom de la page', `<select ${f('zoom')} data-type="number">${sel([[0.5, '50 %'], [0.75, '75 %'], [1, '100 %'], [1.25, '125 %'], [1.5, '150 %'], [2, '200 %']], c.zoom ?? 1)}</select>`);
    h += `<p class="hint">Pour une visio pro, l'idéal reste un PC dédié dont la sortie HDMI entre via une carte d'acquisition (élément « Caméra / capture ») : zéro dépendance au site.${desktop ? '' : ' En navigateur, certains sites refusent de s\'afficher intégrés ; l\'app Mac/PC lève cette limite.'}</p>`;
  }
  if (c.type === 'camera') {
    h += field('Source vidéo (webcam, carte d\'acquisition HDMI/SDI, NDI virtuel…)', `<select ${f('deviceId')}>${sel([['', 'Par défaut'], ...cameras.map((d) => [d.deviceId, d.label || 'Caméra'])], c.deviceId)}</select>`);
    h += `<button class="btn sm" data-act="cams">Détecter les sources</button>`;
    h += check('Remplir l\'écran (recadrer)', `${f('fill')} data-type="bool"`, c.fill);
    h += check('Inclure l\'audio de la source', `${f('withAudio')} data-type="bool"`, c.withAudio);
  }
  if (c.type === 'title' || c.type === 'qa') {
    h += field(c.type === 'qa' ? 'Titre (quand aucune question n\'est affichée)' : 'Titre', `<input ${f('title')} value="${esc(c.title || '')}" placeholder="${c.type === 'qa' ? 'Posez vos questions' : esc(c.name)}">`);
    if (c.type === 'title') h += field('Sous-titre', `<input ${f('subtitle')} value="${esc(c.subtitle || '')}">`);
    h += field('Image de fond', `<select ${f('bgMediaId')}>${sel([['', 'Dégradé par défaut'], ...images.map((m) => [m.id, m.name])], c.bgMediaId)}</select>`);
  }
  if (c.type === 'scene') {
    const on = S.live.overlayScenes?.includes(c.id);
    h += `<div class="box"><b>${(c.layers || []).length} calque(s)</b>
      ${(c.layers || []).slice().reverse().map((l) => `<span class="hint">${ICONS[cueById(l.cueId)?.type] || ''} ${esc(l.name || cueById(l.cueId)?.name || '?')} — ${Math.round(l.w * 100)}×${Math.round(l.h * 100)} %${l.main ? ' · principal' : ''}</span>`).join('')}
      <button class="btn primary" data-act="scene-edit">Éditer la scène</button></div>
      <div class="box"><b>Habillage</b><span class="hint">Affiche cette scène par-dessus le programme, quel que soit l'élément à l'antenne (logo, cadre, bandeau, caméra en incrustation…). Utilisez un fond transparent.</span>
      <button class="btn ${on ? 'on' : ''}" data-act="overlay-scene" data-id="${c.id}">${on ? 'Retirer l\'habillage' : 'Afficher en habillage'}</button></div>`;
  }
  if (c.type === 'ndi') {
    const list = S.ndi?.sources || [];
    const cur = c.source?.name;
    h += field('Source NDI', `<select data-ndi-source>${sel([['', '—'], ...(cur && !list.some((x) => x.name === cur) ? [[cur, cur + ' (absente)']] : []), ...list.map((x) => [x.name, x.name])], cur)}</select>`);
    h += `<span class="hint">${S.ndi?.available ? `${list.length} source(s) détectée(s) sur le réseau.` : 'Module NDI indisponible sur ce serveur.'} ${desktop ? '' : 'L\'image NDI s\'affiche dans les sorties de l\'app Mac / PC.'}</span>`;
    h += check('Remplir l\'écran (recadrer)', `${f('fill')} data-type="bool"`, c.fill);
    h += check('Son de la source NDI', `${f('withAudio')} data-type="bool-default-true"`, c.withAudio !== false);
  }
  if (c.type === 'poll') {
    h += field('Sondage affiché', `<select ${f('pollId')}>${sel([['', '—'], ...S.polls.map((p) => [p.id, p.question])], c.pollId)}</select>`);
    h += `<p class="hint">Créez et pilotez les sondages dans l'onglet « Public ».</p>`;
  }
  h += field('Notes pour le présentateur', `<textarea ${f('notes')} placeholder="Visibles sur le retour présentateur">${esc(c.notes || '')}</textarea>`);
  h += `<div class="row"><button class="btn" data-act="cue-preview">→ Preview</button><button class="btn primary" data-act="cue-program">Direct ▶</button>
    <div class="spacer"></div><button class="btn" data-act="cue-dup">Dupliquer</button><button class="btn danger" data-act="cue-remove">Supprimer</button></div>`;
  return h;
}

function tabOutputs() {
  const sources = [...Object.entries(SOURCE_LABELS), ...S.cues.map((c) => ['cue:' + c.id, 'Fixe : ' + c.name])];
  let h = `<p class="hint">Chaque sortie est un écran : grand écran public, retour présentateur, écrans périphériques, régie. ${desktop ? 'Choisissez l\'écran physique et ouvrez-la en plein écran.' : 'Ouvrez le lien sur l\'ordinateur relié à l\'écran (ou sur n\'importe quel appareil du réseau).'}</p>`;
  for (const o of S.outputs) {
    const n = S.clients.outputs[o.id] || 0;
    const url = `${location.origin}/output/?id=${o.id}`;
    const disp = o.displayId != null ? String(o.displayId) : '';
    h += `<div class="box" data-out="${o.id}">
      <div class="box-head"><span class="row"><span class="dot${n ? ' on' : ''}" title="${n} écran(s) connecté(s)"></span><b>${esc(o.name)}</b></span>
        <button class="btn sm ghost" data-act="out-remove" data-id="${o.id}" title="Supprimer la sortie">✕</button></div>
      ${field('Nom', `<input data-out-field="name" value="${esc(o.name)}">`)}
      ${field('Contenu', `<select data-out-field="source">${sel(sources, o.source)}</select>`)}
      ${check('Sortie audio (son des vidéos)', 'data-out-field="audio" data-type="bool"', o.audio)}
      ${desktop?.ndi ? `<div class="row wrap">${check('Publier en NDI', 'data-out-field="ndi" data-type="bool"', o.ndi)}
        <input data-out-field="ndiName" value="${esc(o.ndiName || '')}" placeholder="PresenThor - ${esc(o.name)}" style="flex:1">
        ${o.ndi ? `<span class="hint">${S.ndiOut?.[o.id] ? esc(S.ndiOut[o.id]) : 'démarrage…'}</span>` : ''}</div>` : ''}
      <div class="row wrap"><button class="btn sm" data-act="out-mapping" data-id="${o.id}">Mapping…</button>
        ${o.zones?.length ? `<span class="tag ${o.mapping ? 'pvw' : 'flag'}">${o.zones.length} zone${o.zones.length > 1 ? 's' : ''}${o.mapping ? '' : ' (désactivé)'}</span>` : ''}
        ${check('Mire', 'data-out-field="testPattern" data-type="bool"', o.testPattern)}
        ${o.resolution ? `<span class="hint">${o.resolution.w}×${o.resolution.h}</span>` : ''}</div>
      ${desktop ? `<div class="row"><select data-out-display="${o.id}">${sel([['', 'Fenêtre'], ...displays.map((d) => [d.id, d.label])], disp)}</select>
        <button class="btn sm primary" data-act="out-open" data-id="${o.id}">Ouvrir</button><button class="btn sm" data-act="out-close" data-id="${o.id}">Fermer</button></div>`
        : `<div class="row"><button class="btn sm primary" data-act="out-window" data-id="${o.id}">Ouvrir dans une fenêtre</button><button class="btn sm" data-act="copy" data-text="${esc(url)}">Copier le lien</button></div>`}
    </div>`;
  }
  h += `<button class="btn" data-act="out-add">＋ Ajouter une sortie</button>`;
  if (desktop) h += `<button class="btn" data-act="displays-identify">Identifier les écrans</button>`;
  return h;
}

function tabLive() {
  const t = S.timer;
  const o = S.live.overlay;
  const scenes = S.cues.filter((c) => c.type === 'scene');
  return `<div class="box"><b>Habillages (scènes par-dessus le programme)</b>
      ${scenes.length ? `<div class="row wrap">${scenes.map((c) => `<button class="btn sm ${S.live.overlayScenes?.includes(c.id) ? 'on' : ''}" data-act="overlay-scene" data-id="${c.id}">${esc(c.name)}</button>`).join('')}</div>` : '<span class="hint">Créez une scène (bouton « Scène ») avec un fond transparent : logo, cadre, caméra en incrustation…</span>'}</div>
    <div class="box"><b>Message au présentateur</b>
      <textarea id="msg-text" placeholder="Ex. : Il reste 5 minutes, accélérez">${esc(S.message?.text || '')}</textarea>
      <div class="row"><button class="btn primary" data-act="msg-send">Envoyer</button><button class="btn" data-act="msg-clear">Effacer</button>
      ${['5 min', 'Plus fort', 'Questions', 'Conclure'].map((q) => `<button class="btn sm" data-act="msg-quick" data-text="${q}">${q}</button>`).join('')}</div></div>
    <div class="box"><b>Bandeau (lower-third)</b>
      <input id="lt-text" placeholder="Nom de l'intervenant" value="${esc(o?.text || '')}">
      <input id="lt-sub" placeholder="Fonction / société" value="${esc(o?.sub || '')}">
      <div class="row"><button class="btn primary" data-act="lt-show">Afficher</button><button class="btn" data-act="lt-hide"${o ? '' : ' disabled'}>Masquer</button></div></div>
    <div class="box"><b>Chronomètre présentateur</b>
      <div class="row">${field('Mode', `<select id="timer-mode">${sel([['down', 'Compte à rebours'], ['up', 'Chronomètre']], t.mode)}</select>`)}
      ${field('Durée (min)', `<input id="timer-min" type="number" min="0" step="1" value="${Math.round(t.duration / 60000)}">`)}</div>
      <div class="row"><button class="btn" data-act="timer-apply">Appliquer</button>${[5, 10, 15, 20, 30, 45].map((m) => `<button class="btn sm" data-act="timer-preset" data-min="${m}">${m}′</button>`).join('')}</div></div>`;
}

function tabInteract() {
  const kinds = [['choice', 'Choix unique'], ['multi', 'Choix multiples'], ['rating', 'Note de 1 à 5'], ['words', 'Nuage de mots']];
  let h = `<div class="box"><div class="row"><img class="qr" data-qr="vote" alt=""><div><b>Lien participants</b><div class="link"></div>
    <p class="hint">${S.clients.audience} connecté${S.clients.audience > 1 ? 's' : ''}</p></div></div></div>`;
  h += `<div class="box"><b>Nouveau sondage / question</b>
    <input id="poll-q" placeholder="Votre question">
    <select id="poll-kind">${sel(kinds, 'choice')}</select>
    <textarea id="poll-opts" placeholder="Une réponse par ligne (choix uniquement)">Oui\nNon</textarea>
    <button class="btn primary" data-act="poll-create">Créer</button></div>`;
  for (const p of S.polls) {
    const open = S.activePollId === p.id;
    const r = p.results || {};
    let bars = '';
    if (p.kind === 'words') bars = (r.words || []).slice(0, 8).map(([w, n]) => `<div class="mini-bar"><span>${esc(w)}</span><span></span><span>${n}</span></div>`).join('');
    else {
      const labels = p.kind === 'rating' ? ['1★', '2★', '3★', '4★', '5★'] : p.options;
      bars = labels.map((l, i) => { const n = r.counts?.[i] || 0; const pc = r.total ? Math.round((n / r.total) * 100) : 0; return `<div class="mini-bar"><span>${esc(l)}</span><span><i style="width:${pc}%"></i></span><span>${pc}%</span></div>`; }).join('');
    }
    h += `<div class="box"><div class="box-head"><b>${esc(p.question)}</b><span class="hint">${r.total || 0} rép.${p.kind === 'rating' ? ` · moy. ${(r.avg || 0).toFixed(1)}` : ''}</span></div>
      <div class="mini-bars">${bars}</div>
      <div class="row" style="flex-wrap:wrap">
        <button class="btn sm ${open ? 'on' : 'primary'}" data-act="poll-open" data-id="${p.id}">${open ? 'Fermer le vote' : 'Ouvrir le vote'}</button>
        <label class="check"><input type="checkbox" data-poll="${p.id}" data-poll-field="showResults"${p.showResults ? ' checked' : ''}> Résultats visibles</label>
        <button class="btn sm" data-act="poll-cue" data-id="${p.id}">À l'écran</button>
        <button class="btn sm" data-act="poll-reset" data-id="${p.id}">RAZ</button>
        <button class="btn sm ghost" data-act="poll-remove" data-id="${p.id}">✕</button></div></div>`;
  }
  const qs = [...S.questions].sort((a, b) => ({ shown: 0, approved: 1, pending: 2, done: 3, rejected: 4 }[a.status] - { shown: 0, approved: 1, pending: 2, done: 3, rejected: 4 }[b.status]) || a.at - b.at);
  h += `<div class="box"><div class="box-head"><b>Questions du public</b>
      <button class="btn sm ${S.qa.open ? 'on' : ''}" data-act="qa-toggle">${S.qa.open ? 'Fermer' : 'Ouvrir'} la saisie</button></div>
    ${qs.length ? qs.map((q) => `<div class="q ${q.status}"><div>${esc(q.text)}</div><small>${esc(q.author || 'Anonyme')} · ${new Date(q.at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })} · ${{ pending: 'à modérer', approved: 'validée', shown: 'À L\'ÉCRAN', done: 'traitée', rejected: 'rejetée' }[q.status]}</small>
      <div class="row">${q.status !== 'approved' && q.status !== 'shown' ? `<button class="btn sm" data-act="qa-set" data-id="${q.id}" data-status="approved">Valider</button>` : ''}
      ${q.status !== 'shown' ? `<button class="btn sm primary" data-act="qa-show" data-id="${q.id}">À l'écran</button>` : `<button class="btn sm" data-act="qa-set" data-id="${q.id}" data-status="done">Retirer</button>`}
      ${q.status !== 'rejected' ? `<button class="btn sm ghost" data-act="qa-set" data-id="${q.id}" data-status="rejected">Rejeter</button>` : ''}</div></div>`).join('') : '<p class="hint">Aucune question pour l\'instant.</p>'}
    ${qs.length ? '<button class="btn sm ghost" data-act="qa-clear">Tout effacer</button>' : ''}</div>`;
  return h;
}

function tabSettings() {
  const s = S.settings;
  const images = S.media.filter((m) => m.kind === 'image');
  return `${field('Logo / habillage (affiché quand le programme est vide ou en mode LOGO)', `<select data-set-field="logoMediaId">${sel([['', 'Aucun (noir)'], ...images.map((m) => [m.id, m.name])], s.logoMediaId)}</select>`)}
    ${field('Couleur d\'accent (sondages, bandeaux)', `<input type="color" data-set-field="accent" value="${esc(s.accent)}">`)}
    ${field('NDI : adresses IP à interroger directement (si les sources n\'apparaissent pas)', `<input data-set-field="ndiExtraIps" value="${esc(s.ndiExtraIps || '')}" placeholder="192.168.1.20, 192.168.1.21">`)}
    <span class="hint">NDI : ${S.ndi?.available ? `${S.ndi.sources.length} source(s) visible(s)` : 'module non disponible sur ce serveur'}.</span>
    ${field('URL publique (si le serveur est en ligne, pour le QR code de vote)', `<input type="url" data-set-field="publicUrl" value="${esc(s.publicUrl)}" placeholder="https://evenement.mondomaine.fr">`)}
    <div class="box"><div class="row"><img class="qr" data-qr="remote" alt=""><div><b>Télécommande smartphone</b><div class="link"></div>
      <p class="hint">Scannez avec le téléphone du présentateur ou du régisseur (même réseau).</p></div></div></div>
    <div class="box"><b>Accès réseau</b>${(info.lan || []).map((u) => `<div class="link">${esc(u)}</div>`).join('') || '<span class="hint">Aucune interface réseau détectée</span>'}
      <span class="hint">${info.pinRequired ? 'Régie protégée par code PIN.' : 'Régie non protégée : définissez PRESENTHOR_PIN pour un usage en ligne.'}</span>
      <span class="hint">Conversion PowerPoint : ${info.converter ? 'disponible (LibreOffice)' : 'LibreOffice non installé — importez vos présentations en PDF'}.</span></div>
    <div class="row"><a class="btn" href="/api/export${getPin() ? '?pin=' + encodeURIComponent(getPin()) : ''}">Exporter le show</a></div>`;
}

// ------------------------------------------------------------------ interactions
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const id = b.dataset.id;
  const A = {
    'media-add': () => send({ type: 'cue.add', cue: { type: cueTypeFor(mediaById(id)), mediaId: id } }),
    'media-remove': () => confirm('Supprimer ce média ?') && send({ type: 'media.remove', id }),
    'cue-preview': () => send({ type: 'preview.set', cueId: selectedId, slide: 1 }),
    'cue-program': () => send({ type: 'program.set', cueId: selectedId, slide: 1 }),
    'scene-edit': () => openSceneEditor({ getState: () => S, send, cueId: selectedId, client }),
    'overlay-scene': () => send({ type: 'overlay.scene', cueId: id }),
    'cue-dup': () => send({ type: 'cue.duplicate', id: selectedId }),
    'cue-remove': () => confirm('Supprimer cet élément du conducteur ?') && send({ type: 'cue.remove', id: selectedId }),
    cams: () => detectCameras(true),
    'out-add': () => send({ type: 'output.add', name: 'Écran ' + (S.outputs.length + 1) }),
    'out-remove': () => confirm('Supprimer cette sortie ?') && (desktop?.closeOutput(id), send({ type: 'output.remove', id })),
    'out-window': () => window.open(`/output/?id=${id}`, 'out_' + id, 'popup,width=960,height=540'),
    'out-open': () => {
      const v = document.querySelector(`[data-out-display="${id}"]`).value;
      send({ type: 'output.update', id, patch: { displayId: v === '' ? null : Number(v) } });
      desktop.openOutput(id, v === '' ? null : Number(v));
    },
    'out-mapping': () => openMappingEditor({ getState: () => S, send, outputId: id }),
    'out-close': () => desktop.closeOutput(id),
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
      const kind = $('#poll-kind').value;
      const options = $('#poll-opts').value.split('\n').map((s) => s.trim()).filter(Boolean);
      const r = await send({ type: 'poll.create', poll: { question: $('#poll-q').value.trim() || 'Votre avis ?', kind, options } });
      if (r?.ok) $('#poll-q').value = '';
    },
    'poll-open': () => send({ type: 'poll.open', id: S.activePollId === id ? null : id }),
    'poll-reset': () => confirm('Effacer les réponses ?') && send({ type: 'poll.reset', id }),
    'poll-remove': () => confirm('Supprimer ce sondage ?') && send({ type: 'poll.remove', id }),
    'poll-cue': async () => {
      // Réutilise un élément existant du conducteur pour ce sondage, sinon en crée un.
      let cue = S.cues.find((c) => c.type === 'poll' && c.pollId === id);
      if (!cue) {
        const p = S.polls.find((x) => x.id === id);
        const r = await send({ type: 'cue.add', cue: { type: 'poll', pollId: id, name: 'Sondage : ' + p.question } });
        cue = cueById(r?.id);
      }
      if (cue) { selectedId = cue.id; send({ type: 'preview.set', cueId: cue.id }); toast('Sondage en preview : TAKE pour l\'afficher'); }
    },
    'qa-toggle': () => send({ type: 'qa.toggle' }),
    'qa-set': () => send({ type: 'qa.update', id, status: b.dataset.status }),
    'qa-show': async () => {
      await send({ type: 'qa.update', id, status: 'shown' });
      const cue = S.cues.find((c) => c.type === 'qa');
      if (cue && S.live.program?.cueId !== cue.id) { send({ type: 'preview.set', cueId: cue.id }); toast('Élément « Questions » en preview : TAKE pour l\'afficher'); }
      else if (!cue) toast('Ajoutez un élément « Questions public » au conducteur pour l\'afficher');
    },
    'qa-clear': () => confirm('Effacer toutes les questions ?') && send({ type: 'qa.clear' }),
  };
  A[b.dataset.act]?.();
});

// Champs éditables (inspecteur, sorties, sondages, réglages)
function readValue(el) {
  if (el.type === 'checkbox') return el.checked;
  if (el.dataset.type === 'number') return Number(el.value);
  return el.value;
}
document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset.cueField) {
    let v = readValue(el);
    const k = el.dataset.cueField;
    const patch = { [k]: v === '' && k.endsWith('Id') ? null : v };
    if (k === 'deviceId') patch.deviceLabel = cameras.find((d) => d.deviceId === v)?.label || '';
    send({ type: 'cue.update', id: selectedId, patch });
  } else if (el.dataset.cropK) {
    const cue = cueById(selectedId);
    send({ type: 'cue.update', id: selectedId, patch: { captureCrop: { ...(cue.captureCrop || {}), [el.dataset.cropK]: Math.max(0, Math.min(40, Number(el.value) || 0)) } } });
  } else if (el.dataset.ndiSource !== undefined) {
    const src = (S.ndi?.sources || []).find((x) => x.name === el.value) || (el.value ? { name: el.value } : null);
    send({ type: 'cue.update', id: selectedId, patch: { source: src, name: src ? src.name : cueById(selectedId).name } });
  } else if (el.dataset.outField) {
    const id = el.closest('[data-out]').dataset.out;
    send({ type: 'output.update', id, patch: { [el.dataset.outField]: readValue(el) } });
  } else if (el.dataset.pollField) {
    send({ type: 'poll.update', id: el.dataset.poll, patch: { [el.dataset.pollField]: readValue(el) } });
  } else if (el.dataset.setField) {
    const v = readValue(el);
    send({ type: 'settings.update', patch: { [el.dataset.setField]: v === '' && el.dataset.setField.endsWith('Id') ? null : v } });
  }
});
document.addEventListener('input', (e) => {
  if (e.target.dataset.cueField === 'volume') send({ type: 'cue.update', id: selectedId, patch: { volume: Number(e.target.value) } });
});

$('#show-name').addEventListener('change', (e) => send({ type: 'show.rename', name: e.target.value }));
$('#take').onclick = () => send({ type: 'take' });
$('#next').onclick = () => send({ type: 'next' });
$('#prev').onclick = () => send({ type: 'prev' });
$('#blackout').onclick = () => send({ type: 'blackout.toggle' });
$('#logo').onclick = () => send({ type: 'logo.toggle' });
$('#clear').onclick = () => send({ type: 'program.clear' });
$('#transition').onchange = (e) => send({ type: 'settings.update', patch: { transition: e.target.value } });
$('#transition-ms').onchange = (e) => send({ type: 'settings.update', patch: { transitionMs: Number(e.target.value) } });
$('#timer-toggle').onclick = () => send({ type: S.timer.running ? 'timer.pause' : 'timer.start' });
$('#timer-reset').onclick = () => send({ type: 'timer.reset' });
$('#v-play').onclick = () => send({ type: S.live.playback?.playing ? 'video.pause' : 'video.play' });
$('#v-restart').onclick = () => send({ type: 'video.seek', time: 0 });
$('#v-seek').oninput = (e) => { e.target.dataset.dragging = 1; };
$('#v-seek').onchange = (e) => { delete e.target.dataset.dragging; send({ type: 'video.seek', time: Number(e.target.value) }); };

$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]');
  if (!b) return;
  tab = b.dataset.tab;
  for (const x of $('#tabs').children) x.classList.toggle('active', x === b);
  for (const x of document.querySelectorAll('.tab-body')) x.hidden = x.id !== 'tab-' + tab;
  if (tab === 'cue' && cueById(selectedId)?.type === 'camera') detectCameras();
  renderTab(true);
});

// Conducteur : clic, double-clic, glisser-déposer
const list = $('#cue-list');
list.addEventListener('click', (e) => {
  const li = e.target.closest('[data-cue]');
  if (!li) return;
  selectCue(li.dataset.cue);
  send({ type: 'preview.set', cueId: li.dataset.cue, slide: 1 });
});
list.addEventListener('dblclick', (e) => {
  const li = e.target.closest('[data-cue]');
  if (li) send({ type: 'program.set', cueId: li.dataset.cue, slide: 1 });
});
function selectCue(id) {
  selectedId = id;
  if (tab !== 'cue') $('#tabs [data-tab=cue]').click();
  if (cueById(id)?.type === 'camera') detectCameras();
  renderCues(); renderStrip(); renderTab(true);
}
let dragCue = null;
list.addEventListener('dragstart', (e) => { dragCue = e.target.closest('[data-cue]')?.dataset.cue; e.dataTransfer.effectAllowed = 'move'; });
list.addEventListener('dragover', (e) => {
  e.preventDefault();
  for (const x of list.querySelectorAll('.drag-over')) x.classList.remove('drag-over');
  e.target.closest('[data-cue]')?.classList.add('drag-over');
});
list.addEventListener('drop', (e) => {
  e.preventDefault();
  const target = e.target.closest('[data-cue]');
  const index = target ? S.cues.findIndex((c) => c.id === target.dataset.cue) : S.cues.length;
  const mediaId = e.dataTransfer.getData('text/media');
  if (mediaId) send({ type: 'cue.add', cue: { type: cueTypeFor(mediaById(mediaId)), mediaId }, index });
  else if (dragCue) {
    const from = S.cues.findIndex((c) => c.id === dragCue);
    send({ type: 'cue.move', id: dragCue, index: from < index ? index - 1 : index });
  }
  dragCue = null;
});
$('#media-list').addEventListener('dragstart', (e) => {
  const m = e.target.closest('[data-media]');
  if (m) e.dataTransfer.setData('text/media', m.dataset.media);
});

// Miniatures : clic = preview (ou saut direct si l'élément est à l'antenne), double-clic = direct
$('#slides-strip').addEventListener('click', (e) => {
  const t = e.target.closest('.thumb');
  if (!t) return;
  const slide = +t.dataset.slide;
  if (S.live.program?.cueId === selectedId) send({ type: 'slide.goto', slide });
  else send({ type: 'preview.set', cueId: selectedId, slide });
});
$('#slides-strip').addEventListener('dblclick', (e) => {
  const t = e.target.closest('.thumb');
  if (t) send({ type: 'program.set', cueId: selectedId, slide: +t.dataset.slide });
});

document.querySelector('.add-grid').addEventListener('click', async (e) => {
  const type = e.target.closest('[data-add]')?.dataset.add;
  if (!type) return;
  const cue = { type };
  if (type === 'poll' && S.polls.length) cue.pollId = (S.polls.find((p) => p.id === S.activePollId) || S.polls[S.polls.length - 1]).id;
  const idx = S.cues.findIndex((c) => c.id === selectedId);
  if (type === 'scene') {
    // Nouvelle scène : on part de l'élément sélectionné comme premier calque.
    const base = cueById(selectedId);
    cue.name = 'Scène ' + (S.cues.filter((c) => c.type === 'scene').length + 1);
    cue.layers = base && base.type !== 'scene' ? [{ cueId: base.id, x: 0, y: 0, w: 1, h: 1, main: base.type === 'slides' }] : [];
  }
  const r = await send({ type: 'cue.add', cue, index: idx >= 0 ? idx + 1 : undefined });
  if (r?.id) {
    selectCue(r.id);
    send({ type: 'preview.set', cueId: r.id });
    if (type === 'scene') openSceneEditor({ getState: () => S, send, cueId: r.id, client });
  }
});

// Raccourcis régie
window.addEventListener('keydown', (e) => {
  const t = e.target;
  if (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
  if (e.key === 'Enter' || (e.key === ' ' && !e.repeat)) { e.preventDefault(); send({ type: 'take' }); }
  if (e.key === 'Escape') send({ type: 'program.clear' });
  if (e.key === 'l' || e.key === 'L') send({ type: 'logo.toggle' });
});

// ------------------------------------------------------------------ import de fichiers
function upload(files) {
  if (!files.length) return;
  const fd = new FormData();
  for (const f of files) fd.append('files', f);
  const xhr = new XMLHttpRequest();
  const bar = $('#upload-progress');
  bar.hidden = false;
  xhr.upload.onprogress = (e) => { bar.firstElementChild.style.width = (e.loaded / e.total) * 100 + '%'; };
  xhr.onloadend = () => {
    bar.hidden = true; bar.firstElementChild.style.width = 0;
    if (xhr.status !== 200) toast('Import échoué (' + xhr.status + ')');
    else {
      const n = JSON.parse(xhr.responseText).media.length;
      toast(n ? `${n} fichier${n > 1 ? 's' : ''} importé${n > 1 ? 's' : ''}` : 'Format non pris en charge');
    }
  };
  xhr.open('POST', '/api/media?addCues=1');
  xhr.setRequestHeader('x-pin', getPin());
  xhr.send(fd);
}
$('#file-input').onchange = (e) => { upload([...e.target.files]); e.target.value = ''; };
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if (e.dataTransfer.types.includes('Files')) { dragDepth++; $('#drop').hidden = false; } });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop').hidden = true; } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0; $('#drop').hidden = true;
  if (e.dataTransfer.files.length) upload([...e.dataTransfer.files]);
});

// ------------------------------------------------------------------ caméras
async function detectCameras(askPermission = false) {
  try {
    let devs = await navigator.mediaDevices.enumerateDevices();
    if (askPermission || devs.some((d) => d.kind === 'videoinput' && !d.label)) {
      const st = await navigator.mediaDevices.getUserMedia({ video: true }).catch(() => null);
      st?.getTracks().forEach((t) => t.stop());
      devs = await navigator.mediaDevices.enumerateDevices();
    }
    cameras = devs.filter((d) => d.kind === 'videoinput');
    renderTab(true);
  } catch { toast('Accès aux caméras impossible'); }
}

// ------------------------------------------------------------------ horloges
setInterval(() => {
  if (!S) return;
  const now = client.now();
  $('#clock').textContent = new Date(now).toLocaleTimeString('fr-FR');
  const v = timerValue(S.timer, now);
  const td = $('#timer-display');
  td.textContent = fmtTime(v, true);
  td.className = 'timer-display' + (S.timer.mode === 'down' ? (v < 0 ? ' over' : v < 120000 ? ' warn' : '') : '');
  $('#timer-toggle').textContent = S.timer.running ? '⏸' : '▶';
  const pb = S.live.playback;
  if (pb) {
    const vid = pgmStage.current?.video;
    const dur = vid?.duration || 0;
    let t = pb.playing ? (now - pb.startedAt) / 1000 : pb.offset;
    if (dur && cueById(pb.cueId)?.loop) t %= dur;
    t = Math.max(0, Math.min(dur || t, t));
    const seek = $('#v-seek');
    if (dur) seek.max = dur;
    if (!seek.dataset.dragging) seek.value = t;
    $('#v-time').textContent = `${fmtTime(t * 1000)} / -${fmtTime(Math.max(0, dur - t) * 1000)}`;
    $('#v-play').textContent = pb.playing ? '⏸' : '▶';
  }
}, 200);

let toastT;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 2600);
}
