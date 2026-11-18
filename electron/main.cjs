// Application Mac / PC : embarque le serveur, ouvre la régie, et pilote les
// sorties plein écran sur chaque écran physique (projecteur, retour, régie…).
const { app, BrowserWindow, screen, ipcMain, session, powerSaveBlocker, Menu, shell, globalShortcut, desktopCapturer } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { NdiOutputs } = require('./ndi-out.cjs');
const { NativeDeck } = require('./ppt.cjs');

app.setName('PresenThor');
const ICON = path.join(__dirname, '..', 'public', 'brand', 'logo-512.png');
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
    icon: ICON,
    backgroundColor: '#000000',
    show: false,
    autoHideMenuBar: true,
    ...(display ? { x: display.bounds.x + 40, y: display.bounds.y + 40, width: 960, height: 540 } : { width: 960, height: 540 }),
    // sandbox désactivé : le preload charge le module natif NDI.
    webPreferences: { backgroundThrottling: false, sandbox: false, webviewTag: true, preload: path.join(__dirname, 'preload.cjs') },
  });
  win.loadURL(`${server.url}/output/?id=${encodeURIComponent(outputId)}`);
  win.outputDisplayId = display ? display.id : null;
  win.once('ready-to-show', () => {
    win.show();
    if (display) setOutputFullscreen(win, true);
  });
  win.on('closed', () => { if (outputs.get(outputId) === win) outputs.delete(outputId); });
  win.webContents.once('did-finish-load', () => ndiOut?.sync().catch(() => {}));
  outputs.set(outputId, win);
  prefs.outputs[outputId] = { displayId: display ? display.id : null, open: true };
  savePrefs();
}

// Plein écran d'une sortie. Échap / double-clic dans la sortie, ou Ctrl+Alt+F
// (⌘+Alt+F) partout, la remettent en fenêtre. Sur l'écran de la régie, la sortie
// n'est jamais forcée au premier plan : on garde toujours la main.
function setOutputFullscreen(win, on) {
  if (!win || win.isDestroyed()) return;
  const display = screen.getAllDisplays().find((d) => d.id === win.outputDisplayId) || screen.getDisplayMatching(win.getBounds());
  const ctrlDisplay = control && !control.isDestroyed() ? screen.getDisplayMatching(control.getBounds()) : null;
  if (on) {
    win.setBounds(display.bounds);
    if (process.platform === 'darwin') win.setSimpleFullScreen(true); // pas de « Space » séparé
    else win.setFullScreen(true);
    win.setAlwaysOnTop(ctrlDisplay?.id !== display.id, 'screen-saver');
  } else {
    win.setAlwaysOnTop(false);
    if (process.platform === 'darwin') win.setSimpleFullScreen(false);
    else win.setFullScreen(false);
    const b = display.workArea;
    win.setBounds({ x: b.x + Math.round((b.width - 960) / 2), y: b.y + Math.round((b.height - 540) / 2), width: 960, height: 540 });
  }
  win.webContents.send('output:fullscreen', on);
}
const isOutputFullscreen = (win) => (process.platform === 'darwin' ? win.isSimpleFullScreen() : win.isFullScreen());

function exitAllFullscreen() {
  for (const w of outputs.values()) if (!w.isDestroyed() && isOutputFullscreen(w)) setOutputFullscreen(w, false);
  control?.show();
  control?.focus();
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
  for (const k of ['PageDown', 'PageUp']) if (globalShortcut.isRegistered(k)) globalShortcut.unregister(k);
  if (!on) return;
  // Télécommande active même si la régie n'a pas le focus (ex. opérateur sur un autre logiciel).
  const send = (type) => control?.webContents.executeJavaScript(`window.__presenthorAction && window.__presenthorAction(${JSON.stringify({ type })})`);
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
      { label: 'Quitter le plein écran des sorties', accelerator: 'CommandOrControl+Alt+F', click: exitAllFullscreen },
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
  const allowPerms = (ses) => {
    ses.setPermissionRequestHandler((wc, perm, cb) => cb(['media', 'fullscreen', 'display-capture', 'clipboard-sanitized-write', 'wake-lock', 'notifications'].includes(perm)));
    ses.setPermissionCheckHandler(() => true);
  };
  allowPerms(session.defaultSession);
  // Pages web / visio : session dédiée et persistante (les connexions sont mémorisées).
  const webSession = session.fromPartition('persist:presenthor-web');
  allowPerms(webSession);
  webSession.setUserAgent(webSession.getUserAgent().replace(/\s*(Electron|presenthor)\/[^\s]+/gi, ''));
  app.on('web-contents-created', (e, wc) => {
    // Sécurité des pages intégrées : pas d'accès à Node, pas de preload.
    wc.on('will-attach-webview', (ev, prefs) => { delete prefs.preload; prefs.nodeIntegration = false; prefs.contextIsolation = true; });
    // Les pages web ouvrent leurs liens "nouvelle fenêtre" dans le navigateur du système.
    if (wc.getType() === 'webview') wc.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  });

  powerSaveBlocker.start('prevent-display-sleep');

  ipcMain.handle('displays:list', () => displayList());
  ipcMain.handle('output:open', (e, id, displayId) => openOutput(id, displayId));
  ipcMain.handle('output:close', (e, id) => closeOutput(id));
  ipcMain.handle('output:fullscreen', (e, mode, id) => {
    const win = id ? outputs.get(id) : BrowserWindow.fromWebContents(e.sender);
    if (!win || ![...outputs.values()].includes(win)) return false;
    const on = mode === 'toggle' ? !isOutputFullscreen(win) : mode === 'on';
    if (on && win.outputDisplayId == null) win.outputDisplayId = screen.getDisplayMatching(win.getBounds()).id;
    setOutputFullscreen(win, on);
    return on;
  });
  ipcMain.handle('outputs:state', () => Object.fromEntries([...outputs].map(([id, w]) => [id, { open: !w.isDestroyed(), fullscreen: !w.isDestroyed() && isOutputFullscreen(w) }])));
  // Toujours disponible, même si une sortie plein écran recouvre tout.
  globalShortcut.register('CommandOrControl+Alt+F', exitAllFullscreen);
  ipcMain.handle('displays:identify', () => identifyDisplays());
  ipcMain.handle('server:url', () => server.url);
  // Fenêtres et écrans capturables (source « Fenêtre / écran »).
  ipcMain.handle('capture:sources', async (e, withThumbs) => {
    const list = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: withThumbs ? { width: 320, height: 180 } : { width: 0, height: 0 } });
    const own = new Set(BrowserWindow.getAllWindows().map((w) => w.getMediaSourceId?.()));
    return list.filter((x) => !own.has(x.id)).map((x) => ({ id: x.id, name: x.name, screen: x.id.startsWith('screen:'), thumb: withThumbs ? x.thumbnail.toDataURL() : null }));
  });
  // Identifiant de capture d'une sortie (retour vidéo envoyé aux invités de la visio).
  ipcMain.handle('output:media-source', (e, id) => outputs.get(id)?.getMediaSourceId?.() || null);
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

  app.setAboutPanelOptions({ applicationName: 'PresenThor', applicationVersion: app.getVersion(), iconPath: ICON, copyright: 'PresenThor' });
  if (process.platform === 'darwin') app.dock?.setIcon(ICON);
  buildMenu();
  control = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1000, minHeight: 640, title: 'PresenThor', backgroundColor: '#0a0a0b', icon: ICON,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), backgroundThrottling: false, sandbox: false, webviewTag: true },
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
