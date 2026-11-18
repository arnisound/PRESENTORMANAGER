// Import des médias : détection du type, conversion PowerPoint/Keynote → PDF
// (via LibreOffice), comptage des pages et extraction des notes du présentateur.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import AdmZip from 'adm-zip';

const KINDS = {
  slides: ['pdf'],
  office: ['pptx', 'ppt', 'pps', 'ppsx', 'odp', 'key'],
  video: ['mp4', 'webm', 'mov', 'm4v', 'mkv', 'ogv'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp'],
  audio: ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'],
};

export function kindOf(filename) {
  const ext = path.extname(filename).slice(1).toLowerCase();
  for (const [k, list] of Object.entries(KINDS)) if (list.includes(ext)) return k;
  return null;
}

export function findSoffice() {
  const candidates = [
    process.env.SOFFICE_PATH,
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
    'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
    '/usr/bin/soffice',
    '/usr/local/bin/soffice',
    '/opt/homebrew/bin/soffice',
    '/snap/bin/libreoffice',
  ].filter(Boolean);
  return candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}

// Une seule conversion à la fois : LibreOffice n'aime pas les instances parallèles.
let queue = Promise.resolve();
export function convertToPdf(input, outDir) {
  const run = () => new Promise((resolve, reject) => {
    const soffice = findSoffice();
    if (!soffice) return reject(new Error('LibreOffice introuvable : installez-le, ou exportez la présentation en PDF.'));
    const profile = 'file://' + path.join(os.tmpdir(), 'presentor-lo-profile').replace(/\\/g, '/');
    execFile(soffice, [`-env:UserInstallation=${profile}`, '--headless', '--convert-to', 'pdf', '--outdir', outDir, input],
      { timeout: 180000 }, (err) => {
        const out = path.join(outDir, path.basename(input).replace(/\.[^.]+$/, '.pdf'));
        if (fs.existsSync(out)) resolve(out);
        else reject(err || new Error('Conversion échouée'));
      });
  });
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

let pdfjsPromise;
export async function pdfPageCount(file) {
  pdfjsPromise ||= import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdfjs = await pdfjsPromise;
  const data = new Uint8Array(fs.readFileSync(file));
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: false, verbosity: 0 }).promise;
  const n = doc.numPages;
  await doc.destroy();
  return n;
}

// Notes du présentateur d'un .pptx, dans l'ordre réel des diapositives.
export function pptxNotes(file) {
  try {
    const zip = new AdmZip(file);
    const read = (p) => zip.getEntry(p)?.getData().toString('utf8') || '';
    const rels = (p) => {
      const dir = path.posix.dirname(p);
      const relFile = path.posix.join(dir, '_rels', path.posix.basename(p) + '.rels');
      const map = {};
      for (const m of read(relFile).matchAll(/<Relationship\b[^>]*>/g)) {
        const id = /Id="([^"]+)"/.exec(m[0])?.[1];
        const target = /Target="([^"]+)"/.exec(m[0])?.[1];
        const type = /Type="([^"]+)"/.exec(m[0])?.[1] || '';
        if (id && target) map[id] = { target: path.posix.normalize(path.posix.join(dir, target)), type };
      }
      return map;
    };
    const presRels = rels('ppt/presentation.xml');
    const ids = [...read('ppt/presentation.xml').matchAll(/<p:sldId\b[^>]*r:id="([^"]+)"/g)].map((m) => m[1]);
    return ids.map((rid) => {
      const slide = presRels[rid]?.target;
      if (!slide) return '';
      const noteRel = Object.values(rels(slide)).find((r) => r.type.endsWith('/notesSlide'));
      if (!noteRel) return '';
      const xml = read(noteRel.target);
      // Ne garder que le corps des notes (pas le numéro de diapo ni la miniature).
      const shapes = xml.split('</p:sp>').filter((sp) => /type="body"/.test(sp));
      return shapes.map((sp) => sp.split('</a:p>').map((para) =>
        [...para.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => decode(m[1])).join('')).join('\n')).join('\n').trim();
    });
  } catch {
    return [];
  }
}

function decode(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

// Traite un fichier fraîchement uploadé. Met à jour l'objet media au fil de l'eau.
export async function processMedia(media, filePath, mediaDir, onUpdate) {
  const kind = kindOf(media.name);
  try {
    if (kind === 'office') {
      media.kind = 'slides';
      media.status = 'converting';
      onUpdate();
      if (/\.pptx$/i.test(media.name)) media.notes = pptxNotes(filePath);
      const work = fs.mkdtempSync(path.join(os.tmpdir(), 'presentor-'));
      const src = path.join(work, 'source' + path.extname(media.name).toLowerCase());
      fs.copyFileSync(filePath, src);
      const pdf = await convertToPdf(src, work);
      const finalName = media.id + '.pdf';
      fs.copyFileSync(pdf, path.join(mediaDir, finalName));
      fs.rmSync(work, { recursive: true, force: true });
      media.source = media.file; // garde l'original pour ré-export éventuel
      media.file = finalName;
      media.pages = await pdfPageCount(path.join(mediaDir, finalName));
    } else if (kind === 'slides') {
      media.kind = 'slides';
      media.pages = await pdfPageCount(filePath);
    } else {
      media.kind = kind;
    }
    media.status = 'ready';
  } catch (e) {
    media.status = 'error';
    media.error = e.message;
  }
  onUpdate();
}
