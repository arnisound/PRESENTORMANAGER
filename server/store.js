// État du show (conducteur, médias, sorties, interactions) + logique de régie.
// Toute modification passe par dispatch(action) : un seul point de vérité,
// diffusé ensuite à tous les clients (régie, sorties, télécommandes, public).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { defaultComp, defaultLiveComp, normalizeComp, compDispatch, compStep } from './comp.js';

export const uid = (p = '') => p + crypto.randomBytes(5).toString('hex');

const CUE_TYPES = ['slides', 'video', 'image', 'audio', 'web', 'camera', 'ndi', 'scene', 'poll', 'qa', 'title', 'black', 'color', 'qr', 'window', 'guest'];

// Une adresse tapée sans protocole ("www.site.fr") serait lue comme un chemin local.
export function normalizeUrl(u) {
  const v = String(u || '').trim();
  if (!v || /^[a-z][a-z0-9+.-]*:/i.test(v)) return v;
  return 'https://' + v.replace(/^\/+/, '');
}
const SOURCES = ['program', 'preview', 'presenter', 'multiview', 'clean', 'aux'];

function defaultState() {
  return {
    show: { name: 'Nouvel événement' },
    settings: {
      transition: 'fade', // 'fade' | 'cut'
      transitionMs: 400,
      background: '#000000',
      logoMediaId: null, // affiché quand le programme est vide / en "logo"
      publicUrl: '', // URL publique pour le vote (mode en ligne)
      accent: '#c48626',
      // Lecture
      defaultLayerTransitionMs: 0,
      defaultLayerTransition: 'fade',
      defaultLoopMode: 'loop',
      defaultAutoplay: true,
      masterVolume: 1, // ancien réglage linéaire (repris si masterGainDb absent)
      masterGainDb: 0, // son général en dB (−60 = coupé … +12)
      masterMute: false,
      // Vidéo et performances
      videoSync: 'smooth', // 'smooth' (lecture libre, recommandé) | 'strict' (écrans recalés de près)
      monitorVideo: 'proxy', // écrans de contrôle : 'proxy' (vidéo légère) | 'still' (image fixe) | 'off'
      autoOptimize: false, // réencoder automatiquement HEVC / ProRes à l'import
      gpuAcceleration: true,
      gpuForce: false,
      // Audio
      audioDevice: null, // { id, label } carte son par défaut des sorties
      regieListen: false, // pré-écoute du moniteur de sortie dans la régie
      regieAudioDevice: null,
      // Grille / régie
      cellSize: 132,
      confirmDelete: true,
      // Télécommande / clavier
      clickerDebounceMs: 120,
      blackoutKey: true,
      spaceNext: false,
      // Sorties
      hideCursor: true,
      showOfflineBanner: true,
      outputBackground: '#000000',
      keepAwake: true,
      renderScale: 2,
      preloadSlides: 2,
      // Bandeau (lower-third)
      lowerThirdPosition: 'left',
      lowerThirdStyle: 'dark',
      // Public / présentateur
      voteChange: true,
      voteResultsDefault: true,
      timerWarnSec: 120,
      // Chronomètre : 'always' | 'running' (seulement quand il est lancé) | 'never'
      timerShow: 'running',
      timerOnRegie: true,
      timerOnPresenter: true,
      timerOnRemote: true,
      // NDI
      ndiExtraIps: '',
      ndiFps: 30,
      ndiWidth: 1920,
      ndiHeight: 1080,
      // Visio intégrée (invités à distance)
      stunServers: 'stun:stun.l.google.com:19302',
      turnUrl: '',
      turnUser: '',
      turnPass: '',
      guestToken: uid(),
      guestMaxKbps: 2500,
      guestHeight: 720,
      // Commandes à distance (API HTTP)
      apiToken: uid('api_'),
    },
    media: [],
    cues: [],
    outputs: [
      { id: 'out_public', name: 'Grand écran public', source: 'program', audio: true },
      { id: 'out_presenter', name: 'Retour présentateur', source: 'presenter', audio: false },
      { id: 'out_regie', name: 'Multiview régie', source: 'multiview', audio: false },
    ],
    live: {
      program: null, // { cueId, slide }
      preview: null,
      blackout: false,
      logo: false,
      playback: null, // { cueId, playing, startedAt, offset }
      overlay: null, // { text, sub } bandeau / lower-third
      overlayScenes: [], // scènes d'habillage affichées par-dessus le programme
      cueAt: 0, // horloge serveur : passage à l'antenne de l'élément (synchro vidéos des scènes)
      slideAt: 0, // horloge serveur : dernier changement de diapo (vidéos intégrées aux diapos)
      comp: defaultLiveComp(), // clips actifs de la composition
    },
    comp: defaultComp(), // grille calques × colonnes
    timer: { mode: 'down', duration: 20 * 60 * 1000, running: false, startedAt: 0, elapsed: 0 },
    message: null, // { text, at } message au présentateur
    polls: [],
    questions: [],
    qa: { open: false },
    activePollId: null, // sondage ouvert côté public
  };
}

