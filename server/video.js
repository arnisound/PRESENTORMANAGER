// Préparation des vidéos avec ffmpeg (fourni avec l'app) :
//  - analyse (résolution, codec, durée) ;
//  - vignette calculée une fois (la régie ne décode plus les fichiers 4K) ;
//  - « proxy » léger pour les écrans de contrôle (régie, aperçus, retour présentateur) ;
//  - optimisation à la demande : réencodage H.264 lisible partout et fluide.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let ffmpegPath;
export function ffmpeg() {
  if (ffmpegPath !== undefined) return ffmpegPath;
  try {
    // Dans l'app packagée, le binaire est à côté du module (pas dans une archive).
    ffmpegPath = require('ffmpeg-static');
    if (ffmpegPath && !fs.existsSync(ffmpegPath)) ffmpegPath = null;
  } catch { ffmpegPath = null; }
  return ffmpegPath;
}

function run(args, onProgress) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg(), ['-hide_banner', '-nostdin', ...args], { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => {
      const t = String(d);
      err = (err + t).slice(-20000);
      const m = /time=(\d+):(\d+):(\d+\.\d+)/.exec(t);
      if (m && onProgress) onProgress(+m[1] * 3600 + +m[2] * 60 + +m[3]);
    });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(err) : reject(new Error(err.split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 300) || 'ffmpeg a échoué'))));
  });
}

export async function probe(file) {
  let out = '';
  try { await run(['-i', file]); } catch (e) { out = e.message; }
  // ffmpeg -i sans sortie « échoue » toujours : on lit la description dans le message.
  if (!out) return {};
  return parseProbe(out);
}
export function parseProbe(text) {
  const info = {};
  const d = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(text);
  if (d) info.duration = +d[1] * 3600 + +d[2] * 60 + +d[3];
  const v = /Stream #[^\n]*Video: ([a-z0-9_]+)[^\n]*?, (\d{2,5})x(\d{2,5})/.exec(text);
  if (v) { info.codec = v[1]; info.width = +v[2]; info.height = +v[3]; }
  const f = /(\d+(?:\.\d+)?) fps/.exec(text);
  if (f) info.fps = +f[1];
  return info;
}

export async function probeFull(file) {
  // Variante fiable : on demande une sortie vide pour récupérer la description complète.
  try { return parseProbe(await run(['-i', file, '-t', '0', '-f', 'null', '-'])); } catch (e) { return parseProbe(e.message); }
}

// Lisible sans souci par le moteur Chromium de l'app (décodage matériel le plus courant).
const SAFE = new Set(['h264', 'vp8', 'vp9', 'av1']);

export async function prepareVideo(media, filePath, mediaDir, onUpdate) {
  if (!ffmpeg()) return;
  const info = await probeFull(filePath);
  Object.assign(media, { width: info.width, height: info.height, codec: info.codec, duration: info.duration, fps: info.fps });
  media.heavy = (info.width || 0) * (info.height || 0) > 1920 * 1080 * 1.1 || (info.fps || 0) > 50;
  media.needsOptimize = !!info.codec && !SAFE.has(info.codec);
  onUpdate();
  const base = media.id;
  // Vignette (image à ~1 s).
  try {
    const thumb = base + '_thumb.jpg';
    await run(['-y', '-ss', String(Math.min(1, (info.duration || 2) / 3)), '-i', filePath, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '5', path.join(mediaDir, thumb)]);
    media.thumb = thumb;
    onUpdate();
  } catch { /* pas de vignette : la régie affichera une icône */ }
  // Proxy pour les écrans de contrôle si la vidéo est lourde ou dans un format délicat.
  if (media.heavy || media.needsOptimize) {
    try {
      const proxy = base + '_proxy.mp4';
      media.proxyStatus = 'en cours';
      onUpdate();
      await run(['-y', '-i', filePath, '-vf', 'scale=-2:360', '-r', '25', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', path.join(mediaDir, proxy)]);
      media.proxy = proxy;
      media.proxyStatus = null;
    } catch { media.proxyStatus = null; }
    onUpdate();
  }
}

// Réencodage complet (H.264, résolution conservée jusqu'à la 4K) : lecture fluide et fiable.
const jobs = new Map();
export async function optimizeVideo(media, mediaDir, onUpdate, { maxHeight = 2160 } = {}) {
  if (!ffmpeg()) throw new Error('ffmpeg indisponible');
  if (jobs.has(media.id)) return;
  const src = path.join(mediaDir, media.original || media.file);
  const out = media.id + '_opt.mp4';
  const h = Math.min(maxHeight, media.height || maxHeight);
  media.optimize = { progress: 0 };
  onUpdate();
  const job = run(['-y', '-i', src, '-vf', `scale=-2:'min(${h},ih)'`, '-c:v', 'libx264', '-preset', 'faster', '-crf', '19', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', path.join(mediaDir, out)], (t) => {
    const p = media.duration ? Math.min(99, Math.round((t / media.duration) * 100)) : 0;
    if (p !== media.optimize?.progress) { media.optimize = { progress: p }; onUpdate(); }
  });
  jobs.set(media.id, job);
  try {
    await job;
    media.original ||= media.file;
    media.file = out;
    media.codec = 'h264';
    media.needsOptimize = false;
    media.optimize = null;
  } catch (e) {
    media.optimize = { error: e.message };
  } finally {
    jobs.delete(media.id);
    onUpdate();
  }
}
