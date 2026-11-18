// Publication des sorties en NDI. Une sortie affichée sur un écran est capturée
// telle quelle ; une sortie sans écran est rendue dans une fenêtre virtuelle
// hors écran (NDI pur, ex. pour une régie vidéo ou un enregistreur distant).
const { BrowserWindow } = require('electron');
const path = require('node:path');

let grandiose = null;
try { grandiose = require('@stagetimerio/grandiose'); } catch { /* NDI non installé */ }

const FPS = 30;

class NdiOutputs {
  constructor({ server, getScreenWindow }) {
    this.server = server;
    this.getScreenWindow = getScreenWindow;
    this.active = new Map(); // outputId -> { sender, name, win, offscreen, frame, timer, unsubscribe }
    this.available = !!grandiose;
  }

  // Appelé à chaque changement d'état : démarre / arrête / met à jour les envois.
  async sync() {
    if (!grandiose) return;
    const outs = this.server.store.state.outputs;
    for (const [id, a] of this.active) {
      const o = outs.find((x) => x.id === id);
      if (!o || !o.ndi || this.nameOf(o) !== a.name) await this.stop(id);
    }
    for (const o of outs) {
      if (!o.ndi) continue;
      const a = this.active.get(o.id);
      if (!a) await this.start(o);
      else this.attachSource(a, o); // la fenêtre écran a pu s'ouvrir / se fermer
    }
  }

  nameOf(o) { return (o.ndiName || `PresenThor - ${o.name}`).slice(0, 60); }

  async start(o) {
    const a = { id: o.id, name: this.nameOf(o), frame: null, busy: false, sent: 0 };
    this.active.set(o.id, a);
    try {
      a.sender = await grandiose.send({ name: a.name, clockVideo: false, clockAudio: false });
    } catch (e) {
      this.active.delete(o.id);
      this.report(o.id, 'Erreur NDI : ' + e.message);
      return;
    }
    this.attachSource(a, o);
    // Envoi à cadence fixe (dernière image connue) : les récepteurs NDI préfèrent un flux régulier.
    a.timer = setInterval(() => this.push(a), 1000 / FPS);
    a.status = setInterval(() => {
      const size = a.frame ? `${a.frame.w}×${a.frame.h}` : 'en attente d\'image';
      this.report(o.id, `${a.sender.sourcename?.() || a.name} · ${size} · ${a.sender.connections?.() ?? 0} récepteur(s)`);
    }, 2000);
  }

  attachSource(a, o) {
    const screenWin = this.getScreenWindow(o.id);
    const want = screenWin && !screenWin.isDestroyed() ? screenWin : null;
    if (want && a.win === want) return;
    if (!want && a.offscreen) return;
    this.detachSource(a);
    if (want) {
      a.win = want;
      // Capture des images réellement affichées sur l'écran.
      want.webContents.beginFrameSubscription(false, (image) => this.onImage(a, image));
      a.unsubscribe = () => { if (!want.isDestroyed()) want.webContents.endFrameSubscription(); };
      want.once('closed', () => { a.win = null; setTimeout(() => this.sync(), 50); });
    } else {
      const res = o.ndiResolution || { w: 1920, h: 1080 };
      const win = new BrowserWindow({
        show: false, width: res.w, height: res.h, useContentSize: true, frame: false, enableLargerThanScreen: true,
        webPreferences: { offscreen: true, backgroundThrottling: false, sandbox: false, preload: path.join(__dirname, 'preload.cjs') },
      });
      win.setContentSize(res.w, res.h);
      win.webContents.setFrameRate(FPS);
      win.webContents.on('paint', (e, dirty, image) => this.onImage(a, image));
      win.loadURL(`${this.server.url}/output/?id=${encodeURIComponent(o.id)}`);
      a.offscreen = win;
      a.unsubscribe = () => { if (!win.isDestroyed()) win.destroy(); };
    }
  }

  detachSource(a) {
    a.unsubscribe?.();
    a.unsubscribe = null;
    a.win = null;
    a.offscreen = null;
  }

  onImage(a, image) {
    const { width: w, height: h } = image.getSize();
    if (!w || !h) return;
    a.frame = { w, h, data: image.toBitmap() }; // BGRA
  }

  async push(a) {
    if (!a.frame || a.busy || !a.sender) return;
    a.busy = true;
    const f = a.frame;
    try {
      await a.sender.video({
        xres: f.w, yres: f.h, frameRateN: FPS * 1000, frameRateD: 1000,
        fourCC: grandiose.FOURCC_BGRA, pictureAspectRatio: f.w / f.h,
        frameFormatType: grandiose.FORMAT_TYPE_PROGRESSIVE, lineStrideBytes: f.w * 4, data: f.data,
      });
      a.sent++;
    } catch { /* image ignorée */ }
    a.busy = false;
  }

  report(id, text) {
    const st = this.server.store.state;
    st.ndiOut ||= {};
    if (st.ndiOut[id] === text) return;
    st.ndiOut[id] = text;
    this.server.store.emit('ndi');
  }

  async stop(id) {
    const a = this.active.get(id);
    if (!a) return;
    this.active.delete(id);
    clearInterval(a.timer);
    clearInterval(a.status);
    this.detachSource(a);
    await a.sender?.destroy().catch(() => {});
    const st = this.server.store.state;
    if (st.ndiOut) { delete st.ndiOut[id]; this.server.store.emit('ndi'); }
  }

  async stopAll() { for (const id of [...this.active.keys()]) await this.stop(id); }
}

module.exports = { NdiOutputs };
