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

// Lecture d'un .pptx : diapositives dans l'ordre réel du diaporama.
function openPptx(file) {
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
      const external = /TargetMode="External"/.test(m[0]);
      if (id && target) map[id] = { target: external ? target : path.posix.normalize(path.posix.join(dir, target)), type, external };
    }
    return map;
  };
  const presXml = read('ppt/presentation.xml');
  const presRels = rels('ppt/presentation.xml');
  const slides = [...presXml.matchAll(/<p:sldId\b[^>]*r:id="([^"]+)"/g)].map((m) => presRels[m[1]]?.target).filter(Boolean);
  const size = /<p:sldSz[^>]*cx="(\d+)"[^>]*cy="(\d+)"/.exec(presXml);
  return { zip, read, rels, slides, cx: size ? +size[1] : 12192000, cy: size ? +size[2] : 6858000 };
}

// Notes du présentateur d'un .pptx, dans l'ordre réel des diapositives.
export function pptxNotes(file) {
  try {
    const { read, rels, slides } = openPptx(file);
    return slides.map((slide) => {
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

// Vidéos et sons intégrés : extraits du .pptx avec leur position sur la diapo,
// pour être rejoués par-dessus l'image de la diapositive.
export function pptxMedia(file, mediaDir, mediaId) {
  const out = [];
  try {
    const { zip, read, rels, slides, cx, cy } = openPptx(file);
    slides.forEach((slide, si) => {
      const xml = read(slide);
      const r = rels(slide);
      for (const m of xml.matchAll(/<p:pic>([\s\S]*?)<\/p:pic>/g)) {
        const pic = m[1];
        const isVideo = /<a:videoFile\b/.test(pic), isAudio = /<a:audioFile\b/.test(pic);
        if (!isVideo && !isAudio) continue;
        const embedId = /<p14:media\b[^>]*r:embed="([^"]+)"/.exec(pic)?.[1];
        const linkId = /<a:(?:video|audio)File\b[^>]*r:link="([^"]+)"/.exec(pic)?.[1];
        const rel = r[embedId] || r[linkId];
        if (!rel || rel.external) continue; // les médias liés à l'extérieur ne sont pas dans le fichier
        const entry = zip.getEntry(rel.target);
        if (!entry) continue;
        const spid = /<p:cNvPr\b[^>]*\bid="(\d+)"/.exec(pic)?.[1];
        const off = /<a:off x="(-?\d+)" y="(-?\d+)"/.exec(pic);
        const ext = /<a:ext cx="(\d+)" cy="(\d+)"/.exec(pic);
        // Réglages de lecture dans la chronologie de la diapo (volume, muet, boucle).
        const node = [...xml.matchAll(/<p:cMediaNode\b([^>]*)>([\s\S]*?)<\/p:cMediaNode>/g)].find((n) => n[2].includes(`spid="${spid}"`));
        const vol = node && /vol="(\d+)"/.exec(node[1]);
        const name = `${mediaId}_s${si + 1}_${out.length + 1}${path.extname(rel.target).toLowerCase() || '.mp4'}`;
        fs.writeFileSync(path.join(mediaDir, name), entry.getData());
        out.push({
          slide: si + 1,
          kind: isVideo ? 'video' : 'audio',
          file: name,
          x: off ? +off[1] / cx : 0, y: off ? +off[2] / cy : 0,
          w: ext ? +ext[1] / cx : 1, h: ext ? +ext[2] / cy : 1,
          volume: vol ? Math.min(1, +vol[1] / 100000) : 1,
          muted: !!(node && /mute="1"/.test(node[1])),
          loop: !!(node && /repeatCount="indefinite"/.test(node[2])),
        });
      }
    });
  } catch { /* fichier inhabituel : on garde au moins les images */ }
  return out;
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
      if (/\.(pptx|ppsx)$/i.test(media.name)) {
        media.notes = pptxNotes(filePath);
        media.videos = pptxMedia(filePath, mediaDir, media.id);
      }
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
