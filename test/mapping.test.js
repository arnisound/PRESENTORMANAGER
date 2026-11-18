import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quadMatrix, blendMask } from '../public/shared/mapping.js';

// Applique la matrix3d CSS (colonne par colonne) à un point 2D.
function apply(css, x, y) {
  const m = css.slice(9, -1).split(',').map(Number);
  const X = m[0] * x + m[4] * y + m[12], Y = m[1] * x + m[5] * y + m[13], Wd = m[3] * x + m[7] * y + m[15];
  return [X / Wd, Y / Wd];
}

test('déformation 4 coins : chaque coin de la sortie arrive sur le coin réglé', () => {
  const W = 1920, H = 1080;
  const quad = [[120, 40], [1800, 90], [1880, 1050], [60, 1000]];
  const css = quadMatrix(W, H, quad);
  [[0, 0], [W, 0], [W, H], [0, H]].forEach(([x, y], i) => {
    const [px, py] = apply(css, x, y);
    assert.ok(Math.abs(px - quad[i][0]) < 1e-6 && Math.abs(py - quad[i][1]) < 1e-6, `coin ${i}: ${px},${py}`);
  });
});

test('déformation identité', () => {
  const css = quadMatrix(100, 50, [[0, 0], [100, 0], [100, 50], [0, 50]]);
  assert.deepEqual(apply(css, 37, 21).map((v) => +v.toFixed(6)), [37, 21]);
});

test('fondu de bord : rampe gamma uniquement sur les bords demandés', () => {
  assert.equal(blendMask({}), '');
  const m = blendMask({ r: 0.2 });
  assert.match(m, /^linear-gradient\(to left/);
  assert.equal(m.split('linear-gradient').length - 1, 1);
});
