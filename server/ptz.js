// Pilotage des caméras PTZ (pan, tilt, zoom, mise au point, préréglages).
// Deux voies :
//  - NDI : commandes PTZ envoyées dans la liaison NDI elle-même (caméras NDI|HX,
//    BirdDog, PTZOptics, Panasonic, Avonic…), via la bibliothèque NDI déjà fournie ;
//  - VISCA sur IP : protocole standard des caméras PTZ (UDP Sony 52381, UDP 1259,
//    TCP 5678), utile quand la caméra n'expose pas le PTZ en NDI.
// Sécurité : un mouvement continu s'arrête tout seul si la régie ne le confirme
// plus (réseau coupé, tablette en veille).
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import dgram from 'node:dgram';
import net from 'node:net';

const require = createRequire(import.meta.url);
const clamp = (v, a, b) => Math.max(a, Math.min(b, Number.isFinite(+v) ? +v : 0));
const WATCHDOG_MS = 900;

// ---------------------------------------------------------------- NDI
let NDI;
function ndiLib() {
  if (NDI !== undefined) return NDI;
  NDI = null;
  try {
    const koffi = require('koffi');
    const names = { win32: 'Processing.NDI.Lib.x64.dll', darwin: 'libndi.dylib', linux: 'libndi.so.6' };
    const file = names[process.platform];
    const candidates = [];
    try {
      const pkg = path.dirname(require.resolve('@stagetimerio/grandiose/package.json'));
      candidates.push(path.join(pkg, 'build', 'Release', file));
    } catch {}
    if (process.env.NDI_RUNTIME_DIR_V6) candidates.push(path.join(process.env.NDI_RUNTIME_DIR_V6, file));
    if (process.platform === 'darwin') candidates.push('/usr/local/lib/libndi.dylib', '/Library/NDI SDK for Apple/lib/macOS/libndi.dylib');
    const libPath = candidates.map((p) => p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')).find((p) => fs.existsSync(p)) || candidates[0];
    const lib = koffi.load(libPath);
    koffi.struct('PTZ_NDIlib_source_t', { p_ndi_name: 'const char *', p_url_address: 'const char *' });
    koffi.struct('PTZ_NDIlib_recv_create_v3_t', {
      source_to_connect_to: 'PTZ_NDIlib_source_t', color_format: 'int', bandwidth: 'int', allow_video_fields: 'bool', p_ndi_recv_name: 'const char *',
    });
    koffi.struct('PTZ_NDIlib_metadata_frame_t', { length: 'int', timecode: 'int64', p_data: 'void *' });
    const f = (ret, name, args) => lib.func(name, ret, args);
    const P = 'void *';
    NDI = {
      initialize: f('bool', 'NDIlib_initialize', []),
      create: f(P, 'NDIlib_recv_create_v3', ['PTZ_NDIlib_recv_create_v3_t *']),
      destroy: f('void', 'NDIlib_recv_destroy', [P]),
      capture: f('int', 'NDIlib_recv_capture_v2', [P, P, P, koffi.out('PTZ_NDIlib_metadata_frame_t *'), 'uint32']),
      freeMeta: f('void', 'NDIlib_recv_free_metadata', [P, 'PTZ_NDIlib_metadata_frame_t *']),
      connections: f('int', 'NDIlib_recv_get_no_connections', [P]),
      supported: f('bool', 'NDIlib_recv_ptz_is_supported', [P]),
      zoom: f('bool', 'NDIlib_recv_ptz_zoom', [P, 'float']),
      zoomSpeed: f('bool', 'NDIlib_recv_ptz_zoom_speed', [P, 'float']),
      panTilt: f('bool', 'NDIlib_recv_ptz_pan_tilt', [P, 'float', 'float']),
      panTiltSpeed: f('bool', 'NDIlib_recv_ptz_pan_tilt_speed', [P, 'float', 'float']),
      store: f('bool', 'NDIlib_recv_ptz_store_preset', [P, 'int']),
      recall: f('bool', 'NDIlib_recv_ptz_recall_preset', [P, 'int', 'float']),
      autoFocus: f('bool', 'NDIlib_recv_ptz_auto_focus', [P]),
      focusSpeed: f('bool', 'NDIlib_recv_ptz_focus_speed', [P, 'float']),
      wbAuto: f('bool', 'NDIlib_recv_ptz_white_balance_auto', [P]),
      expAuto: f('bool', 'NDIlib_recv_ptz_exposure_auto', [P]),
    };
    if (!NDI.initialize()) NDI = null;
  } catch { NDI = null; }
  return NDI;
}

// Une liaison « métadonnées seulement » par caméra : ne consomme pas d'image.
class NdiPtz {
  constructor(source) {
    const L = ndiLib();
    if (!L) throw new Error('NDI indisponible');
    this.L = L;
    this.name = source.name;
    this.recv = L.create({
      source_to_connect_to: { p_ndi_name: source.name, p_url_address: source.urlAddress || null },
      color_format: 0, bandwidth: -10, allow_video_fields: false, p_ndi_recv_name: 'PresenThor PTZ',
    });
    if (!this.recv) throw new Error('liaison NDI impossible');
    // Vide régulièrement la file des métadonnées reçues (sinon elle grossit).
    this.pump = setInterval(() => {
      try {
        for (let i = 0; i < 20; i++) {
          const m = {};
          const t = L.capture(this.recv, null, null, m, 0);
          if (t !== 3) break; // 3 = métadonnées
          L.freeMeta(this.recv, m);
        }
      } catch {}
    }, 250);
  }
  status() {
    const connected = this.L.connections(this.recv) > 0;
    return { via: 'ndi', connected, supported: connected && this.L.supported(this.recv) };
  }
  move(pan, tilt) { this.L.panTiltSpeed(this.recv, pan, tilt); }
  zoom(speed) { this.L.zoomSpeed(this.recv, speed); }
  focus(speed) { this.L.focusSpeed(this.recv, speed); }
  autoFocus() { this.L.autoFocus(this.recv); }
  home() { this.L.panTilt(this.recv, 0, 0); }
  recall(i, speed) { this.L.recall(this.recv, i, speed); }
  storePreset(i) { this.L.store(this.recv, i); }
  auto() { this.L.wbAuto(this.recv); this.L.expAuto(this.recv); }
  stop() { this.move(0, 0); this.zoom(0); this.focus(0); }
  destroy() { clearInterval(this.pump); try { this.L.destroy(this.recv); } catch {} }
}

// ---------------------------------------------------------------- VISCA sur IP
export const visca = {
  // Vitesses : pan 1..0x18, tilt 1..0x14, zoom / focus 0..7.
  move(pan, tilt) {
    const ps = Math.max(1, Math.round(Math.abs(pan) * 0x18)), ts = Math.max(1, Math.round(Math.abs(tilt) * 0x14));
    const x = pan < -0.02 ? 1 : pan > 0.02 ? 2 : 3;
    const y = tilt > 0.02 ? 1 : tilt < -0.02 ? 2 : 3; // tilt > 0 = vers le haut
    return [0x81, 0x01, 0x06, 0x01, ps, ts, x, y, 0xff];
  },
  zoom(s) { const p = Math.min(7, Math.round(Math.abs(s) * 7)); return [0x81, 0x01, 0x04, 0x07, s > 0.02 ? 0x20 | p : s < -0.02 ? 0x30 | p : 0x00, 0xff]; },
  focus(s) { const p = Math.min(7, Math.round(Math.abs(s) * 7)); return [0x81, 0x01, 0x04, 0x08, s > 0.02 ? 0x20 | p : s < -0.02 ? 0x30 | p : 0x00, 0xff]; },
  autoFocus: () => [0x81, 0x01, 0x04, 0x38, 0x02, 0xff],
  home: () => [0x81, 0x01, 0x06, 0x04, 0xff],
  recall: (i) => [0x81, 0x01, 0x04, 0x3f, 0x02, i & 0x7f, 0xff],
  store: (i) => [0x81, 0x01, 0x04, 0x3f, 0x01, i & 0x7f, 0xff],
  wbAuto: () => [0x81, 0x01, 0x04, 0x35, 0x00, 0xff],
  expAuto: () => [0x81, 0x01, 0x04, 0x39, 0x00, 0xff],
};

class ViscaPtz {
  constructor({ host, port, protocol }) {
    this.host = host;
    this.protocol = protocol || 'sony';
    this.port = +port || (this.protocol === 'sony' ? 52381 : this.protocol === 'tcp' ? 5678 : 1259);
    this.seq = 0;
    this.lastOk = 0;
    if (this.protocol === 'tcp') this.connectTcp();
    else {
      this.sock = dgram.createSocket('udp4');
      this.sock.on('message', () => { this.lastOk = Date.now(); });
      this.sock.on('error', () => {});
      if (this.protocol === 'sony') this.raw(Buffer.from([0x02, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0x01]), true); // remise à zéro du compteur
    }
  }
  connectTcp() {
    this.tcp?.destroy();
    this.tcp = net.connect(this.port, this.host);
    this.tcp.setNoDelay(true);
    this.tcp.on('data', () => { this.lastOk = Date.now(); });
    this.tcp.on('error', () => {});
    this.tcp.on('close', () => { this.tcp = null; });
  }
  raw(buf, control = false) {
    if (this.protocol === 'sony') {
      const h = Buffer.alloc(8);
      h.writeUInt16BE(control ? 0x0200 : 0x0100, 0);
      h.writeUInt16BE(buf.length, 2);
      h.writeUInt32BE(control ? 0 : ++this.seq >>> 0, 4);
      this.sock.send(Buffer.concat([h, buf]), this.port, this.host);
    } else if (this.protocol === 'tcp') {
      if (!this.tcp) this.connectTcp();
      this.tcp.write(buf);
    } else this.sock.send(buf, this.port, this.host);
  }
  send(bytes) { this.raw(Buffer.from(bytes)); }
  status() { return { via: 'visca', connected: Date.now() - this.lastOk < 10000, supported: true, host: this.host, port: this.port }; }
  move(p, t) { this.send(visca.move(p, t)); }
  zoom(s) { this.send(visca.zoom(s)); }
  focus(s) { this.send(visca.focus(s)); }
  autoFocus() { this.send(visca.autoFocus()); }
  home() { this.send(visca.home()); }
  recall(i) { this.send(visca.recall(i)); }
  storePreset(i) { this.send(visca.store(i)); }
  auto() { this.send(visca.wbAuto()); this.send(visca.expAuto()); }
  stop() { this.move(0, 0); this.zoom(0); }
  destroy() { try { this.sock?.close(); } catch {} this.tcp?.destroy(); }
}

// ---------------------------------------------------------------- gestion
export class PtzManager {
  constructor() {
    this.cams = new Map(); // clé → { ctl, moving, timer }
  }
  static ndiAvailable() { return !!ndiLib(); }

  // Réglages PTZ d'un clip : voie choisie et adresse.
  keyOf(cue) {
    const p = cue.ptz || {};
    const via = p.via || (cue.type === 'ndi' ? 'ndi' : 'visca');
    if (via === 'visca') return p.host ? `visca:${p.protocol || 'sony'}:${p.host}:${p.port || ''}` : null;
    return cue.source?.name ? `ndi:${cue.source.name}` : null;
  }
  get(cue) {
    const key = this.keyOf(cue);
    if (!key) throw new Error(cue.type === 'ndi' ? 'choisissez la source NDI' : 'indiquez l\'adresse IP de la caméra');
    let c = this.cams.get(key);
    if (!c) {
      const p = cue.ptz || {};
      const ctl = key.startsWith('ndi:') ? new NdiPtz(cue.source) : new ViscaPtz({ host: p.host, port: p.port, protocol: p.protocol });
      c = { ctl, key, lastUse: Date.now() };
      this.cams.set(key, c);
    }
    c.lastUse = Date.now();
    return c;
  }

  // Commande depuis la régie. Les mouvements continus doivent être confirmés
  // (renvoyés) au moins toutes les 900 ms, sinon la caméra s'arrête.
  command(cue, a) {
    const c = this.get(cue);
    const ctl = c.ctl;
    const speed = clamp(a.speed ?? 1, 0.05, 1);
    const arm = () => { clearTimeout(c.dog); c.dog = setTimeout(() => { try { ctl.stop(); } catch {} }, WATCHDOG_MS); };
    switch (a.op) {
      case 'status': return ctl.status();
      case 'move': {
        const pan = clamp(a.pan, -1, 1) * speed, tilt = clamp(a.tilt, -1, 1) * speed;
        ctl.move(cue.ptz?.invertPan ? -pan : pan, cue.ptz?.invertTilt ? -tilt : tilt);
        if (pan || tilt) arm();
        break;
      }
      case 'zoom': ctl.zoom(clamp(a.zoom, -1, 1) * speed); if (a.zoom) arm(); break;
      case 'focus': ctl.focus(clamp(a.focus, -1, 1)); if (a.focus) arm(); break;
      case 'autofocus': ctl.autoFocus(); break;
      case 'auto': ctl.auto(); break;
      case 'home': ctl.home(); break;
      case 'stop': clearTimeout(c.dog); ctl.stop(); break;
      case 'preset.recall': ctl.recall(clamp(a.index, 0, 99) | 0, clamp(a.speed ?? 1, 0.05, 1)); break;
      case 'preset.store': ctl.storePreset(clamp(a.index, 0, 99) | 0); break;
      default: throw new Error('commande PTZ inconnue');
    }
    return { ok: true };
  }

  // Changement d'adresse / de source : l'ancienne liaison est fermée.
  forget(cue) {
    for (const [k, c] of this.cams) if (k !== this.keyOf(cue) && (k.endsWith(cue.source?.name || '\u0000') || k.includes(cue.ptz?.host || '\u0000'))) { c.ctl.destroy(); this.cams.delete(k); }
  }
  destroy() { for (const c of this.cams.values()) { clearTimeout(c.dog); c.ctl.destroy(); } this.cams.clear(); }
}
