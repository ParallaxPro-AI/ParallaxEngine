/**
 * The HUD kit's built-in markup against the state its panels really produce: a headless
 * game with every widget runs a few frames, then each built-in HUD panel's markup is
 * sanitized (no scripts, styles kept), every bound key path is resolved in that panel's
 * state (inside `data-each`, against the first item), and the markup is bound with the
 * real binder on a minimal DOM.
 */

import { describe, expect, it } from 'vitest';
import type { ProjectFiles } from '../../../core/index.js';
import { HeadlessInput } from '../../../function/plugins/input/index.js';
import { loadProject } from '../../../resource/index.js';
import { combat, Health } from '../../../api/combat.js';
import { Abilities, hud, HudApi } from '../../../api/hud.js';
import { Actions, button } from '../../../api/input.js';
import { createRuntime, EntityRef, Game, kw, resetDeclarations, SceneRef } from '../../../api/index.js';
import { interaction } from '../../../api/interaction.js';
import { HeadlessAudio } from '../../headless/audio.js';
import { MemoryBinaryFiles, RecordingSurface3d } from '../../headless/render3d.js';
import { PanelBinding, resolvePath } from './binding.js';
import type { DomDocument, DomElement, DomNode } from './dom.js';
import { HUD_PANEL_MARKUP } from './hud_panels.js';
import { parseMarkup, sanitizePanel, urlResolver } from './markup.js';
import type { MarkupNode } from './markup.js';

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

/** Every panel's state from a game that shows every widget. */
function states(): Map<string, Record<string, unknown>> {
  resetDeclarations();
  class Controls extends Actions {
    static interact = button(kw({ keyboard: 'KeyE' }));
    static dash = button(kw({ keyboard: 'ShiftLeft' }));
  }
  Controls.__init_subclass__();
  const projectFiles = files({
    'prefabs/player.prefab.json': {
      components: {
        health: { current: 20, max: 100 }, minimap: { route: [[0, 0, 0], [0, 0, 10]] }, compass: {}, crosshair: { reload: 0.4 },
        stat_bars: { bars: [{ label: 'HP', value: 'health.current', max: 'health.max' }] },
        abilities: { slots: [{ id: 'dash', cooldown: 3, action: 'Controls.dash', charges: 2 }] }, combo: {},
        key_hints: { actions: ['Controls.interact'] }, hurt_feedback: {}, interactor: {},
      },
    },
    'prefabs/wall.prefab.json': { components: { shape: { kind: 'box', size: [6, 3, 1] } } },
    'prefabs/enemy.prefab.json': {
      components: {
        health: { current: 40, max: 50, destroy_on_death: false }, health_bar: { offset: [0, 2, 0] }, nameplate: {},
        map_icon: { icon: 'skull' }, awareness: { level: 0.6 }, marker: { label: 'Target' }, interactable: { prompt: 'Talk' },
      },
    },
    'prefabs/cam.prefab.json': { components: { camera: { rig: 'fixed' } } },
    'scenes/main/scene.json': {
      entities: [
        { prefab: 'player', id: 'player', at: [0, 0, 0] },
        { prefab: 'wall', at: [0, 1.5, 9] },
        { prefab: 'enemy', id: 'enemy', at: [0, 0, 2] },
        { prefab: 'cam', id: 'cam', at: [0, 1.6, -4], components: { camera: { follow: 'player' } } },
      ],
    },
  });
  const project = loadProject(projectFiles);
  expect(project.diagnostics).toEqual([]);
  const game = new Game(kw({
    id: 't', title: 'T', sdk: '1.0', start_scene: new SceneRef('main'), mode: '3d',
    plugins: [hud(), combat(), interaction(kw({ action: Controls.interact }))],
  }));
  const r = createRuntime(game, project, {
    seed: 1, devices: new HeadlessInput(), audio: new HeadlessAudio(), assets: null, files: projectFiles,
    surface3d: new RecordingSurface3d(), binary: new MemoryBinaryFiles({}),
  });
  r.start();
  r.step(1 / 60);
  const player = r.ctx.world.placed(new EntityRef('player'));
  const enemy = r.ctx.world.placed(new EntityRef('enemy'));
  (enemy.get(Health) as unknown as { damage(...a: unknown[]): unknown }).damage(5, kw({ source: player }));
  (enemy.get(Health) as unknown as { damage(...a: unknown[]): unknown }).damage(5, kw({ source: player }));
  (player.get(Health) as unknown as { damage(...a: unknown[]): unknown }).damage(5, kw({ source: enemy }));
  (player.get(Health) as unknown as { current: number }).current = 20;
  (player.get(Health) as unknown as { damage(...a: unknown[]): unknown }).damage(1, kw({ source: enemy }));
  (r.ctx as unknown as { hud: HudApi }).hud.ping(enemy, kw({ kind: 'enemy' }));
  (player.get(Abilities) as unknown as { use(s: string): boolean }).use('dash');
  r.step(1 / 60);
  r.step(1 / 60);
  const out = new Map<string, Record<string, unknown>>();
  for (const open of r.uiEngine.openPanels) out.set(open.decl.html, r.uiEngine.view(open.decl)!.states[0] as Record<string, unknown>);
  return out;
}

