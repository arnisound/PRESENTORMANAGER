import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.js';

function fresh() {
  const s = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'presenthor-comp-')));
  s.state.media = [{ id: 'm1', name: 'deck.pdf', file: 'm1.pdf', kind: 'slides', status: 'ready', pages: 3 }, { id: 'm2', name: 'v.mp4', file: 'm2.mp4', kind: 'video', status: 'ready' }];
  const [fond, contenu, habillage] = s.state.comp.layers;
  const cell = (layer, col, cue) => s.dispatch({ type: 'comp.cell.create', layerId: layer.id, col, cue }).id;
  return { s, fond, contenu, habillage, cell };
}
const nav = (s, type) => { s._lastNav = 0; s.dispatch({ type }); };

test('composition par défaut : 3 calques, 8 colonnes', () => {
  const { s } = fresh();
  assert.equal(s.state.comp.layers.length, 3);
  assert.equal(s.state.comp.columns.length, 8);
  assert.ok(s.state.comp.layers.every((l) => l.clips.length === 8));
});

test('déclencher un clip ne touche pas les autres calques ; une colonne vide les calques sans clip', () => {
  const { s, fond, contenu, habillage, cell } = fresh();
  const bg = cell(fond, 0, { type: 'video', mediaId: 'm2' });
  const deck = cell(contenu, 1, { type: 'slides', mediaId: 'm1' });
  const qr = cell(habillage, 0, { type: 'qr', text: 'https://exemple.fr' });
  s.dispatch({ type: 'comp.trigger', layerId: fond.id, col: 0 });
  s.dispatch({ type: 'comp.trigger', layerId: contenu.id, col: 1 });
  const a = s.state.live.comp.active;
  assert.equal(a[fond.id], bg);
  assert.equal(a[contenu.id], deck);
  assert.ok(s.state.live.comp.pb[fond.id].playing, 'la vidéo démarre');
  s.dispatch({ type: 'comp.column.trigger', col: 0 });
  assert.equal(a[fond.id], bg);
  assert.equal(a[habillage.id], qr);
  assert.equal(a[contenu.id], undefined, 'calque sans clip dans la colonne → vidé');
});

test('télécommande : diapos de la présentation active, puis colonne suivante', () => {
  const { s, fond, contenu, cell } = fresh();
  const deck = cell(contenu, 0, { type: 'slides', mediaId: 'm1' });
  const v = cell(fond, 1, { type: 'video', mediaId: 'm2' });
  s.dispatch({ type: 'comp.column.trigger', col: 0 });
  nav(s, 'next'); nav(s, 'next');
  assert.equal(s.state.live.comp.slides[deck], 3);
  nav(s, 'next');
  assert.equal(s.state.live.comp.column, 1, 'dernière diapo → colonne suivante');
  assert.equal(s.state.live.comp.active[fond.id], v);
  nav(s, 'prev');
  assert.equal(s.state.live.comp.column, 0);
  assert.equal(s.state.live.comp.slides[deck], 3, 'la présentation garde sa position');
});

test('fin de clip : boucle, arrêt ou clip suivant du calque', () => {
  const { s, fond, cell } = fresh();
  const a = cell(fond, 0, { type: 'video', mediaId: 'm2', loopMode: 'next' });
  const b = cell(fond, 2, { type: 'video', mediaId: 'm2', loopMode: 'once' });
  s.dispatch({ type: 'comp.trigger', layerId: fond.id, col: 0 });
  s.dispatch({ type: 'comp.ended', layerId: fond.id, cueId: a, duration: 4 }, 'output');
  assert.equal(s.state.live.comp.active[fond.id], b);
  s.dispatch({ type: 'comp.ended', layerId: fond.id, cueId: b, duration: 4 }, 'output');
  assert.equal(s.state.live.comp.pb[fond.id].playing, false);
  assert.equal(s.state.live.comp.pb[fond.id].offset, 4);
});

