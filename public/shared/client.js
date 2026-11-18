// Connexion temps réel au serveur : reconnexion automatique, horloge synchronisée,
// actions avec accusé de réception. Partagé par toutes les pages.

const PIN_KEY = 'presenthor.pin';

export function getPin() {
  try { return new URLSearchParams(location.search).get('pin') || localStorage.getItem(PIN_KEY) || ''; } catch { return ''; }
}
function setPin(p) { try { localStorage.setItem(PIN_KEY, p); } catch {} }

export class Client {
  constructor({ role, output = null, onState, onPublic, onStatus, onRtc, query = {} } = {}) {
    Object.assign(this, { role, output, onState, onPublic, onStatus, onRtc, query });
    this.rtcHandlers = new Set();
    this.offset = 0; // horloge serveur - horloge locale
    this.bestRtt = Infinity;
    this.pending = new Map();
    this.seq = 0;
    this.state = null;
    this.retry = 0;
    this.connect();
    setInterval(() => this.ping(), 5000);
  }

  now() { return Date.now() + this.offset; }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const q = new URLSearchParams({ role: this.role });
    if (this.output) q.set('output', this.output);
    for (const [k, v] of Object.entries(this.query || {})) if (v != null) q.set(k, v);
    const pin = getPin();
    if (pin) q.set('pin', pin);
    const ws = (this.ws = new WebSocket(`${proto}://${location.host}/ws?${q}`));
    ws.onopen = () => { this.retry = 0; this.status('online'); for (let i = 0; i < 4; i++) setTimeout(() => this.ping(), i * 300); };
    ws.onmessage = (e) => this.receive(JSON.parse(e.data));
    ws.onclose = (e) => {
      this.status('offline');
      if (e.code === 4003 || e.code === 4004) { this.onStatus?.(e.code === 4003 ? 'refused' : 'replaced'); return; }
      if (e.code === 4001) {
        const p = prompt('Code PIN de la régie :');
        if (p != null) setPin(p);
      }
      setTimeout(() => this.connect(), Math.min(5000, 300 * 2 ** this.retry++));
    };
  }

  status(s) { this.connected = s === 'online'; this.onStatus?.(s); }

  receive(m) {
    if (m.t === 'pong') {
      const rtt = Date.now() - m.c;
      // On garde la mesure au plus faible aller-retour : la plus précise.
      if (rtt <= this.bestRtt * 1.5) {
        this.bestRtt = Math.min(this.bestRtt, rtt);
        this.offset = m.s - (m.c + rtt / 2);
      }
    } else if (m.t === 'rtc') {
      this.onRtc?.(m);
      for (const h of this.rtcHandlers) h(m);
    } else if (m.t === 'hello') {
      this.cid = m.cid;
      if (this.bestRtt === Infinity) this.offset = m.serverNow - Date.now();
    } else if (m.t === 'state') {
      this.state = m.state;
      this.onState?.(m.state);
    } else if (m.t === 'public') {
      this.onPublic?.(m.state);
    } else if (m.t === 'ack') {
      this.pending.get(m.id)?.(m.result);
      this.pending.delete(m.id);
    }
  }

  ping() { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ t: 'ping', c: Date.now() })); }

  // Message de signalisation WebRTC vers une autre connexion (invité, écran, régie).
  rtc(to, data) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ t: 'rtc', to, data })); }
  raw(msg) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg)); }

  send(action) {
    return new Promise((resolve) => {
      if (this.ws?.readyState !== 1) return resolve({ error: 'hors ligne' });
      const id = ++this.seq;
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ t: 'action', id, action }));
    });
  }
}

// Touches émises par les télécommandes de présentation (Logitech, Kensington,
// Targus…) : elles se comportent comme un clavier.
export function bindClicker(client, { allowBlackout = true } = {}) {
  window.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    let type = null;
    const st = client.state?.settings || {};
    if (['PageDown', 'ArrowRight', 'ArrowDown', 'MediaTrackNext'].includes(e.key) || (e.key === ' ' && st.spaceNext)) type = 'next';
    else if (['PageUp', 'ArrowLeft', 'ArrowUp', 'MediaTrackPrevious'].includes(e.key)) type = 'prev';
    else if (allowBlackout && st.blackoutKey !== false && ['b', 'B', '.', ','].includes(e.key)) type = 'blackout.toggle';
    if (!type) return;
    e.preventDefault();
    if (!e.repeat) client.send({ type });
  });
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function fmtTime(ms, withSign = false) {
  const neg = ms < 0;
  let s = Math.floor(Math.abs(ms) / 1000);
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  const pad = (n) => String(n).padStart(2, '0');
  return (neg && withSign ? '-' : '') + (h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`);
}

// Le chrono est-il affiché à cet endroit ? (where : 'Regie' | 'Presenter' | 'Remote')
export function timerVisible(state, where) {
  const s = state?.settings || {}, t = state?.timer || {};
  if (s['timerOn' + where] === false) return false;
  const mode = s.timerShow || 'running';
  if (mode === 'never') return false;
  if (mode === 'running') return !!(t.running || t.elapsed > 0);
  return true;
}

export function timerValue(timer, now) {
  const elapsed = timer.elapsed + (timer.running ? now - timer.startedAt : 0);
  return timer.mode === 'down' ? timer.duration - elapsed : elapsed;
}
