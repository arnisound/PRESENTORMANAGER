// Composition façon "table de mixage vidéo" : des calques (lignes) et des colonnes.
// Chaque case contient un clip (un élément média) ; chaque calque joue un clip à
// la fois, et tous les calques actifs sont mélangés en temps réel (opacité,
// mode de fusion, effets, transformations).
import { uid } from './store.js';

export const BLENDS = ['normal', 'plus-lighter', 'screen', 'multiply', 'overlay', 'lighten', 'darken', 'difference', 'color-dodge', 'luminosity'];
export const EFFECTS = ['brightness', 'contrast', 'saturate', 'hue', 'blur', 'grayscale', 'sepia', 'invert', 'mirrorX', 'mirrorY'];
export const MASKS = ['none', 'ellipse', 'circle', 'rounded', 'diamond'];
const LEAD = 150; // ms d'avance pour que tous les écrans démarrent ensemble

export function defaultComp() {
  const columns = Array.from({ length: 8 }, (_, i) => ({ id: uid('col_'), name: `Colonne ${i + 1}` }));
  const layer = (name) => newLayer(name, columns.length);
  return { layers: [layer('Fond'), layer('Contenu'), layer('Habillage')], columns, master: 1, clickerColumns: true };
}

export function defaultLiveComp() {
  return { active: {}, at: {}, pb: {}, slides: {}, slideAt: {}, deck: null, column: null };
}

function newLayer(name, n, settings = {}) {
  return {
    id: uid('lay_'), name, opacity: 1, blend: 'normal', bypass: false, solo: false, volume: 1,
    mainOut: true, auxOutputs: [], // routage : composition principale et/ou sorties précises
    transitionMs: settings.defaultLayerTransitionMs || 0, gainDb: 0,
    transition: { type: TRANSITIONS.includes(settings.defaultLayerTransition) ? settings.defaultLayerTransition : 'fade', curve: 'ease', color: '#000000', audio: true },
    transform: { x: 0, y: 0, scale: 1, rotate: 0 }, effects: [], mask: 'none',
    clips: Array(n).fill(null),
  };
}

const num = (v, d, min, max) => (Number.isFinite(+v) ? Math.max(min, Math.min(max, +v)) : d);

export const TRANSITIONS = ['fade', 'cut', 'dip', 'slide-left', 'slide-right', 'slide-up', 'slide-down', 'zoom', 'wipe'];
const CURVES = ['ease', 'linear', 'ease-in', 'ease-out', 'ease-in-out'];
function sanitizeTransition(t = {}) {
  return {
    type: TRANSITIONS.includes(t.type) ? t.type : 'fade',
    curve: CURVES.includes(t.curve) ? t.curve : 'ease',
    color: /^#[0-9a-f]{6}$/i.test(t.color || '') ? t.color : '#000000',
    audio: t.audio !== false,
  };
}

function sanitizeTransform(t = {}) {
  return { x: num(t.x, 0, -2, 2), y: num(t.y, 0, -2, 2), scale: num(t.scale, 1, 0.05, 8), rotate: num(t.rotate, 0, -360, 360) };
}
export function sanitizeEffects(list) {
  return (Array.isArray(list) ? list : []).filter((e) => EFFECTS.includes(e?.type)).slice(0, 12)
    .map((e) => ({ type: e.type, value: num(e.value, 1, -10, 360), on: e.on !== false }));
}

// Remet le modèle d'aplomb (chargement d'un ancien show, données externes…).
export function normalizeComp(comp, cues) {
  if (!comp || !Array.isArray(comp.layers) || !Array.isArray(comp.columns)) comp = defaultComp();
  if (!comp.columns.length) comp.columns.push({ id: uid('col_'), name: 'Colonne 1' });
  const ids = new Set(cues.map((c) => c.id));
  for (const l of comp.layers) {
    l.clips = Array.from({ length: comp.columns.length }, (_, i) => (ids.has(l.clips?.[i]) ? l.clips[i] : null));
    l.transform = sanitizeTransform(l.transform);
    l.effects = sanitizeEffects(l.effects);
    if (!BLENDS.includes(l.blend)) l.blend = 'normal';
    if (!MASKS.includes(l.mask)) l.mask = 'none';
    l.mainOut = l.mainOut !== false;
    l.auxOutputs = Array.isArray(l.auxOutputs) ? l.auxOutputs.map(String).slice(0, 32) : [];
  }
  comp.master ??= 1;
  comp.clickerColumns ??= true;
  return comp;
}

