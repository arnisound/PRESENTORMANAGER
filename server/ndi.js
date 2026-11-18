// NDI : chargement du module natif (optionnel) et découverte des sources du réseau.
// La réception d'image se fait dans les fenêtres de l'app desktop (preload),
// l'envoi (sorties publiées en NDI) dans le processus principal Electron.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let ndi = undefined;

export function loadNdi() {
  if (ndi !== undefined) return ndi;
  try { ndi = require('@stagetimerio/grandiose'); } catch { ndi = null; }
  return ndi;
}

// Recherche continue des sources. Le mDNS est souvent filtré sur les réseaux
// d'événement : on peut ajouter des IP à interroger directement (réglages).
export function startNdiDiscovery(store) {
  const g = loadNdi();
  store.state.ndi = { available: !!g, sources: [] };
  if (!g) return () => {};
  let finder = null, ipsKey = null, stopped = false;
  (async () => {
    while (!stopped) {
      const ips = String(store.state.settings.ndiExtraIps || '').split(/[\s,;]+/).filter(Boolean);
      const key = ips.join(',');
      try {
        if (!finder || key !== ipsKey) {
          await finder?.destroy();
          finder = await g.find({ showLocalSources: true, ...(ips.length ? { extraIPs: ips } : {}) });
          ipsKey = key;
        }
        await finder.wait(2000);
        // Une même source peut être vue par plusieurs interfaces : on dédoublonne par nom.
        const seen = new Map();
        for (const s of finder.sources()) if (!seen.has(s.name) || /^127\./.test(s.urlAddress)) seen.set(s.name, { name: s.name, urlAddress: s.urlAddress });
        const sources = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
        if (JSON.stringify(sources) !== JSON.stringify(store.state.ndi.sources)) {
          store.state.ndi = { available: true, sources };
          store.emit('ndi');
        }
      } catch (e) {
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  })();
  return () => { stopped = true; finder?.destroy(); };
}
