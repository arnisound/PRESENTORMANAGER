// Serveur Presentor : sert l'interface, les médias, et synchronise en temps réel
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
import { processMedia, kindOf, findSoffice } from './media.js';
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

export async function startServer({ port = 4517, host = '0.0.0.0', dataDir = path.join(ROOT, 'data'), pin = process.env.PRESENTOR_PIN || '' } = {}) {
  const store = new Store(dataDir);
  const stopNdi = startNdiDiscovery(store);
  const mediaDir = path.join(dataDir, 'media');
  const app = express();
  const server = http.createServer(app);

  const authorized = (req) => !pin || req.get('x-pin') === pin || req.query.pin === pin;

  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));
  app.use('/vendor/pdfjs', express.static(require_('pdfjs-dist/build'), { maxAge: '7d' }));
  app.use('/media', express.static(mediaDir, { maxAge: '1h', acceptRanges: true }));
  app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));
  app.get('/v', (req, res) => res.redirect('/vote/'));

  app.get('/api/info', (req, res) => {
    const addr = server.address();
    res.json({
      port: addr.port,
      lan: lanAddresses().map((ip) => `http://${ip}:${addr.port}`),
      pinRequired: !!pin,
      converter: !!findSoffice(),
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
        processMedia(media, f.path, mediaDir, () => store.emit());
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

  app.get('/api/export', (req, res) => {
    if (!authorized(req)) return res.status(401).end();
    res.attachment(`${store.state.show.name || 'show'}.presentor.json`).json(store.state);
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
    const msg = JSON.stringify({ t: 'state', state: controlState() });
    for (const c of clients) if (c.role !== 'audience' && c.ws.readyState === 1) c.ws.send(msg);
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
    if (!['control', 'output', 'audience'].includes(role)) role = 'audience';
    if (role !== 'audience' && pin && q.get('pin') !== pin) {
      ws.send(JSON.stringify({ t: 'auth', error: 'PIN incorrect' }));
      return ws.close(4001, 'pin');
    }
    const client = { ws, role, outputId: q.get('output') || null };
    clients.add(client);
    ws.send(JSON.stringify({ t: 'hello', role, serverNow: Date.now() }));
    if (role === 'audience') ws.send(JSON.stringify({ t: 'public', state: store.publicState() }));
    broadcast(); // envoie l'état complet + met à jour les compteurs de connexion

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.t === 'ping') return ws.send(JSON.stringify({ t: 'pong', c: msg.c, s: Date.now() }));
      if (msg.t === 'action' && msg.action) {
        let result;
        try { result = store.dispatch(msg.action, role); } catch (e) { result = { error: e.message }; }
        // L'état à jour part avant l'accusé : l'émetteur le voit dès la réponse.
        if (role !== 'audience' && fullTimer) { clearTimeout(fullTimer); flushFull(); }
        if (msg.id) ws.send(JSON.stringify({ t: 'ack', id: msg.id, result }));
      }
    });
    ws.on('close', () => { clients.delete(client); broadcast(); });
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