// --------------------------------------------------------------------- actions
export function compDispatch(store, a) {
  const s = store.state;
  const comp = s.comp;
  const live = s.live.comp;
  const layer = (id) => comp.layers.find((l) => l.id === id);
  const colOk = (c) => Number.isInteger(c) && c >= 0 && c < comp.columns.length;

  switch (a.type) {
    case 'comp.layer.add': {
      const l = newLayer(a.name || `Calque ${comp.layers.length + 1}`, comp.columns.length, s.settings);
      comp.layers.push(l);
      store.emit();
      return { ok: true, id: l.id };
    }
    case 'comp.layer.update': {
      const l = layer(a.id);
      if (!l) return { error: 'calque introuvable' };
      const p = a.patch || {};
      if (p.name != null) l.name = String(p.name).slice(0, 40);
      if (p.opacity != null) l.opacity = num(p.opacity, 1, 0, 1);
      if (p.volume != null) l.volume = num(p.volume, 1, 0, 1);
      if (p.gainDb != null) l.gainDb = num(p.gainDb, 0, -60, 12);
      if (p.transition) l.transition = sanitizeTransition({ ...l.transition, ...p.transition });
      if (p.blend && BLENDS.includes(p.blend)) l.blend = p.blend;
      if (p.mask && MASKS.includes(p.mask)) l.mask = p.mask;
      if (p.bypass != null) l.bypass = !!p.bypass;
      if (p.solo != null) { for (const o of comp.layers) if (p.solo) o.solo = false; l.solo = !!p.solo; }
      if (p.transitionMs != null) l.transitionMs = num(p.transitionMs, 0, 0, 10000);
      if (p.transform) l.transform = sanitizeTransform({ ...l.transform, ...p.transform });
      if (p.effects) l.effects = sanitizeEffects(p.effects);
      if (p.mainOut != null) l.mainOut = !!p.mainOut;
      if (Array.isArray(p.auxOutputs)) l.auxOutputs = p.auxOutputs.map(String).filter((id) => s.outputs.some((o) => o.id === id));
      break;
    }
    case 'comp.layer.remove': {
      if (comp.layers.length <= 1) return { error: 'il faut au moins un calque' };
      comp.layers = comp.layers.filter((l) => l.id !== a.id);
      clearLayer(live, a.id);
      break;
    }
    case 'comp.layer.move': {
      const i = comp.layers.findIndex((l) => l.id === a.id);
      const j = i + (a.dir > 0 ? 1 : -1);
      if (i < 0 || j < 0 || j >= comp.layers.length) return { ok: true };
      [comp.layers[i], comp.layers[j]] = [comp.layers[j], comp.layers[i]];
      break;
    }
    case 'comp.column.add': {
      const at = colOk(a.index) ? a.index + 1 : comp.columns.length;
      comp.columns.splice(at, 0, { id: uid('col_'), name: a.name || `Colonne ${comp.columns.length + 1}` });
      for (const l of comp.layers) l.clips.splice(at, 0, null);
      if (live.column != null && live.column >= at) live.column++;
      break;
    }
    case 'comp.column.update':
      if (!colOk(a.index)) return { error: 'colonne introuvable' };
      comp.columns[a.index].name = String(a.name || '').slice(0, 40) || comp.columns[a.index].name;
      break;
    case 'comp.column.remove': {
      if (!colOk(a.index) || comp.columns.length <= 1) return { error: 'impossible' };
      comp.columns.splice(a.index, 1);
      for (const l of comp.layers) l.clips.splice(a.index, 1);
      if (live.column === a.index) live.column = null;
      else if (live.column > a.index) live.column--;
      break;
    }

    // cases de la grille
    case 'comp.cell.set': {
      const l = layer(a.layerId);
      if (!l || !colOk(a.col)) return { error: 'case introuvable' };
      if (a.cueId && !store.cue(a.cueId)) return { error: 'clip introuvable' };
      l.clips[a.col] = a.cueId || null;
      break;
    }
    case 'comp.cell.create': {
      const l = layer(a.layerId);
      if (!l || !colOk(a.col)) return { error: 'case introuvable' };
      const r = store.dispatch({ type: 'cue.add', cue: a.cue }, 'control');
      if (!r.ok) return r;
      l.clips[a.col] = r.id;
      store.emit();
      return { ok: true, id: r.id };
    }
    case 'comp.cell.move': {
      const fl = layer(a.from?.layerId), tl = layer(a.to?.layerId);
      if (!fl || !tl || !colOk(a.from.col) || !colOk(a.to.col)) return { error: 'case introuvable' };
      const moving = fl.clips[a.from.col];
      if (a.copy) {
        if (!moving) return { ok: true };
        const src = store.cue(moving);
        const { id, ...copy } = structuredClone(src);
        const r = store.dispatch({ type: 'cue.add', cue: copy }, 'control');
        tl.clips[a.to.col] = r.id;
      } else {
        const target = tl.clips[a.to.col];
        tl.clips[a.to.col] = moving;
        fl.clips[a.from.col] = target; // échange
      }
      break;
    }

    // déclenchement
    case 'comp.trigger': {
      const l = layer(a.layerId);
      if (!l || !colOk(a.col)) return { error: 'case introuvable' };
      const cueId = l.clips[a.col];
      if (!cueId) return { ok: true };
      activate(store, l, cueId);
      break;
    }
    case 'comp.column.trigger': {
      if (!colOk(a.col)) return { error: 'colonne introuvable' };
      // Comme dans les logiciels VJ : les calques sans clip dans la colonne sont vidés.
      for (const l of comp.layers) {
        const cueId = l.clips[a.col];
        if (cueId) activate(store, l, cueId);
        else clearLayer(live, l.id);
      }
      live.column = a.col;
      s.live.blackout = false;
      break;
    }
    case 'comp.layer.clear':
      clearLayer(live, a.layerId);
      break;
    case 'comp.clear':
      for (const l of comp.layers) clearLayer(live, l.id);
      live.column = null;
      break;
    case 'comp.master':
      comp.master = num(a.value, 1, 0, 1);
      break;
    case 'comp.settings':
      if (a.clickerColumns != null) comp.clickerColumns = !!a.clickerColumns;
      break;

    // lecture vidéo par calque (calée sur l'horloge du serveur)
    case 'comp.pb.play': case 'comp.pb.pause': case 'comp.pb.seek': case 'comp.pb.restart': {
      const p = live.pb[a.layerId];
      if (!p) return { ok: true };
      const now = Date.now();
      if (a.type === 'comp.pb.play' && !p.playing) { p.playing = true; p.startedAt = now + 100 - p.offset * 1000; }
      if (a.type === 'comp.pb.pause' && p.playing) { p.offset = Math.max(0, (now - p.startedAt) / 1000); p.playing = false; }
      if (a.type === 'comp.pb.seek' || a.type === 'comp.pb.restart') {
        p.offset = a.type === 'comp.pb.restart' ? 0 : Math.max(0, +a.time || 0);
        if (p.playing) p.startedAt = now + 100 - p.offset * 1000;
      }
      p.endedKey = null;
      break;
    }
    case 'comp.ended': {
      // Fin d'un clip non bouclé : arrêt sur la dernière image, ou clip suivant du calque.
      const l = layer(a.layerId);
      const p = live.pb[a.layerId];
      if (!l || !p || live.active[l.id] !== a.cueId) return { ok: true };
      const key = a.cueId + ':' + p.startedAt;
      if (p.endedKey === key) return { ok: true };
      p.endedKey = key;
      const cue = store.cue(a.cueId);
      if ((cue?.loopMode || 'loop') === 'loop') return { ok: true }; // en boucle : rien à faire
      if (cue?.loopMode === 'next') {
        const from = l.clips.indexOf(a.cueId);
        for (let k = 1; k <= l.clips.length; k++) {
          const c = l.clips[(from + k) % l.clips.length];
          if (c) { activate(store, l, c); break; }
        }
      } else if (cue?.loopMode === 'clear') {
        clearLayer(live, l.id);
      } else {
        p.playing = false;
        p.offset = a.duration || 0;
      }
      break;
    }

    // présentations
    case 'comp.slide': {
      const cue = store.cue(a.cueId);
      if (!cue) return { error: 'clip introuvable' };
      const n = store.slideCount(cue);
      const cur = live.slides[cue.id] || 1;
      const next = Math.max(1, Math.min(n, a.slide ?? cur + (a.delta || 0)));
      setSlide(store, cue, next);
      live.deck = cue.id;
      break;
    }
    case 'comp.deck':
      live.deck = a.cueId || null;
      break;

    default:
      return { error: 'action inconnue: ' + a.type };
  }
  store.emit();
  return { ok: true };
}