export class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'show.json');
    this.listeners = new Set();
    this.endedSeen = new Set();
    fs.mkdirSync(path.join(dataDir, 'media'), { recursive: true });
    this.state = defaultState();
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const def = defaultState();
      this.state = {
        ...def,
        ...saved,
        settings: { ...def.settings, ...saved.settings },
        live: { ...def.live, ...saved.live, blackout: false, comp: { ...defaultLiveComp(), ...saved.live?.comp } },
        guests: [],
        timer: { ...def.timer, ...saved.timer },
      };
    } catch { /* premier lancement */ }
    this.state.comp = normalizeComp(this.state.comp, this.state.cues);
    // Un média resté "converting" après un crash ne finira jamais.
    for (const m of this.state.media) if (m.status === 'converting') m.status = 'error', m.error = 'Conversion interrompue';
    this._saveTimer = null;
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  importShow(data) {
    if (!data || !Array.isArray(data.cues) || !data.settings) return { error: 'fichier de show invalide' };
    const def = defaultState();
    const keep = { guestToken: this.state.settings.guestToken, apiToken: this.state.settings.apiToken };
    this.state = {
      ...def, ...data,
      settings: { ...def.settings, ...data.settings, ...keep },
      live: { ...def.live, comp: defaultLiveComp() },
      timer: { ...def.timer, ...data.timer, running: false },
      guests: this.state.guests || [], ndi: this.state.ndi, nativeInfo: this.state.nativeInfo,
    };
    this.state.comp = normalizeComp(this.state.comp, this.state.cues);
    this.emit();
    return { ok: true };
  }

  emit(kind = 'full') {
    for (const fn of this.listeners) fn(this.state, kind);
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.save(), 500);
  }

  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 1));
    fs.renameSync(tmp, this.file);
  }

  cue(id) { return this.state.cues.find((c) => c.id === id); }
  mediaOf(cue) { return cue && cue.mediaId ? this.state.media.find((m) => m.id === cue.mediaId) : null; }

  slideCount(cue) {
    if (!cue) return 1;
    if (cue.type === 'slides') return Math.max(1, this.mediaOf(cue)?.pages || 1);
    if (cue.type === 'scene') {
      // Dans une scène, suivant/précédent pilote le calque principal (une présentation).
      const main = mainLayer(cue, this.state.cues);
      const target = main && this.cue(main.cueId);
      return target && target.type === 'slides' ? this.slideCount(target) : 1;
    }
    return 1;
  }

  // --- navigation -------------------------------------------------------
  stepFrom(pos, dir) {
    const { cues } = this.state;
    if (!cues.length) return null;
    if (!pos) return { cueId: cues[0].id, slide: 1 };
    const cue = this.cue(pos.cueId);
    const idx = cues.findIndex((c) => c.id === pos.cueId);
    if (dir > 0) {
      if (cue && pos.slide < this.slideCount(cue)) return { cueId: cue.id, slide: pos.slide + 1 };
      const nxt = cues[idx + 1];
      return nxt ? { cueId: nxt.id, slide: 1 } : null;
    }
    if (cue && pos.slide > 1) return { cueId: cue.id, slide: pos.slide - 1 };
    const prv = cues[idx - 1];
    return prv ? { cueId: prv.id, slide: this.slideCount(prv) } : null;
  }

  setProgram(pos) {
    const { live } = this.state;
    const prevCue = live.program?.cueId;
    live.program = pos;
    live.blackout = false;
    live.logo = false;
    live.slideAt = Date.now() + 150;
    if (pos && pos.cueId !== prevCue) {
      live.cueAt = live.slideAt;
      const cue = this.cue(pos.cueId);
      if (cue && (cue.type === 'video' || cue.type === 'audio')) {
        const auto = cue.autoplay !== false;
        live.playback = { cueId: cue.id, playing: auto, startedAt: Date.now() + 150, offset: 0 };
      } else {
        live.playback = null;
      }
      // La régie prépare automatiquement l'élément suivant en preview.
      const after = this.state.cues[this.state.cues.findIndex((c) => c.id === pos.cueId) + 1];
      live.preview = after ? { cueId: after.id, slide: 1 } : live.preview;
    }
    if (!pos) live.playback = null;
    // Prévient le pilote PowerPoint natif (ouverture / positionnement du diaporama).
    const target = pos && this.nativeTarget(this.cue(pos.cueId));
    if (target && pos.cueId !== prevCue) this.native.show(target, pos.slide);
  }

  // Présentation pilotée par PowerPoint natif : l'élément lui-même, ou le calque principal d'une scène.
  nativeTarget(cue) {
    if (!cue || !this.native) return null;
    if (cue.type === 'scene') {
      const main = mainLayer(cue, this.state.cues);
      cue = main && this.cue(main.cueId);
    }
    return cue && this.native.handles(cue) ? cue : null;
  }

  // --- actions ----------------------------------------------------------
  dispatch(a, role = 'control') {
    const s = this.state;
    const audienceActions = ['vote', 'qa.ask'];
    const outputActions = ['next', 'prev', 'video.ended', 'blackout.toggle', 'output.report', 'comp.ended'];
    if (role === 'audience' && !audienceActions.includes(a.type)) return { error: 'forbidden' };
    if (role === 'output' && !outputActions.includes(a.type)) return { error: 'forbidden' };
    // Action déjà reçue par une autre voie (télécommande : liaison temps réel + secours HTTP).
    if (a.nonce) {
      this.nonces ||= new Map();
      const now = Date.now();
      for (const [k, t] of this.nonces) if (now - t > 30000) this.nonces.delete(k);
      if (this.nonces.has(a.nonce)) return { ok: true, duplicate: true };
      this.nonces.set(String(a.nonce).slice(0, 40), now);
    }
    if (a.type?.startsWith('comp.')) return compDispatch(this, a);

    switch (a.type) {
      // conducteur
      case 'cue.add': {
        if (!CUE_TYPES.includes(a.cue?.type)) return { error: 'type inconnu' };
        const cue = { id: uid('cue_'), name: '', notes: '', ...a.cue };
        if ((cue.type === 'video' || cue.type === 'audio') && !cue.loopMode) {
          cue.loopMode = s.settings.defaultLoopMode || 'loop';
          if (s.settings.defaultAutoplay === false && cue.autoplay == null) cue.autoplay = false;
        }
        if (cue.type === 'web' && cue.url) cue.url = normalizeUrl(cue.url);
        if (cue.type === 'scene') { cue.layers = sanitizeLayers(cue.layers, s.cues, cue.id); cue.background ||= '#000000'; }
        if (!cue.name) cue.name = defaultName(cue, this.mediaOf(cue));
        const at = a.index ?? s.cues.length;
        s.cues.splice(at, 0, cue);
        if (!s.live.preview) s.live.preview = { cueId: cue.id, slide: 1 };
        this.emit();
        return { ok: true, id: cue.id };
      }
      case 'cue.update': {
        const cue = this.cue(a.id);
        if (!cue) return { error: 'cue introuvable' };
        const { id, type, ...patch } = a.patch || {};
        if (patch.layers) patch.layers = sanitizeLayers(patch.layers, s.cues, cue.id);
        if (typeof patch.url === 'string') patch.url = normalizeUrl(patch.url);
        if (patch.gainDb != null) patch.gainDb = Math.max(-60, Math.min(12, +patch.gainDb || 0));
        Object.assign(cue, patch);
        break;
      }
      case 'cue.remove': {
        s.cues = s.cues.filter((c) => c.id !== a.id);
        for (const c of s.cues) if (c.layers) c.layers = c.layers.filter((l) => l.cueId !== a.id);
        s.live.overlayScenes = s.live.overlayScenes.filter((id) => id !== a.id);
        for (const l of s.comp.layers) l.clips = l.clips.map((c) => (c === a.id ? null : c));
        for (const [lid, cid] of Object.entries(s.live.comp.active)) if (cid === a.id) delete s.live.comp.active[lid];
        if (s.live.program?.cueId === a.id) this.setProgram(null);
        if (s.live.preview?.cueId === a.id) s.live.preview = null;
        break;
      }
      case 'cue.move': {
        const from = s.cues.findIndex((c) => c.id === a.id);
        if (from < 0) return { error: 'cue introuvable' };
        const [c] = s.cues.splice(from, 1);
        s.cues.splice(Math.max(0, Math.min(a.index, s.cues.length)), 0, c);
        break;
      }
      case 'cue.duplicate': {
        const i = s.cues.findIndex((c) => c.id === a.id);
        if (i < 0) return { error: 'cue introuvable' };
        s.cues.splice(i + 1, 0, { ...structuredClone(s.cues[i]), id: uid('cue_'), name: s.cues[i].name + ' (copie)' });
        break;
      }

      // diffusion
      case 'preview.set':
        s.live.preview = a.cueId ? { cueId: a.cueId, slide: clampSlide(this, a.cueId, a.slide) } : null;
        break;
      case 'take': {
        if (!s.live.preview) return { error: 'preview vide' };
        this.setProgram({ ...s.live.preview });
        break;
      }
      case 'program.set':
        this.setProgram(a.cueId ? { cueId: a.cueId, slide: clampSlide(this, a.cueId, a.slide) } : null);
        break;
      case 'program.clear':
        this.setProgram(null);
        break;
      case 'next':
      case 'prev': {
        // Anti-rebond : certaines télécommandes envoient 2 événements par appui.
        const now = Date.now();
        if (this._lastNav && now - this._lastNav < (s.settings.clickerDebounceMs ?? 120)) return { ok: true };
        this._lastNav = now;
        if (s.live.blackout) { s.live.blackout = false; break; }
        // Composition : diapo de la présentation active, sinon colonne suivante.
        if (compStep(this, a.type === 'next' ? 1 : -1)) break;
        // PowerPoint natif : c'est PowerPoint qui avance (animations, builds, transitions).
        const nat = this.nativeTarget(this.cue(s.live.program?.cueId));
        if (nat) { this.native.step(nat, a.type === 'next' ? 1 : -1); return { ok: true }; }
        const pos = this.stepFrom(s.live.program, a.type === 'next' ? 1 : -1);
        if (pos) this.setProgram(pos);
        break;
      }
      case 'slide.goto': {
        if (!s.live.program) return { error: 'rien au programme' };
        s.live.program = { ...s.live.program, slide: clampSlide(this, s.live.program.cueId, a.slide) };
        s.live.slideAt = Date.now() + 150;
        const nat = this.nativeTarget(this.cue(s.live.program.cueId));
        if (nat) this.native.goto(nat, s.live.program.slide);
        break;
      }
      case 'native.status': {
        // Retour du pilote PowerPoint (app desktop) : position réelle du diaporama.
        if (role !== 'system') return { error: 'forbidden' };
        const cue = this.cue(a.cueId);
        s.live.native = { cueId: a.cueId, sourceId: a.sourceId ?? (s.live.native?.cueId === a.cueId ? s.live.native.sourceId : null),
          slide: a.slide || 1, click: a.click ?? 0, clicks: a.clicks ?? 0, total: a.total || 0, error: a.error || null };
        const lc = s.live.comp;
        if (cue && lc.deck === a.cueId) {
          if (a.slide) { lc.slides[a.cueId] = a.slide; lc.slideAt[a.cueId] = Date.now() + 150; }
          if (a.ended && s.comp.clickerColumns) {
            // Fin du diaporama : colonne suivante.
            const deck = lc.deck; lc.deck = null;
            if (!compStep(this, 1)) lc.deck = deck;
          }
          break;
        }
        const p = s.live.program;
        const progCue = this.cue(p?.cueId);
        if (!cue || this.nativeTarget(progCue)?.id !== a.cueId) break;
        if (a.ended) { const nx = this.stepFrom({ cueId: progCue.id, slide: this.slideCount(progCue) }, 1); if (nx) this.setProgram(nx); }
        else if (a.begin) { const pv = this.stepFrom({ cueId: progCue.id, slide: 1 }, -1); if (pv) this.setProgram(pv); }
        else if (a.slide && a.slide !== p.slide) { s.live.program = { ...p, slide: a.slide }; s.live.slideAt = Date.now() + 150; }
        break;
      }
      case 'blackout.toggle':
        s.live.blackout = a.value ?? !s.live.blackout;
        break;
      case 'logo.toggle':
        s.live.logo = a.value ?? !s.live.logo;
        break;
      case 'overlay.scene': {
        const cue = this.cue(a.cueId);
        if (!cue || cue.type !== 'scene') return { error: 'scène introuvable' };
        const on = a.value ?? !s.live.overlayScenes.includes(cue.id);
        s.live.overlayScenes = s.live.overlayScenes.filter((id) => id !== cue.id);
        if (on) s.live.overlayScenes.push(cue.id);
        break;
      }
      case 'overlay.set':
        s.live.overlay = a.overlay && a.overlay.text ? { text: a.overlay.text, sub: a.overlay.sub || '' } : null;
        break;

      // lecture vidéo/audio (synchronisée sur l'horloge serveur)
      case 'video.play': {
        const p = s.live.playback;
        if (!p || p.playing) break;
        p.playing = true;
        p.startedAt = Date.now() + 100 - p.offset * 1000;
        break;
      }
      case 'video.pause': {
        const p = s.live.playback;
        if (!p || !p.playing) break;
        p.offset = (Date.now() - p.startedAt) / 1000;
        p.playing = false;
        break;
      }
      case 'video.seek': {
        const p = s.live.playback;
        if (!p) break;
        p.offset = Math.max(0, a.time || 0);
        if (p.playing) p.startedAt = Date.now() + 100 - p.offset * 1000;
        break;
      }
      case 'video.ended': {
        const p = s.live.playback;
        if (!p || p.cueId !== a.cueId) return { ok: true };
        const key = p.cueId + ':' + p.startedAt;
        if (this.endedSeen.has(key)) return { ok: true };
        this.endedSeen.add(key);
        const cue = this.cue(p.cueId);
        if (cue?.loop) return { ok: true };
        if (cue?.autoNext) {
          const pos = this.stepFrom(s.live.program, 1);
          if (pos) { this.setProgram(pos); break; }
        }
        p.playing = false;
        p.offset = a.duration || 0;
        break;
      }

      // sorties vidéo
      case 'output.add':
        s.outputs.push({ id: uid('out_'), name: a.name || 'Nouvelle sortie', source: 'program', audio: false });
        break;
      case 'output.update': {
        const o = s.outputs.find((x) => x.id === a.id);
        if (!o) return { error: 'sortie introuvable' };
        const { id, ...patch } = a.patch || {};
        if (patch.source && !SOURCES.includes(patch.source) && !/^(cue|layer):/.test(patch.source)) return { error: 'source invalide' };
        if (patch.zones) patch.zones = sanitizeZones(patch.zones);
        Object.assign(o, patch);
        break;
      }
      case 'output.report': {
        // Résolution réelle de l'écran, utile à l'éditeur de mapping.
        const o = s.outputs.find((x) => x.id === a.id);
        if (!o || !(a.w > 0 && a.h > 0)) return { ok: true };
        if (o.resolution?.w === a.w && o.resolution?.h === a.h) return { ok: true };
        o.resolution = { w: Math.round(a.w), h: Math.round(a.h) };
        break;
      }
      case 'output.remove':
        s.outputs = s.outputs.filter((o) => o.id !== a.id);
        break;

      // réglages
      case 'settings.update': {
        const { guestToken, apiToken, ...p } = a.patch || {};
        if (p.masterGainDb != null) p.masterGainDb = Math.max(-60, Math.min(12, +p.masterGainDb || 0));
        if (p.masterMute != null) p.masterMute = !!p.masterMute;
        Object.assign(s.settings, p);
        break;
      }
      case 'settings.regenerate':
        // Nouveau lien invité / nouveau jeton d'API (révoque les anciens).
        if (a.key === 'guestToken') s.settings.guestToken = uid();
        if (a.key === 'apiToken') s.settings.apiToken = uid('api_');
        break;
      case 'show.rename':
        s.show.name = String(a.name || '').slice(0, 120) || s.show.name;
        break;

      // chrono + message présentateur
      case 'timer.set': {
        const t = s.timer;
        if (a.mode) t.mode = a.mode;
        if (a.duration != null) t.duration = Math.max(0, a.duration);
        t.elapsed = 0; t.running = false;
        break;
      }
      case 'timer.start': {
        const t = s.timer;
        if (!t.running) { t.running = true; t.startedAt = Date.now(); }
        break;
      }
      case 'timer.pause': {
        const t = s.timer;
        if (t.running) { t.elapsed += Date.now() - t.startedAt; t.running = false; }
        break;
      }
      case 'timer.reset':
        Object.assign(s.timer, { running: false, elapsed: 0 });
        break;
      case 'message.send':
        s.message = a.text ? { text: String(a.text).slice(0, 300), at: Date.now() } : null;
        break;

      // sondages / questionnaires
      case 'poll.create': {
        const poll = {
          id: uid('poll_'),
          question: a.poll?.question || 'Nouvelle question',
          kind: a.poll?.kind || 'choice', // choice | multi | rating | words
          options: a.poll?.options?.length ? a.poll.options : ['Oui', 'Non'],
          showResults: s.settings.voteResultsDefault !== false,
          votes: {}, // voterId -> réponse
        };
        s.polls.push(poll);
        this.emit();
        return { ok: true, id: poll.id };
      }
      case 'poll.update': {
        const p = s.polls.find((x) => x.id === a.id);
        if (!p) return { error: 'sondage introuvable' };
        const { id, votes, ...patch } = a.patch || {};
        Object.assign(p, patch);
        break;
      }
      case 'poll.remove':
        s.polls = s.polls.filter((p) => p.id !== a.id);
        if (s.activePollId === a.id) s.activePollId = null;
        break;
      case 'poll.open':
        s.activePollId = a.id || null;
        break;
      case 'poll.reset': {
        const p = s.polls.find((x) => x.id === a.id);
        if (p) p.votes = {};
        break;
      }
      case 'vote': {
        const p = s.polls.find((x) => x.id === a.pollId);
        if (!p || s.activePollId !== p.id || !a.voterId) return { error: 'vote fermé' };
        if (s.settings.voteChange === false && p.votes[String(a.voterId).slice(0, 40)] != null) return { error: 'vous avez déjà voté' };
        p.votes[String(a.voterId).slice(0, 40)] = sanitizeVote(p, a.answer);
        this.emit('votes');
        return { ok: true };
      }

      // questions du public
      case 'qa.toggle':
        s.qa.open = a.value ?? !s.qa.open;
        break;
      case 'qa.ask': {
        if (!s.qa.open) return { error: 'questions fermées' };
        const text = String(a.text || '').trim().slice(0, 280);
        if (!text) return { error: 'vide' };
        s.questions.push({ id: uid('q_'), text, author: String(a.author || '').slice(0, 40), status: 'pending', at: Date.now() });
        break;
      }
      case 'qa.update': {
        const q = s.questions.find((x) => x.id === a.id);
        if (!q) return { error: 'question introuvable' };
        if (a.status) q.status = a.status; // pending | approved | shown | done | rejected
        if (a.status === 'shown') for (const o of s.questions) if (o !== q && o.status === 'shown') o.status = 'done';
        break;
      }
      case 'qa.clear':
        s.questions = [];
        break;

      case 'media.optimize': {
        const m = s.media.find((x) => x.id === a.id);
        if (!m || m.kind !== 'video') return { error: 'vidéo introuvable' };
        if (!this.mediaTasks?.optimize) return { error: 'optimisation indisponible' };
        this.mediaTasks.optimize(m, { maxHeight: Math.max(360, Math.min(2160, +a.height || 2160)) });
        break;
      }
      case 'media.remove': {
        s.media = s.media.filter((m) => m.id !== a.id);
        for (const c of s.cues) if (c.mediaId === a.id) c.mediaId = null;
        break;
      }

      default:
        return { error: 'action inconnue: ' + a.type };
    }
    this.emit();
    return { ok: true };
  }

  // Vue réduite et anonymisée pour le public (pas de conducteur, pas de notes).
  publicState() {
    const s = this.state;
    const poll = s.polls.find((p) => p.id === s.activePollId);
    return {
      show: s.show,
      accent: s.settings.accent,
      qaOpen: s.qa.open,
      poll: poll ? { id: poll.id, question: poll.question, kind: poll.kind, options: poll.options,
        results: poll.showResults ? pollResults(poll) : null } : null,
    };
  }
}

