// Serveur PresenThor : sert l'interface, les médias, et synchronise en temps réel
// tous les écrans (régie, sorties, télécommandes, public) via WebSocket.
// Utilisé tel quel en ligne (node server/start.js) et embarqué dans l'app desktop.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import QRCode from 'qrcode';
import { WebSocketServer } from 'ws';
import { Store, uid, pollResults } from './store.js';
import { processMedia, kindOf, officeConverters, queueVideo, pptxNotes, pptxMedia } from './media.js';
import { prepareVideo, optimizeVideo, ffmpeg, probeFull, makeProxy } from './video.js';
import { startNdiDiscovery } from './ndi.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require_ = (p) => path.join(ROOT, 'node_modules', p);

export function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  }
  return out;
}

export async function startServer({ port = 4517, host = '0.0.0.0', dataDir = path.join(ROOT, 'data'), pin = process.env.PRESENTHOR_PIN || process.env.PRESENTOR_PIN || '' } = {}) {
  const store = new Store(dataDir);
  const stopNdi = startNdiDiscovery(store);
  const mediaDirPath = path.join(dataDir, 'media');
  store.mediaTasks = { optimize: (m, opts) => optimizeVideo(m, mediaDirPath, () => store.emit(), opts) };
  // Shows existants : prépare en arrière-plan les vidéos importées avant cette version.
  for (const m of store.state.media) {
    if (m.optimize) m.optimize = null;
    if (m.kind === 'video' && !m.thumb && ffmpeg()) queueVideo(() => prepareVideo(m, path.join(mediaDirPath, m.file), mediaDirPath, () => store.emit()));
    else if (m.kind === 'video' && !m.proxy && ffmpeg()) queueVideo(() => makeProxy(m, path.join(mediaDirPath, m.original || m.file), mediaDirPath, () => store.emit()));
    // PowerPoint importés avant la correction des diapos masquées : notes et vidéos réanalysées.
    if (m.kind === 'slides' && m.source && /\.(pptx|ppsx)$/i.test(m.source) && (m.pptxV || 0) < 2) {
      try {
        m.notes = pptxNotes(path.join(mediaDirPath, m.source));
        m.videos = pptxMedia(path.join(mediaDirPath, m.source), mediaDirPath, m.id);
        m.pptxV = 2;
      } catch {}
    }
    if (m.kind === 'audio' && m.duration == null && ffmpeg()) queueVideo(async () => { m.duration = (await probeFull(path.join(mediaDirPath, m.file))).duration; store.emit(); });
  }
  const mediaDir = path.join(dataDir, 'media');
  const app = express();
  const server = http.createServer(app);

  const authorized = (req) => !pin || req.get('x-pin') === pin || req.query.pin === pin;
  // API de commande : PIN de la régie, ou jeton d'API (réglages) — utile pour un pilotage externe.
  const apiAuthorized = (req) => {
    const tok = req.get('x-token') || req.query.token || (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    return (!pin && !store.state.settings.apiRequireToken) || (pin && (req.get('x-pin') === pin || req.query.pin === pin)) || (tok && tok === store.state.settings.apiToken);
  };

  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));
  app.use('/vendor/pdfjs', express.static(require_('pdfjs-dist/build'), { maxAge: '7d' }));
  app.use('/media', express.static(mediaDir, { maxAge: '1h', acceptRanges: true }));
  app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));
  app.get('/v', (req, res) => res.redirect('/vote/'));

  app.get('/api/info', async (req, res) => {
    const converters = await officeConverters();
    const addr = server.address();
    res.json({
      port: addr.port,
      lan: lanAddresses().map((ip) => `http://${ip}:${addr.port}`),
      pinRequired: !!pin,
      converter: converters.length > 0,
      converters,
    });
  });

  app.get('/api/qr.svg', async (req, res) => {
    const text = String(req.query.text || '').slice(0, 500);
    const svg = await QRCode.toString(text || ' ', { type: 'svg', margin: 1, color: { dark: req.query.dark || '#000000', light: req.query.light || '#ffffff' } });
    res.type('image/svg+xml').set('Cache-Control', 'max-age=3600').send(svg);
  });

  const upload = multer({
    storage: multer.diskStorage({
      destination: mediaDir,
      filename: (req, file, cb) => {
        // multer décode les noms en latin1 : on les remet en UTF-8 (accents).
        file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
        const id = uid('m_');
        file.mediaId = id;
        cb(null, id + path.extname(file.originalname).toLowerCase());
      },
    }),
    fileFilter: (req, file, cb) => cb(null, !!kindOf(Buffer.from(file.originalname, 'latin1').toString('utf8'))),
    limits: { fileSize: 8 * 1024 ** 3 },
  });

  app.post('/api/media', (req, res, next) => (authorized(req) ? next() : res.status(401).json({ error: 'PIN requis' })),
    upload.array('files', 50), (req, res) => {
      const created = [];
      for (const f of req.files || []) {
        const media = { id: f.mediaId, name: f.originalname, file: f.filename, size: f.size, kind: kindOf(f.originalname), status: 'processing', addedAt: Date.now() };
        store.state.media.push(media);
        created.push(media);
        processMedia(media, f.path, mediaDir, () => {
          // Préférence : réencoder automatiquement les formats délicats (HEVC, ProRes…).
          if (media.needsOptimize && store.state.settings.autoOptimize && !media._autoOpt && !media.optimize) {
            media._autoOpt = true;
            optimizeVideo(media, mediaDir, () => store.emit());
          }
          store.emit();
        });
      }
      // Fichiers déposés sur une case de la grille : clips créés à partir de cette case
      // (cases libres suivantes du même calque pour un dépôt multiple).
      if (req.query.layer) {
        const layer = store.state.comp.layers.find((l) => l.id === req.query.layer);
        let col = Math.max(0, parseInt(req.query.col, 10) || 0);
        created.forEach((m, i) => {
          if (!layer) return;
          if (i > 0) while (col < layer.clips.length && layer.clips[col]) col++; // fichiers suivants : cases libres
          while (col >= layer.clips.length) store.dispatch({ type: 'comp.column.add' });
          const type = m.kind === 'office' ? 'slides' : m.kind;
          store.dispatch({ type: 'comp.cell.create', layerId: layer.id, col, cue: { type, mediaId: m.id } });
          col++;
        });
      }
      // Création automatique des éléments du conducteur si demandé.
      if (req.query.addCues === '1') {
        for (const m of created) {
          const type = m.kind === 'office' ? 'slides' : m.kind;
          store.dispatch({ type: 'cue.add', cue: { type, mediaId: m.id } });
        }
      }
      store.emit();
      res.json({ media: created });
    });

  // ---------------------------------------------------------------- API de commande
  // POST /api/action  { "type": "comp.column.trigger", "col": 0 }  (toutes les actions de la régie)
  app.post('/api/action', (req, res) => {
    if (!apiAuthorized(req)) return res.status(401).json({ error: 'jeton requis' });
    let r;
    try { r = store.dispatch(req.body || {}, 'control'); } catch (e) { r = { error: e.message }; }
    res.status(r?.error ? 400 : 200).json(r);
  });
  // Raccourcis GET, pratiques pour un Stream Deck, Companion, un navigateur…
  const layerRef = (ref) => {
    const L = store.state.comp.layers;
    return L.find((l) => l.id === ref || l.name.toLowerCase() === String(ref).toLowerCase()) || L[parseInt(ref, 10) - 1];
  };
  const go = {
    next: () => store.dispatch({ type: 'next' }),
    prev: () => store.dispatch({ type: 'prev' }),
    blackout: () => store.dispatch({ type: 'blackout.toggle' }),
    clear: () => store.dispatch({ type: 'comp.clear' }),
    column: (n) => store.dispatch({ type: 'comp.column.trigger', col: parseInt(n, 10) - 1 }),
    clip: (layer, n) => { const l = layerRef(layer); return l ? store.dispatch({ type: 'comp.trigger', layerId: l.id, col: parseInt(n, 10) - 1 }) : { error: 'calque introuvable' }; },
    'clear-layer': (layer) => { const l = layerRef(layer); return l ? store.dispatch({ type: 'comp.layer.clear', layerId: l.id }) : { error: 'calque introuvable' }; },
    opacity: (layer, v) => { const l = layerRef(layer); return l ? store.dispatch({ type: 'comp.layer.update', id: l.id, patch: { opacity: parseFloat(v) } }) : { error: 'calque introuvable' }; },
    master: (v) => store.dispatch({ type: 'comp.master', value: parseFloat(v) }),
    slide: (n) => { const d = store.state.live.comp.deck; return d ? store.dispatch({ type: 'comp.slide', cueId: d, slide: parseInt(n, 10) }) : { error: 'aucune présentation' }; },
    message: (text) => store.dispatch({ type: 'message.send', text: decodeURIComponent(text || '') }),
  };
  app.get(/^\/api\/go\/([a-z-]+)(?:\/([^/]+))?(?:\/([^/]+))?$/, (req, res) => {
    if (!apiAuthorized(req)) return res.status(401).json({ error: 'jeton requis' });
    const fn = go[req.params[0]];
    if (!fn) return res.status(404).json({ error: 'commande inconnue', commandes: Object.keys(go) });
    const r = fn(req.params[1], req.params[2]);
    res.status(r?.error ? 400 : 200).json(r);
  });
  app.get('/api/status', (req, res) => {
    if (!apiAuthorized(req)) return res.status(401).json({ error: 'jeton requis' });
    const s = store.state, lc = s.live.comp;
    res.json({
      show: s.show.name, blackout: s.live.blackout, master: s.comp.master, column: lc.column,
      columns: s.comp.columns.map((c, i) => ({ n: i + 1, name: c.name })),
      layers: s.comp.layers.map((l, i) => ({ n: i + 1, id: l.id, name: l.name, opacity: l.opacity, active: s.cues.find((c) => c.id === lc.active[l.id])?.name || null })),
      deck: lc.deck ? { name: s.cues.find((c) => c.id === lc.deck)?.name, slide: lc.slides[lc.deck] } : null,
    });
  });

  // Restauration d'un show exporté (grille, réglages, sondages…). Les médias restent sur le disque.
  app.post('/api/import', express.json({ limit: '50mb' }), (req, res) => {
    if (!authorized(req)) return res.status(401).end();
    const r = store.importShow(req.body);
    res.status(r.error ? 400 : 200).json(r);
  });

  app.get('/api/export', (req, res) => {
    if (!authorized(req)) return res.status(401).end();
    res.attachment(`${store.state.show.name || 'show'}.presenthor.json`).json(store.state);
  });

  // --- WebSocket --------------------------------------------------------
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1024 * 1024 });
  // Les erreurs d'écoute (port occupé…) sont gérées par server.listen : on évite le plantage.
  wss.on('error', () => {});
  const clients = new Set();

  const counters = () => {
    const outputs = {};
    let audience = 0, controls = 0;
    for (const c of clients) {
      if (c.role === 'output' && c.outputId) outputs[c.outputId] = (outputs[c.outputId] || 0) + 1;
      else if (c.role === 'audience') audience++;
      else if (c.role === 'guest') continue;
      else controls++;
    }
    return { outputs, audience, controls };
  };

  const controlState = () => {
    const s = store.state;
    return {
      ...s,
      polls: s.polls.map(({ votes, ...p }) => ({ ...p, results: pollResults({ ...p, votes }) })),
      clients: counters(),
      serverNow: Date.now(),
    };
  };

  let fullTimer = null, publicTimer = null;
  const flushFull = () => {
    fullTimer = null;
    const st = controlState();
    const msg = JSON.stringify({ t: 'state', state: st });
    // Les invités (visio) n'ont pas accès aux jetons de la régie.
    let guestMsg = null;
    for (const c of clients) {
      if (c.role === 'audience' || c.ws.readyState !== 1) continue;
      if (c.role === 'guest') {
        guestMsg ||= JSON.stringify({ t: 'state', state: { ...st, settings: { ...st.settings, apiToken: undefined, guestToken: undefined }, polls: [], questions: [] } });
        c.ws.send(guestMsg);
      } else c.ws.send(msg);
    }
  };
  // Liste des invités connectés (visio intégrée), diffusée avec l'état.
  const syncGuests = () => {
    store.state.guests = [...clients].filter((c) => c.role === 'guest').map((c) => ({ id: c.guestId, name: c.name, cid: c.cid, since: c.since }));
  };
  const flushPublic = () => {
    publicTimer = null;
    const msg = JSON.stringify({ t: 'public', state: store.publicState() });
    for (const c of clients) if (c.role === 'audience' && c.ws.readyState === 1) c.ws.send(msg);
  };
  const broadcast = (kind) => {
    // Les actions de régie partent immédiatement ; les votes sont regroupés.
    if (!fullTimer) fullTimer = setTimeout(flushFull, kind === 'votes' ? 150 : 0);
    if (!publicTimer) publicTimer = setTimeout(flushPublic, 250);
  };
  store.onChange((_, kind) => broadcast(kind));

  wss.on('connection', (ws, req) => {
    const q = new URL(req.url, 'http://x').searchParams;
    let role = q.get('role') || 'audience';
    if (!['control', 'output', 'audience', 'guest'].includes(role)) role = 'audience';
    if (role === 'guest' && q.get('k') !== store.state.settings.guestToken) {
      ws.send(JSON.stringify({ t: 'auth', error: 'Lien invité invalide ou expiré' }));
      return ws.close(4003, 'guest');
    }
    if (role !== 'audience' && role !== 'guest' && pin && q.get('pin') !== pin) {
      ws.send(JSON.stringify({ t: 'auth', error: 'PIN incorrect' }));
      return ws.close(4001, 'pin');
    }
    const client = { ws, role, outputId: q.get('output') || null, cid: uid('c_'), since: Date.now() };
    if (role === 'guest') {
      client.guestId = String(q.get('gid') || client.cid).slice(0, 40);
      client.name = String(q.get('name') || 'Invité').slice(0, 40);
      // Un invité qui se reconnecte remplace son ancienne connexion.
      for (const c of clients) if (c.role === 'guest' && c.guestId === client.guestId) { c.ws.close(4004, 'replaced'); clients.delete(c); }
    }
    clients.add(client);
    if (role === 'guest') { syncGuests(); store.emit('guests'); }
    ws.send(JSON.stringify({ t: 'hello', role, cid: client.cid, serverNow: Date.now() }));
    if (role === 'audience') ws.send(JSON.stringify({ t: 'public', state: store.publicState() }));
    broadcast(); // envoie l'état complet + met à jour les compteurs de connexion

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.t === 'ping') return ws.send(JSON.stringify({ t: 'pong', c: msg.c, s: Date.now() }));
      // Signalisation WebRTC (visio intégrée) : relais entre un invité et un écran / la régie.
      if (msg.t === 'rtc' && msg.to && role !== 'audience') {
        const target = [...clients].find((c) => c.cid === msg.to);
        if (!target || target.role === 'audience' || (role !== 'guest' && target.role !== 'guest')) return;
        if (target.ws.readyState === 1) target.ws.send(JSON.stringify({ t: 'rtc', from: client.cid, fromRole: role, data: msg.data }));
        return;
      }
      if (role === 'guest' && msg.t === 'guest.name') { client.name = String(msg.name || 'Invité').slice(0, 40); syncGuests(); store.emit('guests'); return; }
      if (role === 'guest' && msg.t === 'action') return; // un invité ne pilote rien
      if (msg.t === 'action' && msg.action) {
        let result;
        try { result = store.dispatch(msg.action, role); } catch (e) { result = { error: e.message }; }
        // L'état à jour part avant l'accusé : l'émetteur le voit dès la réponse.
        if (role !== 'audience' && fullTimer) { clearTimeout(fullTimer); flushFull(); }
        if (msg.id) ws.send(JSON.stringify({ t: 'ack', id: msg.id, result }));
      }
    });
    ws.on('close', () => {
      if (!clients.delete(client)) return;
      if (role === 'guest') { syncGuests(); store.emit('guests'); }
      broadcast();
    });
  });

  // Heartbeat : détecte les écrans déconnectés (câble réseau, veille…)
  setInterval(() => {
    for (const c of clients) {
      if (c.ws.isAlive === false) { c.ws.terminate(); continue; }
      c.ws.isAlive = false;
      c.ws.ping();
    }
  }, 10000).unref();
  wss.on('connection', (ws) => { ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; }); });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const actualPort = server.address().port;
  return {
    port: actualPort,
    url: `http://localhost:${actualPort}`,
    store,
    close: () => new Promise((r) => { stopNdi(); store.save(); wss.close(); server.close(r); }),
  };
}