function clearLayer(live, layerId) {
  delete live.active[layerId];
  delete live.pb[layerId];
  live.at[layerId] = Date.now() + LEAD;
}

function setSlide(store, cue, n) {
  const live = store.state.live.comp;
  live.slides[cue.id] = n;
  live.slideAt[cue.id] = Date.now() + LEAD;
  const nat = store.native?.handles(cue) ? cue : null;
  if (nat) store.native.goto(nat, n);
}

export function activate(store, layer, cueId) {
  const live = store.state.live.comp;
  const cue = store.cue(cueId);
  if (!cue) return;
  const at = Date.now() + LEAD;
  live.active[layer.id] = cueId;
  live.at[layer.id] = at;
  if (cue.type === 'video' || cue.type === 'audio') live.pb[layer.id] = { playing: cue.autoplay !== false, startedAt: at, offset: 0 };
  else delete live.pb[layer.id];
  if (cue.type === 'slides' || (cue.type === 'scene' && store.slideCount(cue) > 1)) {
    live.deck = cue.id;
    live.slides[cue.id] ||= 1;
    live.slideAt[cue.id] = at;
    const nat = store.native?.handles(cue) ? cue : null;
    if (nat) store.native.show(nat, live.slides[cue.id]);
  }
  store.state.live.blackout = false;
}