// Une scène ne peut pas contenir de scène (évite les boucles infinies de rendu).
function sanitizeLayers(layers, cues, selfId) {
  const num = (v, d, min = -1, max = 2) => (Number.isFinite(+v) ? Math.max(min, Math.min(max, +v)) : d);
  return (Array.isArray(layers) ? layers : []).slice(0, 32).filter((l) => {
    const c = cues.find((x) => x.id === l.cueId);
    return !l.cueId || (c && c.type !== 'scene' && c.id !== selfId);
  }).map((l) => ({
    id: String(l.id || uid('ly_')),
    name: String(l.name || '').slice(0, 60),
    cueId: l.cueId || null,
    x: num(l.x, 0), y: num(l.y, 0), w: num(l.w, 1, 0.01, 3), h: num(l.h, 1, 0.01, 3),
    opacity: num(l.opacity, 1, 0, 1),
    fit: ['contain', 'cover', 'fill'].includes(l.fit) ? l.fit : 'contain',
    crop: { l: num(l.crop?.l, 0, 0, 0.9), t: num(l.crop?.t, 0, 0, 0.9), r: num(l.crop?.r, 0, 0, 0.9), b: num(l.crop?.b, 0, 0, 0.9) },
    radius: num(l.radius, 0, 0, 0.5),
    visible: l.visible !== false,
    main: !!l.main,
    slide: Math.max(1, Math.round(+l.slide || 1)),
  }));
}

