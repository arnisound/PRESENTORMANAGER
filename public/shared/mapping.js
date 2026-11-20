// Mathématiques du mapping vidéo : déformation 4 coins (homographie) et masques
// de fondu de bord (edge blending) pour raccorder plusieurs projecteurs.

// Homographie du rectangle W×H vers le quadrilatère p (coins en pixels :
// haut-gauche, haut-droite, bas-droite, bas-gauche), au format CSS matrix3d.
export function quadMatrix(W, H, p) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = p;
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
  let a, b, c, d, e, f, g, h;
  if (Math.abs(dx3) < 1e-9 && Math.abs(dy3) < 1e-9) {
    // Parallélogramme : transformation affine.
    a = x1 - x0; b = x3 - x0; c = x0; d = y1 - y0; e = y3 - y0; f = y0; g = 0; h = 0;
  } else {
    const den = dx1 * dy2 - dx2 * dy1;
    g = (dx3 * dy2 - dx2 * dy3) / den;
    h = (dx1 * dy3 - dx3 * dy1) / den;
    a = x1 - x0 + g * x1; b = x3 - x0 + h * x3; c = x0;
    d = y1 - y0 + g * y1; e = y3 - y0 + h * y3; f = y0;
  }
  const m = [a / W, d / W, 0, g / W, b / H, e / H, 0, h / H, 0, 0, 1, 0, c, f, 0, 1];
  // Forme impossible (3 coins alignés…) : pas de transformation plutôt qu'une image perdue.
  if (!m.every(Number.isFinite)) return null;
  return `matrix3d(${m.map((v) => +v.toPrecision(15)).join(",")})`;
}

// Homographie du carré unité vers un quadrilatère (coins normalisés), et son inverse.
export function homography(p) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = p;
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
  let g = 0, h = 0;
  if (Math.abs(dx3) > 1e-12 || Math.abs(dy3) > 1e-12) {
    const den = dx1 * dy2 - dx2 * dy1;
    g = (dx3 * dy2 - dx2 * dy3) / den;
    h = (dx1 * dy3 - dx3 * dy1) / den;
  }
  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h, 1];
}
export function applyH(H, u, v) {
  const w = H[6] * u + H[7] * v + H[8];
  return [(H[0] * u + H[1] * v + H[2]) / w, (H[3] * u + H[4] * v + H[5]) / w];
}
export function invertH(H) {
  const [a, b, c, d, e, f, g, h, i] = H;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}

// Grille de déformation : décalage interpolé (bilinéaire) en un point (u, v) de la zone.
export function meshOffset(mesh, u, v) {
  const { cols, rows, points } = mesh;
  const fx = Math.max(0, Math.min(cols, u * cols)), fy = Math.max(0, Math.min(rows, v * rows));
  const i = Math.min(cols - 1, Math.floor(fx)), j = Math.min(rows - 1, Math.floor(fy));
  const tx = fx - i, ty = fy - j;
  const P = (a, b) => points[b * (cols + 1) + a] || [0, 0];
  const p00 = P(i, j), p10 = P(i + 1, j), p01 = P(i, j + 1), p11 = P(i + 1, j + 1);
  return [0, 1].map((k) => (p00[k] * (1 - tx) + p10[k] * tx) * (1 - ty) + (p01[k] * (1 - tx) + p11[k] * tx) * ty);
}
export const meshActive = (mesh) => !!mesh?.points?.some((p) => p[0] || p[1]);

