// Préférences : tous les réglages du logiciel, rangés par thème. Chaque
// modification est enregistrée immédiatement et s'applique à tous les écrans.
import { esc, getPin } from '/shared/client.js';
import { audioOutputs } from '/shared/renderer.js';

const SECTIONS = [
  ['video', 'Vidéo et performances'], ['audio', 'Audio'], ['play', 'Lecture'], ['regie', 'Régie et télécommande'], ['outputs', 'Sorties et rendu'], ['lt', 'Bandeau et habillage'],
  ['public', 'Public et présentateur'], ['timer', 'Chronomètre'], ['visio', 'Visio (invités)'], ['ndi', 'NDI'], ['api', 'Commandes à distance'], ['system', 'Système et sauvegarde'],
];

export function openPrefs({ getState, send, info, toast }) {
  let section = 'video';
  let sinks = [];
  const loadSinks = async (ask = false) => {
    // Les noms des cartes son ne sont visibles qu'après une autorisation micro (navigateur).
    if (ask) { try { (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach((t) => t.stop()); } catch {} }
    sinks = await audioOutputs(true);
    render();
  };
  loadSinks();
  const root = document.createElement('div');
  root.className = 'modal';
  root.innerHTML = `<div class="modal-box prefs">
    <header class="modal-head"><b>Préférences</b><span class="hint">Enregistrées automatiquement</span><div class="spacer"></div><button class="btn primary" data-close>Fermer</button></header>
    <div class="prefs-body"><nav class="prefs-nav">${SECTIONS.map(([k, l]) => `<button data-sec="${k}">${l}</button>`).join('')}</nav><div class="prefs-main"></div></div></div>`;
  document.body.append(root);
  const main = root.querySelector('.prefs-main');

  const S = () => getState();
  const st = () => S().settings;
  const opt = (list, v) => list.map(([k, l]) => `<option value="${esc(k)}"${String(k) === String(v) ? ' selected' : ''}>${esc(l)}</option>`).join('');
  const row = (label, input, hint = '') => `<div class="pref"><div><div class="pref-l">${label}</div>${hint ? `<div class="hint">${hint}</div>` : ''}</div><div class="pref-i">${input}</div></div>`;
  const chk = (k, v = st()[k]) => `<label class="switch"><input type="checkbox" data-pref="${k}"${v !== false && v ? ' checked' : ''}><span></span></label>`;
  const num = (k, min, max, step = 1, unit = '') => `<span class="row"><input type="number" data-pref="${k}" min="${min}" max="${max}" step="${step}" value="${esc(st()[k] ?? '')}" style="width:96px">${unit ? `<span class="hint">${unit}</span>` : ''}</span>`;
  const sel = (k, list) => `<select data-pref="${k}">${opt(list, st()[k])}</select>`;
  const txt = (k, ph = '', type = 'text') => `<input type="${type}" data-pref="${k}" value="${esc(st()[k] ?? '')}" placeholder="${esc(ph)}">`;
  const color = (k) => `<input type="color" data-pref="${k}" value="${esc(st()[k] || '#000000')}">`;

  function render() {
    for (const b of root.querySelectorAll('[data-sec]')) b.classList.toggle('active', b.dataset.sec === section);
    const s = st();
    const base = location.origin;
    let h = '';
    if (section === 'video') {
      h = row('Lecture des vidéos', sel('videoSync', [['smooth', 'Fluide — recommandé (comme un lecteur classique)'], ['strict', 'Synchronisée de près entre plusieurs écrans']]),
          '« Fluide » : chaque sortie se cale au lancement puis lit librement (image et son parfaits). « Synchronisée » : recalage plus fréquent, utile seulement pour un mur d\'écrans sur plusieurs ordinateurs.')
        + row('Vidéos dans les écrans de contrôle', sel('monitorVideo', [['proxy', 'Animées (version légère)'], ['still', 'Image fixe (économise la machine)'], ['off', 'Désactivées']]),
          'Régie, aperçu, retour présentateur, multiview. Les sorties publiques lisent toujours le fichier original.')
        + row('Optimiser automatiquement les vidéos importées', chk('autoOptimize'), 'Les formats lourds ou mal lus (HEVC, ProRes…) sont réencodés en H.264 en arrière-plan.')
        + row('Accélération matérielle (carte graphique)', chk('gpuAcceleration'), 'À laisser activée. Désactivez seulement en cas d\'image noire ou de plantage (redémarrage nécessaire).')
        + row('Forcer la carte graphique', chk('gpuForce'), 'Si la vidéo reste saccadée sur un PC dont la carte graphique est ignorée par sécurité (redémarrage nécessaire).')
        + row('Qualité de rendu des présentations', sel('renderScale', [[1, 'Standard'], [1.5, 'Haute'], [2, 'Très haute'], [3, 'Maximale']]))
        + row('Diapositives préchargées en avance', num('preloadSlides', 0, 10))
        + `<p class="hint">Pour un grand écran : préférez des vidéos en H.264 (bouton ⚡ dans les médias), une seule sortie avec le son, et les aperçus en « version légère » ou « image fixe ».</p>`;
    } else if (section === 'audio') {
      const opts = [['', 'Sortie par défaut du système'], ...sinks.filter((d) => d.deviceId !== 'default').map((d) => [d.deviceId, d.label || 'Carte son'])];
      const sinkSel = (attr, cur) => `<select ${attr}>${opt(opts, cur?.id && sinks.some((d) => d.deviceId === cur.id) ? cur.id : sinks.find((d) => d.label === cur?.label)?.deviceId || '')}</select>`;
      h = row('Carte son des sorties (par défaut)', sinkSel('data-sink="default"', s.audioDevice), 'Utilisée par toute sortie qui a le son, sauf si une autre carte lui est attribuée ci-dessous.')
        + `<div class="box"><b>Son par sortie</b>${S().outputs.map((o) => `<div class="pref"><div><div class="pref-l">${esc(o.name)}</div><div class="hint">${o.audio ? 'Son activé' : 'Muette'}</div></div>
            <div class="pref-i" style="gap:8px"><label class="switch"><input type="checkbox" data-out-audio="${o.id}"${o.audio ? ' checked' : ''}><span></span></label>${sinkSel(`data-sink="out:${o.id}"`, o.audioDevice)}</div></div>`).join('')}
          <span class="hint">Plusieurs sorties peuvent avoir le son, chacune sur sa carte : par ex. la salle sur la console, un retour scène sur une autre carte. Le son d'un écran est celui de ses calques.</span></div>`
        + row('Pré-écoute dans la régie', chk('regieListen'), 'Le moniteur de sortie de la régie devient audible, par ex. sur un casque.')
        + row('Carte son de la pré-écoute', sinkSel('data-sink="regie"', s.regieAudioDevice))
        + row('Volume général', `<span class="row"><input type="range" min="0" max="1" step="0.01" data-pref="masterVolume" value="${s.masterVolume ?? 1}" style="width:160px"><output>${Math.round((s.masterVolume ?? 1) * 100)} %</output></span>`)
        + `<div class="row"><button class="btn sm" data-sinks-ask>Afficher le nom des cartes son</button><span class="hint">${sinks.length} sortie(s) audio détectée(s)</span></div>`;
    } else if (section === 'play') {
      h = row('Transition des nouveaux calques', sel('defaultLayerTransitionMs', [[0, 'Cut'], [250, 'Fondu 0,25 s'], [500, 'Fondu 0,5 s'], [1000, 'Fondu 1 s'], [2000, 'Fondu 2 s']]), 'Chaque calque garde ensuite son propre réglage.')
        + row('Fin des vidéos importées', sel('defaultLoopMode', [['loop', 'Boucle'], ['once', 'Une fois (reste sur la fin)'], ['next', 'Puis clip suivant du calque'], ['clear', 'Une fois puis vider le calque']]))
        + row('Lancer les vidéos dès le déclenchement', chk('defaultAutoplay'))
        + row('Volume général', `<span class="row"><input type="range" min="0" max="1" step="0.01" data-pref="masterVolume" value="${s.masterVolume ?? 1}" style="width:160px"><output>${Math.round((s.masterVolume ?? 1) * 100)} %</output></span>`, 'Multiplie le volume de tous les calques sur les sorties audio.');
    } else if (section === 'regie') {
      h = row('Taille des vignettes de la grille', sel('cellSize', [[96, 'Petites'], [132, 'Moyennes'], [168, 'Grandes'], [210, 'Très grandes']]))
        + row('Demander confirmation avant suppression', chk('confirmDelete'))
        + row('Télécommande : colonne suivante après la dernière diapo', `<label class="switch"><input type="checkbox" data-comp-pref="clickerColumns"${S().comp.clickerColumns ? ' checked' : ''}><span></span></label>`, 'Sans présentation à l\'écran, la télécommande déclenche les colonnes une à une.')
        + row('Anti-rebond de la télécommande', num('clickerDebounceMs', 0, 1000, 10, 'ms'), 'Ignore les doubles appuis envoyés par certaines télécommandes.')
        + row('Touche B (ou point) = écran noir', chk('blackoutKey'), 'Beaucoup de télécommandes ont un bouton « écran noir » qui envoie cette touche.')
        + row('Barre d\'espace = suivant', chk('spaceNext'));
    } else if (section === 'outputs') {
      h = row('Masquer le curseur sur les sorties', chk('hideCursor'))
        + row('Bandeau « connexion perdue » sur les écrans de contrôle', chk('showOfflineBanner'), 'Jamais affiché sur la sortie principale : elle garde sa dernière image.')
        + row('Couleur de fond des sorties', color('outputBackground'))
        + row('Empêcher la mise en veille des écrans', chk('keepAwake'))
        + row('Qualité de rendu des présentations', sel('renderScale', [[1, 'Standard'], [1.5, 'Haute'], [2, 'Très haute (écrans Retina / 4K)'], [3, 'Maximale']]), 'Plus haut = plus net, mais plus de mémoire.')
        + row('Diapositives préchargées en avance', num('preloadSlides', 0, 10));
    } else if (section === 'lt') {
      h = row('Couleur d\'accent', color('accent'), 'Barres de sondage, bandeau, QR code…')
        + row('Position du bandeau (lower-third)', sel('lowerThirdPosition', [['left', 'En bas à gauche'], ['center', 'En bas au centre'], ['right', 'En bas à droite']]))
        + row('Style du bandeau', sel('lowerThirdStyle', [['dark', 'Sombre'], ['accent', 'Couleur d\'accent'], ['light', 'Clair']]));
    } else if (section === 'public') {
      h = row('Le public peut modifier son vote', chk('voteChange'))
        + row('Résultats visibles par défaut', chk('voteResultsDefault'))
        + row('Adresse publique (serveur en ligne)', txt('publicUrl', 'https://evenement.mondomaine.fr', 'url'), 'Utilisée pour les QR codes de vote et le lien invité. Laissez vide sur un réseau local.')
        + row('Chrono : alerte (orange) avant la fin', num('timerWarnSec', 0, 3600, 10, 'secondes'));
    } else if (section === 'timer') {
      h = row('Affichage du chronomètre', sel('timerShow', [['always', 'Toujours affiché'], ['running', 'Seulement quand il tourne'], ['never', 'Jamais (désactivé)']]), '« Seulement quand il tourne » : rien ne s\'affiche tant que vous ne l\'avez pas lancé.')
        + row('Sur le retour présentateur', chk('timerOnPresenter'))
        + row('Sur la télécommande smartphone', chk('timerOnRemote'))
        + row('Dans la régie', chk('timerOnRegie'))
        + row('Alerte (orange) avant la fin', num('timerWarnSec', 0, 3600, 10, 'secondes'))
        + `<p class="hint">Durée, mode (compte à rebours / chronomètre), départ et remise à zéro : cliquez sur le chrono en haut de la régie, ou onglet Direct.</p>`;
    } else if (section === 'visio') {
      const link = `${(s.publicUrl || '').replace(/\/$/, '') || base}/guest/?k=${s.guestToken || ''}`;
      h = row('Lien à envoyer aux intervenants', `<div class="col"><div class="link">${esc(link)}</div><div class="row"><button class="btn sm" data-copy="${esc(link)}">Copier</button><button class="btn sm" data-regen="guestToken">Nouveau lien</button></div></div>`, 'L\'intervenant ouvre ce lien dans Chrome, Edge, Safari ou Firefox : caméra + micro, sans rien installer. « Nouveau lien » invalide l\'ancien.')
        + row('Débit vidéo maximal par invité', num('guestMaxKbps', 300, 8000, 100, 'kbit/s'))
        + row('Serveurs STUN', txt('stunServers', 'stun:stun.l.google.com:19302'), 'Permettent de traverser les box Internet. Séparés par des virgules.')
        + row('Serveur TURN (relais)', txt('turnUrl', 'turn:turn.mondomaine.fr:3478'), 'Nécessaire si un invité est derrière un pare-feu d\'entreprise strict.')
        + row('TURN : identifiant', txt('turnUser')) + row('TURN : mot de passe', txt('turnPass', '', 'password'))
        + `<p class="hint">Sur Internet, l'invité doit pouvoir joindre PresenThor : adresse publique (tunnel Cloudflare, serveur en ligne…). Sur le même réseau, rien à régler.</p>`;
    } else if (section === 'ndi') {
      h = row('Adresses IP à interroger', txt('ndiExtraIps', '192.168.1.20, 192.168.1.21'), 'Si les sources n\'apparaissent pas (réseau qui filtre la découverte automatique).')
        + row('Images par seconde des sorties NDI', sel('ndiFps', [[25, '25'], [30, '30'], [50, '50'], [60, '60']]))
        + row('Résolution des sorties NDI virtuelles', `<span class="row">${num('ndiWidth', 320, 3840)}<span>×</span>${num('ndiHeight', 180, 2160)}</span>`, 'Pour les sorties publiées en NDI sans écran.');
    } else if (section === 'api') {
      const tok = s.apiToken || '';
      const ex = (path) => `${base}${path}?token=${tok}`;
      h = row('Exiger le jeton pour chaque commande', chk('apiRequireToken'), 'Recommandé dès que PresenThor est joignable depuis Internet. Sans code PIN ni cette option, les commandes sont libres sur le réseau local.')
        + row('Jeton d\'API', `<div class="col"><code class="link">${esc(tok)}</code><div class="row"><button class="btn sm" data-copy="${esc(tok)}">Copier</button><button class="btn sm" data-regen="apiToken">Nouveau jeton</button></div></div>`, 'À joindre à chaque commande (paramètre ?token=, ou en-tête X-Token).')
        + `<div class="box"><b>Exemples (ouvrir l'adresse déclenche l'action)</b>
          ${[['/api/go/column/1', 'Colonne 1'], ['/api/go/clip/2/3', 'Clip colonne 3 du calque 2'], ['/api/go/next', 'Suivant'], ['/api/go/prev', 'Précédent'], ['/api/go/blackout', 'Écran noir'], ['/api/go/clear', 'Tout vider'], ['/api/go/opacity/2/0.5', 'Calque 2 à 50 %'], ['/api/go/master/1', 'Master à 100 %'], ['/api/go/slide/4', 'Diapo 4'], ['/api/status', 'État (JSON)']].map(([p, l]) => `<div class="api-row"><span>${l}</span><code>${esc(ex(p))}</code></div>`).join('')}
          <span class="hint">Pour tout le reste : POST /api/action avec l'action en JSON, ex. {"type":"comp.column.trigger","col":0}. Compatible Stream Deck (Companion, requête HTTP), automates, scripts, et plus tard un relais Internet (Cloudflare).</span></div>`;
    } else if (section === 'system') {
      const conv = (info.converters || []).map((c) => ({ libreoffice: 'LibreOffice', powerpoint: 'PowerPoint', keynote: 'Keynote' }[c]));
      h = row('Conversion PowerPoint / Keynote', `<span>${conv.length ? conv.join(', ') : 'aucun logiciel — installez LibreOffice (gratuit)'}</span>`)
        + row('Adresses réseau', (info.lan || []).map((u) => `<div class="link">${esc(u)}</div>`).join('') || '—')
        + row('Accès à la régie', `<span>${info.pinRequired ? 'Protégé par code PIN' : 'Libre sur le réseau local'}</span>`, 'Variable PRESENTHOR_PIN au lancement pour protéger la régie.')
        + row('Sauvegarde du show', `<div class="row"><a class="btn sm" href="/api/export${getPin() ? '?pin=' + encodeURIComponent(getPin()) : ''}">Exporter (.json)</a><label class="btn sm">Importer…<input type="file" accept=".json" data-import hidden></label></div>`, 'L\'export contient la grille, les réglages, les sondages ; les fichiers médias restent dans le dossier de l\'app.');
    }
    main.innerHTML = h;
  }

  const save = (key, value) => send({ type: 'settings.update', patch: { [key]: value } });
  root.addEventListener('click', async (e) => {
    const t = e.target;
    if (t.closest('[data-close]') || t === root) return close();
    const sec = t.closest('[data-sec]');
    if (sec) { section = sec.dataset.sec; return render(); }
    if (t.closest('[data-sinks-ask]')) return loadSinks(true);
    if (t.dataset.copy) { navigator.clipboard.writeText(t.dataset.copy).then(() => toast('Copié')); return; }
    if (t.dataset.regen) {
      if (!confirm('Générer un nouveau ' + (t.dataset.regen === 'apiToken' ? 'jeton ? L\'ancien ne fonctionnera plus.' : 'lien ? L\'ancien ne fonctionnera plus.'))) return;
      await send({ type: 'settings.regenerate', key: t.dataset.regen });
      render();
    }
  });
  root.addEventListener('change', async (e) => {
    const el = e.target;
    if (el.dataset.import !== undefined) {
      const file = el.files[0];
      if (!file || !confirm('Remplacer le show actuel par ce fichier ?')) return;
      const r = await fetch('/api/import', { method: 'POST', headers: { 'content-type': 'application/json', 'x-pin': getPin() }, body: await file.text() });
      toast(r.ok ? 'Show importé' : 'Import impossible');
      return;
    }
    if (el.dataset.compPref) return send({ type: 'comp.settings', [el.dataset.compPref]: el.checked });
    if (el.dataset.sink) {
      const d = sinks.find((x) => x.deviceId === el.value);
      const dev = d ? { id: d.deviceId, label: d.label } : null;
      const k = el.dataset.sink;
      if (k === 'default') return save('audioDevice', dev);
      if (k === 'regie') return save('regieAudioDevice', dev);
      return send({ type: 'output.update', id: k.slice(4), patch: { audioDevice: dev } });
    }
    if (el.dataset.outAudio) { await send({ type: 'output.update', id: el.dataset.outAudio, patch: { audio: el.checked } }); return render(); }
    const k = el.dataset.pref;
    if (!k) return;
    const v = el.type === 'checkbox' ? el.checked : el.type === 'number' || el.type === 'range' || /^-?\d+(\.\d+)?$/.test(el.value) && el.tagName === 'SELECT' ? Number(el.value) : el.value;
    await save(k, v);
  });
  root.addEventListener('input', (e) => {
    const el = e.target;
    if (el.type === 'range' && el.dataset.pref) {
      el.nextElementSibling.textContent = Math.round(el.value * 100) + ' %';
      save(el.dataset.pref, Number(el.value));
    }
  });
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  window.addEventListener('keydown', onKey, true);
  function close() { window.removeEventListener('keydown', onKey, true); root.remove(); }
  render();
}
