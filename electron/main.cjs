// Application Mac / PC : embarque le serveur, ouvre la régie, et pilote les
// sorties plein écran sur chaque écran physique (projecteur, retour, régie…).
const { app, BrowserWindow, screen, ipcMain, session, powerSaveBlocker, Menu, shell, globalShortcut } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { NdiOutputs } = require('./ndi-out.cjs');
const { NativeDeck } = require('./ppt.cjs');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

let server;
let ndiOut;
let control;
const outputs = new Map(); // outputId -> BrowserWindow
const prefsFile = () => path.join(app.getPath('userData'), 'desktop.json');
let prefs = { outputs: {}, globalClicker: false };

function loadPrefs() { try { prefs = { ...prefs, ...JSON.parse(fs.readFileSync(prefsFile(), 'utf8')) }; } catch {} }
function savePrefs() { fs.writeFileSync(prefsFile(), JSON.stringify(prefs, null, 1)); }

function displayList() {
  const primary = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d, i) => ({
    id: d.id,
    label: `${i + 1}. ${d.label || 'Écran'} — ${d.size.width}×${d.size.height}${d.id === primary ? ' (principal)' : ''}`,
    bounds: d.bounds,
    primary: d.id === primary,
  }));
}

function openOutput(outputId, displayId) {
  closeOutput(outputId, false);
  const display = screen.getAllDisplays().find((d) => d.id === displayId);
  const win = new BrowserWindow({
    title: 'Sortie',
    backgroundColor: '#000000',
    show: false,
    frame: !display,
    autoHideMenuBar: true,
    ...(display ? { x: display.bounds.x, y: display.bounds.y, width: display.bounds.width, height: display.bounds.height } : { width: 960, height: 540 }),
    // sandbox désactivé : le preload charge le module natif NDI.
    webPreferences: { backgroundThrottling: false, sandbox: false, preload: path.join(__dirname, 'preload.cjs') },
  });
  win.loadURL(`${server.url}/output/?id=${encodeURIComponent(outputId)}`);
  win.once('ready-to-show', () => {
    win.show();
    if (display) {
      win.setBounds(display.bounds);
      win.setFullScreen(true);
      // Évite que la fenêtre de sortie passe derrière un autre logiciel.
      win.setAlwaysOnTop(true, 'screen-saver');
    }
  });
  win.on('closed', () => { if (outputs.get(outputId) === win) outputs.delete(outputId); });
  win.webContents.once('did-finish-load', () => ndiOut?.sync().catch(() => {}));
  outputs.set(outputId, win);
  prefs.outputs[outputId] = { displayId: display ? display.id : null, open: true };
  savePrefs();
}

function closeOutput(outputId, forget = true) {
  const w = outputs.get(outputId);
  if (w && !w.isDestroyed()) w.destroy();
  outputs.delete(outputId);
  if (forget && prefs.outputs[outputId]) { prefs.outputs[outputId].open = false; savePrefs(); }
}