const ZONE_SOURCES = ['', 'program', 'clean', 'preview', 'aux'];
const zoneSourceOk = (v) => ZONE_SOURCES.includes(v) || /^(cue|layer):/.test(String(v || ''));
// Grille de déformation : décalage de chaque point par rapport à la grille régulière.
function sanitizeMesh(m) {
  if (!m || !m.cols || !m.rows) return null;
  const cols = Math.max(1, Math.min(8, m.cols | 0)), rows = Math.max(1, Math.min(8, m.rows | 0));
  const n = (cols + 1) * (rows + 1);
  const pts = Array.from({ length: n }, (_, i) => {
    const p = m.points?.[i] || [0, 0];
    return [Math.max(-1, Math.min(1, +p[0] || 0)), Math.max(-1, Math.min(1, +p[1] || 0))];
  });
  return { cols, rows, points: pts };
}
// Masques : polygones dans le repère de la zone (0 à 1), à masquer ou à garder.
function sanitizeMasks(list) {
  return (Array.isArray(list) ? list : []).slice(0, 16).map((m) => ({
    id: String(m.id || uid('mk_')),
    points: (Array.isArray(m.points) ? m.points : []).slice(0, 64).map((p) => [Math.max(-1, Math.min(2, +p[0] || 0)), Math.max(-1, Math.min(2, +p[1] || 0))]),
    invert: !!m.invert,
    feather: Math.max(0, Math.min(20, +m.feather || 0)),
  })).filter((m) => m.points.length >= 3);
}
function sanitizeZones(zones) {
  const num = (v, d, min, max) => (Number.isFinite(+v) ? Math.max(min, Math.min(max, +v)) : d);
  const def = [[0, 0], [1, 0], [1, 1], [0, 1]];
  return (Array.isArray(zones) ? zones : []).slice(0, 16).map((z, i) => ({
    id: String(z.id || uid('zn_')),
    name: String(z.name || `Zone ${i + 1}`).slice(0, 40),
    source: zoneSourceOk(z.source) ? z.source || '' : '',
    corners: def.map((d, k) => [num(z.corners?.[k]?.[0], d[0], -2, 3), num(z.corners?.[k]?.[1], d[1], -2, 3)]),
    crop: { x: num(z.crop?.x, 0, 0, 0.99), y: num(z.crop?.y, 0, 0, 0.99), w: num(z.crop?.w, 1, 0.01, 1), h: num(z.crop?.h, 1, 0.01, 1) },
    blend: { l: num(z.blend?.l, 0, 0, 0.5), r: num(z.blend?.r, 0, 0, 0.5), t: num(z.blend?.t, 0, 0, 0.5), b: num(z.blend?.b, 0, 0, 0.5) },
    gamma: num(z.gamma, 2.2, 1, 3),
    mesh: sanitizeMesh(z.mesh),
    masks: sanitizeMasks(z.masks),
    lock: !!z.lock,
    opacity: num(z.opacity, 1, 0, 1),
    visible: z.visible !== false,
  }));
}