// Présentation pilotée par la télécommande : la dernière déclenchée, si elle est encore à l'écran.
export function activeDeck(store) {
  const live = store.state.live.comp;
  if (!live.deck) return null;
  return Object.values(live.active).includes(live.deck) ? store.cue(live.deck) : null;
}

// Suivant / précédent (télécommande, clavier) : diapo de la présentation active,
// sinon colonne suivante / précédente.
export function compStep(store, dir) {
  const s = store.state;
  const live = s.live.comp;
  const deck = activeDeck(store);
  if (deck) {
    if (store.native?.handles(deck)) { store.native.step(deck, dir); return true; }
    const n = store.slideCount(deck);
    const cur = live.slides[deck.id] || 1;
    if ((dir > 0 && cur < n) || (dir < 0 && cur > 1)) { setSlide(store, deck, cur + dir); return true; }
    if (!s.comp.clickerColumns) return true;
  }
  if (!s.comp.clickerColumns) return false;
  const cols = s.comp.columns.length;
  const start = live.column == null ? (dir > 0 ? -1 : cols) : live.column;
  for (let c = start + dir; c >= 0 && c < cols; c += dir) {
    if (s.comp.layers.some((l) => l.clips[c])) { compDispatch(store, { type: 'comp.column.trigger', col: c }); return true; }
  }
  return !!deck;
}