// Carte de déplacement pour feDisplacementMap : chaque pixel indique où lire l'image source.
// Renvoie { url, scale } ; scale en pixels de la zone (W × H).
export function meshMap(mesh, W, H) {
  let max = 0;
  for (const [dx, dy] of mesh.points) max = Math.max(max, Math.abs(dx * W), Math.abs(dy * H));
  const scale = Math.max(4, max * 2.2);
  const MW = Math.max(32, mesh.cols * 24), MH = Math.max(18, mesh.rows * 24);
  const c = document.createElement('canvas');
  c.width = MW; c.height = MH;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(MW, MH);
  for (let y = 0; y < MH; y++) for (let x = 0; x < MW; x++) {
    const [dx, dy] = meshOffset(mesh, (x + 0.5) / MW, (y + 0.5) / MH);
    const k = (y * MW + x) * 4;
    // Le pixel affiché en P lit la source en P - décalage : la source « avance » du décalage.
    img.data[k] = Math.round(Math.max(0, Math.min(1, 0.5 - (dx * W) / scale)) * 255);
    img.data[k + 1] = Math.round(Math.max(0, Math.min(1, 0.5 - (dy * H) / scale)) * 255);
    img.data[k + 2] = 128; img.data[k + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return { url: c.toDataURL('image/png'), scale };
}

// Masques de zone en image SVG (opaque = visible) ; adoucissement par flou.
// Par défaut le polygone CACHE ce qu'il recouvre ; « invert » : on ne garde que l'intérieur.
export function masksImages(masks = []) {
  return masks.map((m) => {
    const pts = m.points.map(([x, y]) => `${(x * 1000).toFixed(1)},${(y * 1000).toFixed(1)}`);
    const blur = m.feather ? `<filter id="b" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${(m.feather * 5).toFixed(1)}"/></filter>` : '';
    const f = m.feather ? ' filter="url(#b)"' : '';
    const shape = m.invert
      ? `<polygon points="${pts.join(' ')}" fill="#fff"${f}/>`
      : `<path fill-rule="evenodd" fill="#fff"${f} d="M-500,-500H1500V1500H-500Z M${pts.join(' L')}Z"/>`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000" preserveAspectRatio="none">${blur}${shape}</svg>`;
    return `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`;
  });
}

// Quadrilatère utilisable : convexe et non dégénéré (sinon l'image se replie ou disparaît).
export function quadOk(p) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = p[i], [bx, by] = p[(i + 1) % 4], [cx, cy] = p[(i + 2) % 4];
    const z = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    if (Math.abs(z) < 1e-9) return false;
    if (sign && Math.sign(z) !== sign) return false;
    sign = Math.sign(z);
  }
  return true;
}

// Masque de fondu : rampe corrigée en gamma pour que la lumière de deux
// projecteurs qui se recouvrent s'additionne sans bande plus claire.
export function blendMask(blend = {}, gamma = 2.2) {
  const ramp = (dir, size) => {
    if (!size) return null;
    const stops = [];
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      stops.push(`rgba(0,0,0,${Math.pow(t, 1 / gamma).toFixed(3)}) ${(t * size * 100).toFixed(2)}%`);
    }
    return `linear-gradient(${dir}, ${stops.join(', ')}, #000 ${(size * 100).toFixed(2)}%)`;
  };
  const layers = [ramp('to right', blend.l), ramp('to left', blend.r), ramp('to bottom', blend.t), ramp('to top', blend.b)].filter(Boolean);
  return layers.length ? layers.join(', ') : '';
}

export const DEFAULT_CORNERS = [[0, 0], [1, 0], [1, 1], [0, 1]];

// Mire de calage : grille, cercles, diagonales et nom de la zone.
export function testPatternSvg(name, color = '#22d3ee') {
  const lines = [];
  for (let i = 1; i < 16; i++) lines.push(`<line x1="${i * 100}" y1="0" x2="${i * 100}" y2="900" />`);
  for (let i = 1; i < 9; i++) lines.push(`<line x1="0" y1="${i * 100}" x2="1600" y2="${i * 100}" />`);
  return `<svg viewBox="0 0 1600 900" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="0" width="1600" height="900" fill="rgba(0,0,0,.35)" stroke="${color}" stroke-width="12"/>
    <g stroke="${color}" stroke-width="2" opacity=".7">${lines.join('')}</g>
    <g stroke="#fff" stroke-width="3" fill="none"><line x1="0" y1="0" x2="1600" y2="900"/><line x1="1600" y1="0" x2="0" y2="900"/>
    <circle cx="800" cy="450" r="300"/><circle cx="800" cy="450" r="150"/></g>
    <text x="800" y="470" fill="#fff" font-size="64" font-family="system-ui" font-weight="800" text-anchor="middle">${String(name).replace(/[<&>]/g, '')}</text>
  </svg>`;
}