const KEY_PREFIXES = ['data-class-', 'data-attr-', 'data-style-'];
const KEY_ATTRS = ['data-bind', 'data-show', 'data-hide', 'data-each'];

/** Bound key paths that don't resolve in `state` (data-each: checked against its first item). */
function unresolved(nodes: readonly MarkupNode[], state: unknown, out: string[] = [], where = ''): string[] {
  for (const node of nodes) {
    if (node.kind !== 'element') continue;
    let scope = state;
    let skip = false;
    for (const [name, value] of node.attrs) {
      if (!KEY_ATTRS.includes(name) && !KEY_PREFIXES.some((p) => name.startsWith(p))) continue;
      if (resolvePath(state, value) === undefined) out.push(`${where}${name}="${value}"`);
      if (name === 'data-each') {
        const list = resolvePath(state, value);
        if (Array.isArray(list) && list.length > 0) scope = list[0];
        else skip = true;
      }
    }
    const each = node.attrs.some(([n]) => n === 'data-each');
    if (each) {
      if (!skip) {
        const template = node.children.find((c) => c.kind === 'element' && c.tag === 'template');
        if (template !== undefined && template.kind === 'element') unresolved(template.children, scope, out, `${where}${node.tag}>`);
      }
      continue;
    }
    unresolved(node.children, scope, out, `${where}${node.tag}>`);
  }
  return out;
}

class El implements DomElement {
  parentNode: El | null = null;
  textContent: string | null = '';
  readonly tagName: string;
  readonly attrs = new Map<string, string>();
  readonly styles = new Map<string, string>();
  readonly kids: DomNode[] = [];
  readonly classList = { toggle: (_t: string, force?: boolean): boolean => force ?? true };
  readonly style = {
    setProperty: (n: string, v: string): void => { this.styles.set(n, v); },
    removeProperty: (n: string): string => { this.styles.delete(n); return ''; },
  };
  constructor(tag: string) { this.tagName = tag.toUpperCase(); }
  getAttribute(n: string): string | null { return this.attrs.get(n) ?? null; }
  getAttributeNames(): string[] { return [...this.attrs.keys()]; }
  setAttribute(n: string, v: string): void { this.attrs.set(n, v); }
  removeAttribute(n: string): void { this.attrs.delete(n); }
  appendChild<T extends DomNode>(node: T): T { return this.insertBefore(node, null); }
  insertBefore<T extends DomNode>(node: T, before: DomNode | null): T {
    const at = before === null ? -1 : this.kids.indexOf(before);
    if (at < 0) this.kids.push(node); else this.kids.splice(at, 0, node);
    (node as unknown as { parentNode: El }).parentNode = this;
    return node;
  }
  remove(): void {
    const p = this.parentNode;
    if (p !== null) p.kids.splice(p.kids.indexOf(this), 1);
  }
  *all(): Generator<El> { for (const k of this.kids) if (k instanceof El) { yield k; yield* k.all(); } }
}

const doc: DomDocument = {
  createElement: (tag) => new El(tag),
  createElementNS: (_ns, tag) => new El(tag),
  createTextNode: (text) => ({ parentNode: null, textContent: text, remove() {} }),
};

describe('HUD panel markup', () => {
  const byHtml = states();

  it('every built-in HUD panel opened in a game that shows every widget', () => {
    expect([...byHtml.keys()].filter((h) => h.startsWith('builtin:hud/')).sort()).toEqual(Object.keys(HUD_PANEL_MARKUP).sort());
  });

  for (const [html, source] of Object.entries(HUD_PANEL_MARKUP)) {
    it(`${html}: sanitizes cleanly and binds only keys its state has`, () => {
      const panel = sanitizePanel(parseMarkup(source), urlResolver('', (p) => `/p/${p}`), (css) => css);
      expect(panel.scripts).toEqual([]);
      expect(panel.styles).toHaveLength(1);
      const state = byHtml.get(html)!;
      expect(state['shown']).toBe(true);
      expect(unresolved(panel.nodes, state)).toEqual([]);
      const root = new El('div');
      const binding = new PanelBinding(doc, panel.nodes, root, { url: urlResolver('', (p) => `/p/${p}`), style: (css) => css });
      binding.update({ state, values: { text: (v) => (v === null || v === undefined ? '' : String(v)), truthy: (v) => Boolean(v) && !(Array.isArray(v) && v.length === 0) }, strings: {}, enabled: {} });
      if (html === 'builtin:hud/minimap.html') {
        const img = [...root.all()].find((e) => e.tagName === 'IMG')!;
        expect(img.attrs.get('src')).toMatch(/^data:image\/svg\+xml/);
        expect(img.styles.get('width')).toMatch(/%$/);
      }
      if (html === 'builtin:hud/crosshair.html') {
        expect([...root.all()].some((e) => e.styles.get('--gap')?.endsWith('px') === true)).toBe(true);
      }
    });
  }
});