export function mainLayer(scene, cues) {
  const layers = scene.layers || [];
  return layers.find((l) => l.main) || layers.find((l) => cues.find((c) => c.id === l.cueId)?.type === 'slides') || null;
}

function clampSlide(store, cueId, slide) {
  const n = store.slideCount(store.cue(cueId));
  return Math.max(1, Math.min(n, slide || 1));
}

function defaultName(cue, media) {
  if (media) return media.name.replace(/\.[^.]+$/, '');
  return { web: 'Page web / visio', camera: 'Caméra / capture', poll: 'Sondage', qa: 'Questions du public',
    title: 'Titre', black: 'Noir', color: 'Couleur', qr: 'QR code', window: 'Fenêtre', guest: 'Invité', scene: 'Scène', ndi: 'Source NDI', slides: 'Présentation', video: 'Vidéo', image: 'Image', audio: 'Audio' }[cue.type];
}

function sanitizeVote(poll, answer) {
  if (poll.kind === 'multi') return [].concat(answer).map(Number).filter((n) => n >= 0 && n < poll.options.length).slice(0, poll.options.length);
  if (poll.kind === 'rating') return Math.max(1, Math.min(5, Number(answer) || 1));
  if (poll.kind === 'words') return String(answer || '').trim().toLowerCase().slice(0, 30);
  const n = Number(answer);
  return n >= 0 && n < poll.options.length ? n : 0;
}

export function pollResults(poll) {
  const votes = Object.values(poll.votes || {});
  const total = votes.length;
  if (poll.kind === 'rating') {
    const counts = [0, 0, 0, 0, 0];
    for (const v of votes) counts[v - 1]++;
    const avg = total ? votes.reduce((a, b) => a + b, 0) / total : 0;
    return { total, counts, avg };
  }
  if (poll.kind === 'words') {
    const map = {};
    for (const v of votes) if (v) map[v] = (map[v] || 0) + 1;
    const words = Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, 40);
    return { total, words };
  }
  const counts = poll.options.map(() => 0);
  for (const v of votes) for (const i of [].concat(v)) if (counts[i] != null) counts[i]++;
  return { total, counts };
}
