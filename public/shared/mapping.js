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
  return `matrix3d(${m.map((v) => +v.toPrecision(15)).join(",")})`;
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
