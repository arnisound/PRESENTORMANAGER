// Faux pilote PowerPoint pour les tests (PRESENTOR_PPT_DRIVER=test/fake-ppt-driver.cjs) :
// une fenêtre "PowerPoint Slide Show - fichier" avec 2 étapes d'animation par diapo.
const { BrowserWindow } = require('electron');
const path = require('node:path');

const CLICKS = 2;
module.exports = class FakeDriver {
  constructor() { this.name = 'PowerPoint (simulé)'; this.slide = 1; this.click = 0; this.total = 3; }
  async render() {
    const colors = ['#1d4ed8', '#be123c', '#15803d'];
    const html = `<body style="margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;background:${colors[(this.slide - 1) % 3]};color:#fff;font:700 64px system-ui">
      <div>Diapo ${this.slide}</div>${Array.from({ length: this.click }, (_, i) => `<div style="font-size:40px">Animation ${i + 1}</div>`).join('')}</body>`;
    await this.win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    this.win.setTitle(this.title);
  }
  state(extra = {}) { return { ok: true, slide: this.slide, click: this.click, clicks: CLICKS, total: this.total, ...extra }; }
  async open(file, slide) {
    this.title = 'PowerPoint Slide Show - ' + path.basename(file);
    this.win = new BrowserWindow({ width: 960, height: 540, x: 600, y: 300, title: this.title, show: true, autoHideMenuBar: true });
    this.win.on('page-title-updated', (e) => e.preventDefault());
    this.slide = slide || 1; this.click = 0;
    await this.render();
    return this.state();
  }
  async next() {
    if (this.slide >= this.total && this.click >= CLICKS) return this.state({ ended: true });
    if (this.click < CLICKS) this.click++; else { this.slide++; this.click = 0; }
    await this.render();
    return this.state();
  }
  async prev() {
    if (this.slide <= 1 && this.click <= 0) return this.state({ begin: true });
    if (this.click > 0) this.click--; else { this.slide--; this.click = CLICKS; }
    await this.render();
    return this.state();
  }
  async goto(n) { this.slide = Math.max(1, Math.min(this.total, n)); this.click = 0; await this.render(); return this.state(); }
  async close() { this.win?.destroy(); return { ok: true }; }
  windowMatch(name) { return name.startsWith('PowerPoint Slide Show'); }
};