test('glisser une case : échange, copie ; colonnes ajoutées / supprimées', () => {
  const { s, fond, contenu, cell } = fresh();
  const x = cell(fond, 0, { type: 'title', title: 'A' });
  s.dispatch({ type: 'comp.cell.move', from: { layerId: fond.id, col: 0 }, to: { layerId: contenu.id, col: 3 } });
  assert.equal(contenu.clips[3], x);
  assert.equal(fond.clips[0], null);
  s.dispatch({ type: 'comp.cell.move', from: { layerId: contenu.id, col: 3 }, to: { layerId: fond.id, col: 3 }, copy: true });
  assert.ok(fond.clips[3] && fond.clips[3] !== x);
  s.dispatch({ type: 'comp.column.add', index: 0 });
  assert.equal(contenu.clips[4], x, 'insertion après la colonne 1 décale la suite');
  s.dispatch({ type: 'comp.column.remove', index: 1 });
  assert.equal(s.state.comp.columns.length, 8);
  s.dispatch({ type: 'cue.remove', id: x });
  assert.ok(!contenu.clips.includes(x));
});

test('réglages de calque bornés et validés', () => {
  const { s, fond } = fresh();
  s.dispatch({ type: 'comp.layer.update', id: fond.id, patch: { opacity: 3, blend: 'hack', transform: { scale: 99 }, effects: [{ type: 'blur', value: 4 }, { type: 'evil' }] } });
  assert.equal(fond.opacity, 1);
  assert.equal(fond.blend, 'normal');
  assert.equal(fond.transform.scale, 8);
  assert.deepEqual(fond.effects, [{ type: 'blur', value: 4, on: true }]);
  assert.equal(s.dispatch({ type: 'comp.trigger', layerId: fond.id, col: 0 }, 'audience').error, 'forbidden');
});

test('routage AUX : calque réservé à certains écrans, réglages bornés aux sorties existantes', () => {
  const { s, habillage } = fresh();
  s.dispatch({ type: 'comp.layer.update', id: habillage.id, patch: { mainOut: false, auxOutputs: ['out_presenter', 'out_inexistante'] } });
  assert.equal(habillage.mainOut, false);
  assert.deepEqual(habillage.auxOutputs, ['out_presenter']);
  assert.equal(s.dispatch({ type: 'output.update', id: 'out_public', patch: { source: 'aux' } }).ok, true);
});

test('préférences : transition des nouveaux calques, fin des vidéos, vote unique', () => {
  const { s, fond } = fresh();
  s.dispatch({ type: 'settings.update', patch: { defaultLayerTransitionMs: 500, defaultLoopMode: 'once', voteChange: false, apiToken: 'pirate' } });
  assert.notEqual(s.state.settings.apiToken, 'pirate', 'le jeton ne se modifie pas par settings.update');
  const id = s.dispatch({ type: 'comp.layer.add' }).id;
  assert.equal(s.state.comp.layers.find((l) => l.id === id).transitionMs, 500);
  const v = s.dispatch({ type: 'comp.cell.create', layerId: fond.id, col: 4, cue: { type: 'video', mediaId: 'm2' } }).id;
  assert.equal(s.cue(v).loopMode, 'once');
  const p = s.dispatch({ type: 'poll.create', poll: { question: 'Q', options: ['A', 'B'] } }).id;
  s.dispatch({ type: 'poll.open', id: p });
  assert.ok(s.dispatch({ type: 'vote', pollId: p, voterId: 'u', answer: 0 }, 'audience').ok);
  assert.ok(s.dispatch({ type: 'vote', pollId: p, voterId: 'u', answer: 1 }, 'audience').error);
});

test('page web : une adresse sans https:// est corrigée', () => {
  const { s, contenu } = fresh();
  const id = s.dispatch({ type: 'comp.cell.create', layerId: contenu.id, col: 5, cue: { type: 'web', url: 'www.exemple.fr' } }).id;
  assert.equal(s.cue(id).url, 'https://www.exemple.fr');
  s.dispatch({ type: 'cue.update', id, patch: { url: '  exemple.org/page ' } });
  assert.equal(s.cue(id).url, 'https://exemple.org/page');
});
