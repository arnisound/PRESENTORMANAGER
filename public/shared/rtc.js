// Visio intégrée — côté réception (écrans, régie). Chaque page qui affiche un
// invité ouvre sa propre connexion WebRTC directe avec lui ; le serveur PresenThor
// ne sert qu'à se trouver (signalisation). La régie renvoie en plus un "retour"
// (son de la salle, image) à chaque invité.
let client = null;
let getState = () => null;
const peers = new Map(); // guestId -> { pc, cid, stream, ready, resolve, reject }
const ret = { audio: null, video: null }; // pistes de retour (régie uniquement)

export function iceServers(settings = {}) {
  const list = String(settings.stunServers || '').split(/[\s,]+/).filter(Boolean).map((urls) => ({ urls }));
  if (settings.turnUrl) list.push({ urls: settings.turnUrl, username: settings.turnUser || undefined, credential: settings.turnPass || undefined });
  return list;
}

function init(c, stateFn) {
  if (client) return;
  client = c;
  getState = stateFn;
  c.rtcHandlers.add(async (m) => {
    const p = [...peers.values()].find((x) => x.cid === m.from);
    if (!p) return;
    try {
      if (m.data.kind === 'answer') await p.pc.setRemoteDescription(m.data.sdp);
      else if (m.data.kind === 'ice' && m.data.c) await p.pc.addIceCandidate(m.data.c);
      else if (m.data.kind === 'bye') drop(p.guestId);
    } catch (e) { console.warn('visio', e); }
  });
}

function drop(guestId) {
  const p = peers.get(guestId);
  if (!p) return;
  peers.delete(guestId);
  try { p.pc.close(); } catch {}
  p.reject?.(new Error('Invité déconnecté'));
}

// Ferme les connexions des invités partis ou reconnectés (nouvelle connexion = nouvel identifiant).
export function syncGuests(state) {
  for (const [gid, p] of peers) {
    const g = state?.guests?.find((x) => x.id === gid);
    if (!g || g.cid !== p.cid) drop(gid);
  }
}

export function guestStream(c, stateFn, guestId) {
  init(c, stateFn);
  const state = getState();
  const g = state?.guests?.find((x) => x.id === guestId);
  if (!g) return Promise.reject(new Error('Invité non connecté'));
  const existing = peers.get(guestId);
  if (existing && existing.cid === g.cid) return existing.ready;
  if (existing) drop(guestId);

  const pc = new RTCPeerConnection({ iceServers: iceServers(state.settings) });
  const stream = new MediaStream();
  const p = { pc, cid: g.cid, guestId, stream };
  p.ready = new Promise((resolve, reject) => { p.resolve = resolve; p.reject = reject; });
  peers.set(guestId, p);
  // Réception de l'image et du son de l'invité ; envoi du retour (si défini) sur les mêmes canaux.
  const tv = pc.addTransceiver('video', { direction: 'sendrecv' });
  const ta = pc.addTransceiver('audio', { direction: 'sendrecv' });
  p.tv = tv; p.ta = ta;
  if (ret.video) tv.sender.replaceTrack(ret.video).catch(() => {});
  if (ret.audio) ta.sender.replaceTrack(ret.audio).catch(() => {});
  pc.ontrack = (e) => {
    stream.addTrack(e.track);
    if (e.track.kind === 'video' || stream.getTracks().length >= 2) p.resolve(stream);
  };
  pc.onicecandidate = (e) => { if (e.candidate) client.rtc(g.cid, { kind: 'ice', c: e.candidate }); };
  pc.onconnectionstatechange = () => { if (['failed', 'closed'].includes(pc.connectionState)) drop(guestId); };
  pc.createOffer()
    .then((o) => pc.setLocalDescription(o))
    .then(() => client.rtc(g.cid, { kind: 'offer', sdp: pc.localDescription, guestId }))
    .catch((e) => p.reject(e));
  setTimeout(() => p.reject(new Error('L\'invité ne répond pas')), 15000);
  return p.ready;
}

// Régie : son et image renvoyés à tous les invités (console de mixage, caméra, sortie…).
export function setReturnTracks({ audio = ret.audio, video = ret.video } = {}) {
  ret.audio = audio; ret.video = video;
  for (const p of peers.values()) {
    p.ta?.sender.replaceTrack(audio || null).catch(() => {});
    p.tv?.sender.replaceTrack(video || null).catch(() => {});
  }
}

export function peerStats() {
  return [...peers.values()].map((p) => ({ guestId: p.guestId, state: p.pc.connectionState }));
}
