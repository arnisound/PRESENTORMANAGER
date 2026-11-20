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

test('homographie normalisée et son inverse', async () => {
  const { homography, applyH, invertH } = await import('../public/shared/mapping.js');
  const q = [[0.1, 0.05], [0.9, 0.1], [0.95, 0.95], [0.02, 0.9]];
  const H = homography(q);
  [[0, 0], [1, 0], [1, 1], [0, 1]].forEach(([u, v], i) => {
    const [x, y] = applyH(H, u, v);
    assert.ok(Math.abs(x - q[i][0]) < 1e-9 && Math.abs(y - q[i][1]) < 1e-9);
  });
  const [x, y] = applyH(H, 0.3, 0.7);
  const [u, v] = applyH(invertH(H), x, y);
  assert.ok(Math.abs(u - 0.3) < 1e-9 && Math.abs(v - 0.7) < 1e-9);
});

test('forme impossible : pas de transformation (au lieu d\'une image perdue)', async () => {
  const { quadMatrix } = await import('../public/shared/mapping.js');
  assert.equal(quadMatrix(100, 100, [[0, 0], [50, 0], [100, 0], [0, 0]]), null);
});

test('grille de déformation : interpolation des décalages', async () => {
  const { meshOffset } = await import('../public/shared/mapping.js');
  const mesh = { cols: 2, rows: 2, points: Array.from({ length: 9 }, (_, i) => (i === 4 ? [0.1, -0.2] : [0, 0])) };
  assert.deepEqual(meshOffset(mesh, 0.5, 0.5).map((v) => +v.toFixed(6)), [0.1, -0.2]);
  assert.deepEqual(meshOffset(mesh, 0.25, 0.5).map((v) => +v.toFixed(6)), [0.05, -0.1]);
});

test('zones : grille, masques et cadenas nettoyés', async () => {
  const { Store } = await import('../server/store.js');
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const s = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'presenthor-map-')));
  const id = s.state.outputs[0].id;
  s.dispatch({ type: 'output.update', id, patch: { zones: [{ id: 'z', name: 'Z', lock: 1, source: 'aux', mesh: { cols: 20, rows: 2, points: [[5, 0]] }, masks: [{ points: [[0, 0], [1, 0]] }, { points: [[0, 0], [1, 0], [1, 1]], feather: 99 }] }] } });
  const z = s.state.outputs[0].zones[0];
  assert.equal(z.lock, true);
  assert.equal(z.source, 'aux');
  assert.equal(z.mesh.cols, 8);
  assert.equal(z.mesh.points.length, 27);
  assert.deepEqual(z.mesh.points[0], [1, 0]);
  assert.equal(z.masks.length, 1);
  assert.equal(z.masks[0].feather, 20);
});
