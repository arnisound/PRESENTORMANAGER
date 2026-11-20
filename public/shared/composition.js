// Rendu de la composition : les calques actifs sont empilés (calque 1 en bas)
// et mélangés en temps réel — opacité, mode de fusion, transformation, effets,
// masque. Chaque calque garde le rendu "sans coupure" (préparation puis fondu).
import { Stage, describe, effectsCss, transformCss, MASK_CSS, clipGain, masterGain } from './renderer.js';

export class CompositionView {
  /**
   * opts : client, audio, monitor, reportEnded,
   *        only (id d'un calque à isoler), overlays (bandeau + habillages),
   *        outputId (sortie affichée : reçoit aussi les calques routés vers elle),
   *        aux (n'affiche QUE les calques routés vers cette sortie)
   */
  constructor(root, opts = {}) {
    this.root = root;
    this.opts = opts;
    root.classList.add('comp');
    this.layersEl = document.createElement('div');
    this.layersEl.className = 'comp-layers';
    this.black = document.createElement('div');
    this.black.className = 'comp-black';
    root.append(this.layersEl);
    this.layers = new Map(); // layerId -> { el, stage }
    if (opts.overlays) {
      const ov = document.createElement('div');
      ov.className = 'comp-overlay';
      root.append(ov);
      this.overlay = new Stage(ov, { ...opts, transparent: true, reportEnded: false });
    }
    root.append(this.black);
  }

  update(state) {
    this.state = state;
    const comp = state.comp;
    if (!comp) return;
    const live = state.live.comp || { active: {} };
    const solo = comp.layers.some((l) => l.solo);
    // Routage : un calque va dans la composition principale et/ou sur des sorties précises (AUX).
    const routed = (l) => (l.auxOutputs || []).includes(this.opts.outputId);
    const list = this.opts.only ? comp.layers.filter((l) => l.id === this.opts.only)
      : this.opts.aux ? comp.layers.filter(routed)
      : comp.layers.filter((l) => l.mainOut !== false || routed(l));
    for (const [id, l] of this.layers) if (!list.some((x) => x.id === id)) { l.stage.destroy(); l.el.remove(); this.layers.delete(id); }
    list.forEach((layer, i) => {
      let L = this.layers.get(layer.id);
      if (!L) {
        const el = document.createElement('div');
        el.className = 'comp-layer';
        this.layersEl.append(el);
        const id = layer.id;
        const cur = () => this.state.comp.layers.find((x) => x.id === id) || layer;
        const lc = () => this.state.live.comp || {};
        L = {
          el,
          stage: new Stage(el, {
            ...this.opts,
            transparent: true,
            clipStyle: true,
            compLayer: id,
            transitionMs: () => cur().transitionMs || 0,
            transitionSpec: () => cur().transition,
            volumeFor: () => clipGain(cur()) * masterGain(this.state.settings),
            playbackFor: () => lc().pb?.[id] || null,
            slideAtFor: (cueId) => lc().slideAt?.[cueId],
          }),
        };
        this.layers.set(layer.id, L);
      }
      const hidden = !this.opts.only && (layer.bypass || (solo && !layer.solo));
      const fx = effectsCss(layer.effects);
      Object.assign(L.el.style, {
        zIndex: i + 1,
        opacity: hidden ? 0 : (layer.opacity ?? 1) * (this.opts.only ? 1 : comp.master ?? 1),
        mixBlendMode: layer.blend || 'normal',
        transform: transformCss(layer.transform, fx.transform),
        filter: fx.filter,
        clipPath: MASK_CSS[layer.mask] || '',
      });
      const cueId = live.active?.[layer.id];
      const desc = cueId ? describe(state, { cueId, slide: live.slides?.[cueId] || 1 }) : { key: 'none', type: 'black' };
      L.stage.update(state, desc);
    });
    // L'ordre DOM suit l'ordre des calques (le mode de fusion dépend de ce qui est dessous).
    // Ne déplace les éléments que si l'ordre a changé : déplacer une page web ou une
    // visio intégrée dans le document la recharge.
    const want = list.map((l) => this.layers.get(l.id).el);
    const have = [...this.layersEl.children];
    if (want.some((el, i) => have[i] !== el)) want.forEach((el, i) => { if (this.layersEl.children[i] !== el) this.layersEl.insertBefore(el, this.layersEl.children[i] || null); });
    if (this.overlay) this.overlay.update(state, { key: 'none', type: 'black' }, state.live.overlay, state.live.blackout ? null : state.live.overlayScenes);
    this.black.classList.toggle('on', !!state.live.blackout && !this.opts.only);
  }

  destroy() { for (const l of this.layers.values()) l.stage.destroy(); this.overlay?.destroy(); }
}

// Présentation pilotée par la télécommande : diapo en cours, suivante, notes.
export function deckInfo(state) {
  const lc = state?.live?.comp;
  if (!lc?.deck || !Object.values(lc.active || {}).includes(lc.deck)) return null;
  const cue = state.cues.find((c) => c.id === lc.deck);
  if (!cue) return null;
  const media = cue.mediaId ? state.media.find((m) => m.id === cue.mediaId) : null;
  const slide = lc.slides?.[cue.id] || 1;
  const pages = media?.pages || 1;
  const notes = [cue.notes, media?.notes?.[slide - 1]].filter(Boolean).join('\n\n');
  return { cue, slide, pages, next: slide < pages ? slide + 1 : null, notes };
}
