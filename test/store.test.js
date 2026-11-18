import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, pollResults } from '../server/store.js';

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'presentor-test-'));
  const s = new Store(dir);
  s.state.cues = [];
  s.state.media = [{ id: 'm1', name: 'deck.pdf', file: 'm1.pdf', kind: 'slides', status: 'ready', pages: 3 }, { id: 'm2', name: 'v.mp4', file: 'm2.mp4', kind: 'video', status: 'ready' }];
  const a = s.dispatch({ type: 'cue.add', cue: { type: 'slides', mediaId: 'm1' } }).id;
  const b = s.dispatch({ type: 'cue.add', cue: { type: 'video', mediaId: 'm2', autoNext: true } }).id;
  const c = s.dispatch({ type: 'cue.add', cue: { type: 'title', title: 'Pause' } }).id;
  return { s, a, b, c };
}
const nav = (s, type) => { s._lastNav = 0; s.dispatch({ type }); };

test('suivant parcourt les diapos puis enchaîne sur l\'élément suivant', () => {
  const { s, a, b } = fresh();
  nav(s, 'next');
  assert.deepEqual(s.state.live.program, { cueId: a, slide: 1 });
  nav(s, 'next'); nav(s, 'next');
  assert.equal(s.state.live.program.slide, 3);
  nav(s, 'next');
  assert.deepEqual(s.state.live.program, { cueId: b, slide: 1 });
  assert.equal(s.state.live.playback.playing, true);
  nav(s, 'prev');
  assert.deepEqual(s.state.live.program, { cueId: a, slide: 3 }, 'précédent revient à la dernière diapo');
});

test('take envoie la preview au programme et prépare la suivante', () => {
  const { s, a, b } = fresh();
  s.dispatch({ type: 'preview.set', cueId: a, slide: 2 });
  s.dispatch({ type: 'take' });
  assert.deepEqual(s.state.live.program, { cueId: a, slide: 2 });
  assert.equal(s.state.live.preview.cueId, b);
});

test('un appui suivant sort du noir sans changer de diapo', () => {
  const { s, a } = fresh();
  s.dispatch({ type: 'program.set', cueId: a, slide: 2 });
  s.dispatch({ type: 'blackout.toggle' });
  nav(s, 'next');
  assert.equal(s.state.live.blackout, false);
  assert.equal(s.state.live.program.slide, 2);
});

test('fin de vidéo : enchaînement automatique, une seule fois', () => {
  const { s, b, c } = fresh();
  s.dispatch({ type: 'program.set', cueId: b });
  s.dispatch({ type: 'video.ended', cueId: b, duration: 4 }, 'output');
  s.dispatch({ type: 'video.ended', cueId: b, duration: 4 }, 'output');
  assert.equal(s.state.live.program.cueId, c);
});

test('pause / lecture conserve la position', () => {
  const { s, b } = fresh();
  s.dispatch({ type: 'program.set', cueId: b });
  s.dispatch({ type: 'video.seek', time: 10 });
  s.dispatch({ type: 'video.pause' });
  assert.ok(Math.abs(s.state.live.playback.offset - 10) < 0.2); // 100 ms d'avance volontaire pour la diffusion
  s.dispatch({ type: 'video.play' });
  assert.ok(Math.abs((Date.now() - s.state.live.playback.startedAt) / 1000 - 10) < 0.2);
});

test('droits : le public ne peut que voter / poser des questions', () => {
  const { s } = fresh();
  assert.equal(s.dispatch({ type: 'next' }, 'audience').error, 'forbidden');
  assert.equal(s.dispatch({ type: 'cue.remove', id: 'x' }, 'output').error, 'forbidden');
});

test('sondages : un vote par participant, modifiable', () => {
  const { s } = fresh();
  const id = s.dispatch({ type: 'poll.create', poll: { question: 'Q', options: ['A', 'B'] } }).id;
  assert.ok(s.dispatch({ type: 'vote', pollId: id, voterId: 'u1', answer: 0 }, 'audience').error, 'vote fermé');
  s.dispatch({ type: 'poll.open', id });
  s.dispatch({ type: 'vote', pollId: id, voterId: 'u1', answer: 0 }, 'audience');
  s.dispatch({ type: 'vote', pollId: id, voterId: 'u1', answer: 1 }, 'audience');
  s.dispatch({ type: 'vote', pollId: id, voterId: 'u2', answer: 1 }, 'audience');
  assert.deepEqual(pollResults(s.state.polls[0]), { total: 2, counts: [0, 2] });
});

test('questions du public : modération et affichage unique', () => {
  const { s } = fresh();
  assert.ok(s.dispatch({ type: 'qa.ask', text: 'Hello' }, 'audience').error);
  s.dispatch({ type: 'qa.toggle', value: true });
  s.dispatch({ type: 'qa.ask', text: 'Q1' }, 'audience');
  s.dispatch({ type: 'qa.ask', text: 'Q2' }, 'audience');
  const [q1, q2] = s.state.questions;
  s.dispatch({ type: 'qa.update', id: q1.id, status: 'shown' });
  s.dispatch({ type: 'qa.update', id: q2.id, status: 'shown' });
  assert.equal(q1.status, 'done');
  assert.equal(q2.status, 'shown');
});

test('scène : suivant pilote le calque principal puis passe à l\'élément suivant', () => {
  const { s, a, b, c } = fresh();
  const sc = s.dispatch({ type: 'cue.add', cue: { type: 'scene', layers: [{ cueId: a, main: true }, { cueId: b, x: 0.7, y: 0.7, w: 0.3, h: 0.3 }] }, index: 0 }).id;
  s.dispatch({ type: 'program.set', cueId: sc });
  nav(s, 'next'); nav(s, 'next');
  assert.deepEqual(s.state.live.program, { cueId: sc, slide: 3 });
  nav(s, 'next');
  assert.equal(s.state.live.program.cueId, a, 'après la dernière diapo on passe à l\'élément suivant');
  assert.ok(c);
});

test('scène : pas de scène imbriquée, calques nettoyés à la suppression', () => {
  const { s, a } = fresh();
  const sc1 = s.dispatch({ type: 'cue.add', cue: { type: 'scene', layers: [{ cueId: a }] } }).id;
  const sc2 = s.dispatch({ type: 'cue.add', cue: { type: 'scene', layers: [{ cueId: sc1 }, { cueId: a, x: 5, w: -1 }] } }).id;
  const layers = s.cue(sc2).layers;
  assert.equal(layers.length, 1);
  assert.equal(layers[0].x, 2); // borné
  assert.equal(layers[0].w, 0.01);
  s.dispatch({ type: 'cue.remove', id: a });
  assert.equal(s.cue(sc1).layers.length, 0);
});