function identifyDisplays() {
  for (const [i, d] of screen.getAllDisplays().entries()) {
    const w = new BrowserWindow({ ...d.bounds, frame: false, transparent: true, alwaysOnTop: true, focusable: false, skipTaskbar: true });
    w.setIgnoreMouseEvents(true);
    w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<body style="margin:0;display:grid;place-items:center;height:100vh;font:900 30vh system-ui;color:#fff;text-shadow:0 0 40px #000;background:rgba(37,99,235,.35)">${i + 1}</body>`));
    setTimeout(() => !w.isDestroyed() && w.destroy(), 2500);
  }
}

function setGlobalClicker(on) {
  prefs.globalClicker = on;
  savePrefs();
  globalShortcut.unregisterAll();
  if (!on) return;
  // Télécommande active même si la régie n'a pas le focus (ex. opérateur sur un autre logiciel).
  const send = (type) => control?.webContents.executeJavaScript(`window.__presentorAction && window.__presentorAction(${JSON.stringify({ type })})`);
  globalShortcut.register('PageDown', () => send('next'));
  globalShortcut.register('PageUp', () => send('prev'));
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { label: 'Fichier', submenu: [
      { label: 'Ouvrir le dossier des médias', click: () => shell.openPath(path.join(app.getPath('userData'), 'data', 'media')) },
      { label: 'Ouvrir la régie dans le navigateur', click: () => shell.openExternal(server.url + '/control/') },
      { type: 'separator' }, isMac ? { role: 'close' } : { role: 'quit', label: 'Quitter' },
    ] },
    { role: 'editMenu', label: 'Édition' },
    { label: 'Diffusion', submenu: [
      { label: 'Identifier les écrans', click: identifyDisplays },
      { label: 'Fermer toutes les sorties', click: () => [...outputs.keys()].forEach((id) => closeOutput(id)) },
      { type: 'checkbox', label: 'Télécommande globale (PageUp/PageDown même hors focus)', checked: prefs.globalClicker, click: (i) => setGlobalClicker(i.checked) },
    ] },
    { role: 'viewMenu', label: 'Affichage' },
    { role: 'windowMenu', label: 'Fenêtre' },
  ]));
}

app.whenReady().then(async () => {
  loadPrefs();
  const { startServer } = await import(pathToFileURL(path.join(__dirname, '..', 'server', 'index.js')).href);
  const dataDir = path.join(app.getPath('userData'), 'data');
  // Port fixe pour que les liens (télécommande, sorties réseau) restent valides d'une session à l'autre.
  try { server = await startServer({ port: 4517, dataDir }); }
  catch { server = await startServer({ port: 0, dataDir }); }

  // Visio / sites web : autorise l'intégration même si le site l'interdit en iframe.
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    if (details.resourceType !== 'subFrame') return cb({});
    const headers = { ...details.responseHeaders };
    for (const k of Object.keys(headers)) {
      const l = k.toLowerCase();
      if (l === 'x-frame-options') delete headers[k];
      if (l === 'content-security-policy') headers[k] = headers[k].map((v) => v.replace(/frame-ancestors[^;]*;?/gi, ''));
    }
    cb({ responseHeaders: headers });
  });
  // Caméras, cartes d'acquisition, micro, plein écran : accordés sans popup.
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(['media', 'fullscreen', 'display-capture', 'clipboard-sanitized-write', 'wake-lock'].includes(perm)));
  session.defaultSession.setPermissionCheckHandler(() => true);

  powerSaveBlocker.start('prevent-display-sleep');

  ipcMain.handle('displays:list', () => displayList());
  ipcMain.handle('output:open', (e, id, displayId) => openOutput(id, displayId));
  ipcMain.handle('output:close', (e, id) => closeOutput(id));
  ipcMain.handle('displays:identify', () => identifyDisplays());
  ipcMain.handle('server:url', () => server.url);
  const notify = () => control?.webContents.send('displays:changed', displayList());
  screen.on('display-added', notify);
  screen.on('display-removed', (e, d) => {
    // Un projecteur débranché : on rapatrie sa sortie en fenêtre au lieu de la perdre.
    for (const [id, w] of outputs) if (prefs.outputs[id]?.displayId === d.id && !w.isDestroyed()) { w.setFullScreen(false); w.setAlwaysOnTop(false); w.setBounds({ width: 960, height: 540 }); w.center(); }
    notify();
  });
  screen.on('display-metrics-changed', notify);

  // PowerPoint natif (animations conservées) si PowerPoint est installé.
  server.store.native = await NativeDeck.create({ server, mediaDir: path.join(dataDir, 'media') });

  // Sorties publiées en NDI : suivies à chaque changement d'état (et à l'ouverture des fenêtres).
  ndiOut = new NdiOutputs({ server, getScreenWindow: (id) => outputs.get(id) });
  let ndiSyncT = null;
  const syncNdi = () => { clearTimeout(ndiSyncT); ndiSyncT = setTimeout(() => ndiOut.sync().catch(() => {}), 100); };
  server.store.onChange((st, kind) => { if (kind !== 'ndi' && kind !== 'votes') syncNdi(); });
  syncNdi();

  buildMenu();
  control = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1000, minHeight: 640, title: 'Presentor Manager', backgroundColor: '#0b0e14',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), backgroundThrottling: false, sandbox: false },
  });
  control.loadURL(server.url + '/control/');
  control.on('closed', () => { control = null; app.quit(); });
  control.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(server.url + '/output/')) return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, backgroundColor: '#000' } };
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Rouvre les sorties de la dernière session sur leurs écrans.
  const present = new Set(screen.getAllDisplays().map((d) => d.id));
  for (const [id, p] of Object.entries(prefs.outputs)) {
    if (p.open && (p.displayId == null || present.has(p.displayId))) openOutput(id, p.displayId);
  }
  if (prefs.globalClicker) setGlobalClicker(true);
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { ndiOut?.stopAll(); server?.store.save(); });
