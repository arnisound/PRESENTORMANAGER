// PowerPoint natif : l'app pilote PowerPoint lui-même (animations, transitions,
// vidéos et builds conservés à 100 %) et capture la fenêtre du diaporama pour
// la diffuser comme n'importe quelle source, sur toutes les sorties.
//   Windows : automatisation COM via un processus PowerShell persistant.
//   macOS   : AppleScript (Microsoft PowerPoint pour Mac).
const { desktopCapturer } = require('electron');
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// --------------------------------------------------------------- Windows
const PS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$app = $null; $pres = $null; $first = 1; $last = 1
function Send($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress)); [Console]::Out.Flush() }
function State($extra) {
  $v = $pres.SlideShowWindow.View
  $o = @{ ok = $true; slide = $v.Slide.SlideIndex; click = $v.GetClickIndex(); clicks = $v.GetClickCount(); total = $pres.Slides.Count; title = $pres.SlideShowWindow.Caption }
  if ($extra) { foreach ($k in $extra.Keys) { $o[$k] = $extra[$k] } }
  Send $o
}
while (($line = [Console]::In.ReadLine()) -ne $null) {
  try {
    $c = $line | ConvertFrom-Json
    switch ($c.op) {
      'open' {
        if (-not $app) { $app = New-Object -ComObject PowerPoint.Application }
        if ($pres) { try { $pres.Close() } catch {} }
        $pres = $app.Presentations.Open($c.path, -1, 0, 0)
        $vis = @(); foreach ($sl in $pres.Slides) { if ($sl.SlideShowTransition.Hidden -eq 0) { $vis += $sl.SlideIndex } }
        if ($vis.Count) { $first = $vis[0]; $last = $vis[-1] }
        $s = $pres.SlideShowSettings
        $s.ShowType = 2            # fenêtre (capturable), pas plein écran
        $s.ShowPresenterView = 0
        $s.LoopUntilStopped = 0
        $w = $s.Run()
        $w.Width = $c.width; $w.Height = $c.height; $w.Left = $c.left; $w.Top = $c.top
        if ($c.slide -gt 1) { $w.View.GotoSlide([int]$c.slide) }
        State $null
      }
      'next' {
        $v = $pres.SlideShowWindow.View
        if ($v.State -eq 5 -or ($v.Slide.SlideIndex -ge $last -and $v.GetClickIndex() -ge $v.GetClickCount())) { State @{ ended = $true } }
        else { $v.Next(); State $null }
      }
      'prev' {
        $v = $pres.SlideShowWindow.View
        if ($v.Slide.SlideIndex -le $first -and $v.GetClickIndex() -le 0) { State @{ begin = $true } }
        else { $v.Previous(); State $null }
      }
      'goto' { $pres.SlideShowWindow.View.GotoSlide([int]$c.n); State $null }
      'status' { State $null }
      'close' { if ($pres) { try { $pres.SlideShowWindow.View.Exit() } catch {}; $pres.Close(); $pres = $null }; Send @{ ok = $true } }
    }
  } catch { Send @{ ok = $false; error = $_.Exception.Message } }
}
`;

class WindowsDriver {
  constructor() { this.name = 'PowerPoint (Windows)'; this.queue = []; this.buf = ''; }
  static detect() {
    return new Promise((res) => execFile('reg', ['query', 'HKCR\\PowerPoint.Application'], { windowsHide: true }, (err) => res(!err)));
  }
  ensure() {
    if (this.ps && !this.ps.killed) return;
    const file = path.join(os.tmpdir(), 'presentor-ppt.ps1');
    fs.writeFileSync(file, PS_SCRIPT);
    this.ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { windowsHide: true });
    this.ps.stdout.setEncoding('utf8');
    this.ps.stdout.on('data', (d) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        const cb = this.queue.shift();
        try { cb?.resolve(JSON.parse(line)); } catch { cb?.resolve({ ok: false, error: line }); }
      }
    });
    this.ps.on('exit', () => { for (const cb of this.queue.splice(0)) cb.resolve({ ok: false, error: 'PowerPoint ne répond plus' }); this.ps = null; });
  }
  cmd(o) {
    this.ensure();
    return new Promise((resolve) => { this.queue.push({ resolve }); this.ps.stdin.write(JSON.stringify(o) + '\n'); });
  }
  // Largeur / hauteur en points (1 pt = 1,333 px à 96 ppp).
  open(file, slide) { return this.cmd({ op: 'open', path: file, slide, width: 960, height: 540, left: 0, top: 0 }); }
  next() { return this.cmd({ op: 'next' }); }
  prev() { return this.cmd({ op: 'prev' }); }
  goto(n) { return this.cmd({ op: 'goto', n }); }
  close() { return this.cmd({ op: 'close' }); }
  windowMatch(name, base) { return name.includes(base) || /Diaporama PowerPoint|PowerPoint Slide Show/i.test(name); }
}

// --------------------------------------------------------------- macOS
const osa = (script) => new Promise((res) => execFile('osascript', ['-e', script], { timeout: 20000 }, (err, out) => res(err ? { error: err.message } : { out: String(out).trim() })));
const PPT = 'tell application "Microsoft PowerPoint"';

class MacDriver {
  constructor() { this.name = 'PowerPoint (Mac)'; }
  static detect() { return Promise.resolve(fs.existsSync('/Applications/Microsoft PowerPoint.app')); }
  async state(extra = {}) {
    const r = await osa(`${PPT}
      set v to slide show view of slide show window 1
      return ((slide index of slide of v) as text) & "|" & ((count of slides of active presentation) as text) & "|" & ((slide state of v) as text)
    end tell`);
    if (r.error) return { ok: false, error: r.error };
    const [slide, total, st] = r.out.split('|');
    return { ok: true, slide: +slide, total: +total, done: /done/i.test(st), click: 0, clicks: 0, ...extra };
  }
  async open(file, slide) {
    // PowerPoint pour Mac est "bac à sable" : on copie le fichier dans son conteneur
    // pour éviter la demande d'autorisation d'accès au fichier.
    const box = path.join(os.homedir(), 'Library', 'Group Containers', 'UBF8T346G9.Office', 'Presentor');
    let target = file;
    try { fs.mkdirSync(box, { recursive: true }); target = path.join(box, path.basename(file)); fs.copyFileSync(file, target); } catch { target = file; }
    const r = await osa(`${PPT}
      open POSIX file "${target.replace(/"/g, '\\"')}"
      set p to active presentation
      set show type of slide show settings of p to slide show type window
      run slide show slide show settings of p
    end tell`);
    if (r.error) return { ok: false, error: r.error };
    await new Promise((res) => setTimeout(res, 800));
    if (slide > 1) await this.goto(slide);
    return this.state();
  }
  async next() {
    const before = await this.state();
    if (!before.ok) return before;
    if (before.done) return { ...before, ended: true };
    await osa(`${PPT} to go to next slide (slide show view of slide show window 1)`);
    const after = await this.state();
    // AppleScript ne donne pas les clics d'animation : la fin est détectée par l'état "terminé".
    return after.done ? { ...after, ended: true } : after;
  }
  async prev() {
    const before = await this.state();
    if (!before.ok) return before;
    await osa(`${PPT} to go to previous slide (slide show view of slide show window 1)`);
    const after = await this.state();
    return before.slide === 1 && after.slide === 1 ? { ...after, begin: true } : after;
  }
  async goto(n) { await osa(`${PPT} to go to slide (slide show view of slide show window 1) number ${Math.max(1, n | 0)}`); return this.state(); }
  async close() { await osa(`${PPT} to close active presentation saving no`); return { ok: true }; }
  windowMatch(name, base) { return name.includes(base) || /Slide Show|Diaporama/i.test(name); }
}

// --------------------------------------------------------------- contrôleur
class NativeDeck {
  constructor({ server, mediaDir, driver }) {
    this.server = server;
    this.mediaDir = mediaDir;
    this.driver = driver;
    this.available = !!driver;
    this.chain = Promise.resolve();
    this.openMediaId = null;
  }

  static async create(opts) {
    let driver = null;
    if (process.env.PRESENTOR_PPT_DRIVER) driver = new (require(path.resolve(process.env.PRESENTOR_PPT_DRIVER)))(opts);
    else if (process.platform === 'win32' && (await WindowsDriver.detect())) driver = new WindowsDriver();
    else if (process.platform === 'darwin' && (await MacDriver.detect())) driver = new MacDriver();
    const deck = new NativeDeck({ ...opts, driver });
    const st = opts.server.store.state;
    st.nativeInfo = { available: !!driver, app: driver?.name || null };
    opts.server.store.emit('native');
    return deck;
  }

  sourceFile(cue) {
    const m = this.server.store.state.media.find((x) => x.id === cue.mediaId);
    const file = m?.source && /\.(pptx|ppt|pps|ppsx)$/i.test(m.source) ? m.source : null;
    return file ? path.join(this.mediaDir, file) : null;
  }

  handles(cue) { return this.available && cue?.type === 'slides' && cue.engine === 'powerpoint' && !!this.sourceFile(cue); }

  // Toutes les commandes passent dans une file : PowerPoint n'aime pas les appels concurrents.
  run(fn) { this.chain = this.chain.then(fn).catch((e) => console.warn('PowerPoint:', e)); return this.chain; }

  show(cue, slide = 1) { return this.run(() => this.doShow(cue, slide)); }

  // Version non mise en file (appelée depuis une commande déjà en cours).
  async doShow(cue, slide) {
    const file = this.sourceFile(cue);
    let st;
    if (this.openMediaId !== cue.mediaId) {
      st = await this.driver.open(file, slide);
      this.openMediaId = st.ok ? cue.mediaId : null;
      // La fenêtre à capturer est recherchée en arrière-plan : la télécommande reste réactive.
      if (st.ok) this.locate(cue, file);
    } else {
      st = await this.driver.goto(slide);
    }
    this.report(cue, st);
  }

  step(cue, dir) {
    return this.run(async () => {
      if (this.openMediaId !== cue.mediaId) return this.doShow(cue, 1);
      this.report(cue, dir > 0 ? await this.driver.next() : await this.driver.prev());
    });
  }

  goto(cue, n) {
    return this.run(async () => {
      if (this.openMediaId !== cue.mediaId) return this.doShow(cue, n);
      this.report(cue, await this.driver.goto(n));
    });
  }

  locate(cue, file) {
    const token = (this.locateToken = (this.locateToken || 0) + 1);
    this.findWindow(file).then((sourceId) => {
      if (token !== this.locateToken) return;
      this.report(cue, { ...this.last, sourceId, error: sourceId ? null : 'Fenêtre du diaporama introuvable pour la capture (autorisation d\'enregistrement d\'écran ?)' });
    });
  }

  // Retrouve la fenêtre du diaporama parmi les fenêtres capturables.
  async findWindow(file) {
    const base = path.basename(file, path.extname(file));
    for (let i = 0; i < 12; i++) {
      const list = await Promise.race([
        desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } }),
        new Promise((r) => setTimeout(() => r([]), 3000)),
      ]);
      const hit = list.find((s) => s.name.includes(base)) || list.find((s) => this.driver.windowMatch(s.name, base));
      if (hit) return hit.id;
      await new Promise((r) => setTimeout(r, 200));
    }
    return null;
  }

  report(cue, st) {
    if (st?.ok !== false) this.last = { ...st, ended: false, begin: false };
    this.server.store.dispatch({ type: 'native.status', cueId: cue.id, ...(st || {}), error: st?.ok === false ? st.error || 'erreur PowerPoint' : null }, 'system');
  }
}

module.exports = { NativeDeck };
