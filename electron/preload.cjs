// Pont sécurisé entre les pages et l'application desktop.
const { contextBridge, ipcRenderer } = require('electron');

let grandiose = null;
try { grandiose = require('@stagetimerio/grandiose'); } catch { /* NDI non installé */ }

// --------------------------------------------------------------- réception NDI
// Le module natif tourne ici (monde isolé du preload) et dessine directement
// dans le canvas de la page : aucune image ne transite par le pont.
const receivers = new Map();
let nextHandle = 1;

function glFor(canvas) {
  const gl = canvas.getContext('webgl', { alpha: false, antialias: false, preserveDrawingBuffer: false });
  if (!gl) return null; // pas d'accélération graphique : repli en 2D
  const vs = 'attribute vec2 p; varying vec2 uv; void main(){ uv = vec2((p.x+1.0)/2.0, (1.0-p.y)/2.0); gl_Position = vec4(p,0.0,1.0); }';
  const fs = 'precision mediump float; varying vec2 uv; uniform sampler2D t; void main(){ gl_FragColor = vec4(texture2D(t, uv).rgb, 1.0); }';
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, vs));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(prog);
  gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
  for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
  return gl;
}

async function receiveLoop(r) {
  const g = grandiose;
  try {
    r.rx = await g.receive({
      source: r.source,
      colorFormat: g.COLOR_FORMAT_RGBX_RGBA,
      bandwidth: r.low ? g.BANDWIDTH_LOWEST : g.BANDWIDTH_HIGHEST,
      allowVideoFields: false,
      name: 'Presentor',
    });
  } catch (e) { r.error = e.message; return; }
  while (r.alive) {
    let f;
    try { f = await r.rx.data({ audioFormat: g.AUDIO_FORMAT_FLOAT_32_SEPARATE }, 1000); } catch { continue; }
    if (!r.alive) break;
    if (f.type === 'video') drawVideo(r, f);
    else if (f.type === 'audio' && r.audio) playAudio(r, f);
  }
}

function drawVideo(r, f) {
  const canvas = document.getElementById(r.canvasId);
  if (!canvas) return;
  if (r.glCanvas !== canvas) { r.gl = glFor(canvas); r.ctx2d = r.gl ? null : canvas.getContext('2d'); r.glCanvas = canvas; }
  if (canvas.width !== f.xres || canvas.height !== f.yres) { canvas.width = f.xres; canvas.height = f.yres; }
  if (!r.gl) return draw2d(r, f);
  const gl = r.gl;
  gl.viewport(0, 0, f.xres, f.yres);
  const rowPx = f.lineStrideBytes / 4;
  const px = new Uint8Array(f.data.buffer, f.data.byteOffset, f.lineStrideBytes * f.yres);
  // Lignes avec bourrage : on envoie la largeur réelle de ligne puis on rogne via les UV.
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, rowPx, f.yres, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  r.frames++;
  if (r.onFirst) { r.onFirst(); r.onFirst = null; }
}

function draw2d(r, f) {
  const len = f.xres * f.yres * 4;
  let px;
  if (f.lineStrideBytes === f.xres * 4) px = new Uint8ClampedArray(f.data.buffer, f.data.byteOffset, len);
  else {
    px = new Uint8ClampedArray(len);
    for (let y = 0; y < f.yres; y++) px.set(new Uint8Array(f.data.buffer, f.data.byteOffset + y * f.lineStrideBytes, f.xres * 4), y * f.xres * 4);
  }
  // En RGBX l'octet X n'est pas garanti opaque : on force l'alpha si besoin.
  if (px[3] !== 255) { if (px.buffer === f.data.buffer) px = new Uint8ClampedArray(px); for (let i = 3; i < len; i += 4) px[i] = 255; }
  r.ctx2d.putImageData(new ImageData(px, f.xres, f.yres), 0, 0);
  r.frames++;
  if (r.onFirst) { r.onFirst(); r.onFirst = null; }
}

function playAudio(r, f) {
  if (!r.ctx) { r.ctx = new AudioContext({ latencyHint: 'interactive' }); r.t = 0; }
  const ctx = r.ctx;
  const buf = ctx.createBuffer(f.channels, f.samples, f.sampleRate);
  for (let c = 0; c < f.channels; c++) {
    buf.copyToChannel(new Float32Array(f.data.buffer, f.data.byteOffset + c * f.channelStrideInBytes, f.samples), c);
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  // Petite avance (80 ms) pour absorber la gigue réseau ; resynchronise si on décroche.
  if (r.t < ctx.currentTime || r.t > ctx.currentTime + 0.5) r.t = ctx.currentTime + 0.08;
  src.start(r.t);
  r.t += buf.duration;
}

const ndi = grandiose ? {
  attach(canvasId, source, opts = {}) {
    const handle = nextHandle++;
    const r = { canvasId, source: { name: source.name, ...(source.urlAddress ? { urlAddress: source.urlAddress } : {}) }, low: !!opts.low, audio: !!opts.audio, alive: true, frames: 0 };
    receivers.set(handle, r);
    receiveLoop(r);
    return handle;
  },
  firstFrame(handle, timeout = 3000) {
    const r = receivers.get(handle);
    if (!r || r.frames) return Promise.resolve(!!r);
    return new Promise((res) => { r.onFirst = () => res(true); setTimeout(() => res(false), timeout); });
  },
  detach(handle) {
    const r = receivers.get(handle);
    if (!r) return;
    r.alive = false;
    receivers.delete(handle);
    r.ctx?.close();
    r.rx = null; // le récepteur natif est libéré par le ramasse-miettes
  },
  stats: () => [...receivers.values()].map((r) => ({ source: r.source.name, frames: r.frames, error: r.error })),
} : null;

contextBridge.exposeInMainWorld('presentor', {
  isDesktop: true,
  platform: process.platform,
  ndi,
  listDisplays: () => ipcRenderer.invoke('displays:list'),
  openOutput: (id, displayId) => ipcRenderer.invoke('output:open', id, displayId),
  closeOutput: (id) => ipcRenderer.invoke('output:close', id),
  identifyDisplays: () => ipcRenderer.invoke('displays:identify'),
  onDisplaysChanged: (fn) => ipcRenderer.on('displays:changed', (e, list) => fn(list)),
});
