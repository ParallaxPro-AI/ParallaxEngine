/**
 * `parallax.hud` the way a game uses it: components in prefab JSON, `plugins.hud()`, the
 * built-in HUD panels opening by themselves (their `when=`), each panel's per-seat state,
 * combat's Damaged / Died driving hit markers, hurt flashes, damage arcs and combos,
 * ability cooldowns, key hints from the declared actions (remaps and devices), slow
 * motion with its snapshot, and accessibility settings.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { ParallaxError } from '../core/index.js';
import type { ProjectFiles } from '../core/index.js';
import { HeadlessInput } from '../function/plugins/input/index.js';
import { HeadlessAudio } from '../platform/headless/audio.js';
import { MemoryBinaryFiles, RecordingSurface3d } from '../platform/headless/render3d.js';
import { RecordingSurface2d } from '../platform/headless/render.js';
import { loadProject } from '../resource/index.js';
import { combat, Health } from './combat.js';
import { ai } from './ai.js';
import { Color, Vec3 } from '../core/index.js';
import {
  Abilities, AbilityBarPanel, Combo, CrosshairPanel, hud, HudApi, KeyHintsPanel, MapIcon, MinimapPanel, StatBars,
} from './hud.js';
import { Actions, button, keys } from './input.js';
import { createRuntime, EntityRef, Game, kw, resetDeclarations, SceneRef } from './index.js';
import type { GameRuntime } from './index.js';
import { PyDict } from './pyrt/collections.js';
import { builtinPanels, registeredPanels, ui } from './ui.js';

const STEP = 1 / 60;

beforeEach(() => resetDeclarations());

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

function code(fn: () => unknown): string | undefined {
  try { fn(); } catch (e) { if (e instanceof ParallaxError) return e.diagnostic.code; throw e; }
  return undefined;
}

interface Rig {
  readonly r: GameRuntime;
  readonly input: HeadlessInput;
  state(panel: string, seat?: number): Record<string, unknown>;
  open(): string[];
  step(frames?: number): void;
}

function run(data: Record<string, unknown>, plugins: unknown[], mode: '2d' | '3d' = '3d'): Rig {
  const projectFiles = files(data);
  const project = loadProject(projectFiles);
  expect(project.diagnostics).toEqual([]);
  const game = new Game(kw({ id: 'test', title: 'Test', sdk: '1.0', start_scene: new SceneRef('main'), mode, plugins }));
  const input = new HeadlessInput();
  const r = createRuntime(game, project, {
    seed: 1, devices: input, audio: new HeadlessAudio(), assets: null, files: projectFiles,
    ...(mode === '3d' ? { surface3d: new RecordingSurface3d(), binary: new MemoryBinaryFiles({}) } : { surface: new RecordingSurface2d() }),
  });
  r.start();
  const rig: Rig = {
    r, input,
    state: (panel, seat = 0) => {
      const view = r.uiEngine.view(panel);
      if (view === undefined) throw new Error(`${panel} is not open (open: ${rig.open().join(', ')})`);
      return view.states[seat] as Record<string, unknown>;
    },
    open: () => r.uiEngine.openPanels.map((p) => p.decl.id),
    step: (frames = 1) => { for (let i = 0; i < frames; i++) r.step(STEP); },
  };
  rig.step();
  return rig;
}

const PLAYER = {
  components: {
    shape: { kind: 'capsule', size: [0.8, 1.8, 0.8] },
    health: { current: 100, max: 100 },
    minimap: { range: 20, rotate: false },
    compass: {},
    crosshair: { style: 'cross', spread: 2 },
    stat_bars: { bars: [{ label: 'HP', value: 'health.current', max: 'health.max' }, { label: 'XP', value: 'xp.fraction' }] },
    abilities: { slots: [{ id: 'dash', cooldown: 2, action: 'Controls.dash', icon: '»' }, { id: 'heal', cooldown: 1, charges: 2 }] },
    combo: { window: 1 },
    key_hints: { actions: ['Controls.jump', 'Controls.dash'] },
    hurt_feedback: { flash: 0.8, shake: 0, hitstop: 0.05, low_health: 0.3 },
    xp: { fraction: 0.4 },
  },
};

function scene(extra: unknown[] = []): Record<string, unknown> {
  return {
    'prefabs/player.prefab.json': PLAYER,
    'prefabs/wall.prefab.json': { components: { shape: { kind: 'box', size: [10, 3, 1], color: '#ff0000' } } },
    'prefabs/floor.prefab.json': { components: { shape: { kind: 'plane', size: [60, 1, 60] } } },
    'prefabs/enemy.prefab.json': {
      components: {
        shape: { kind: 'box', size: [1, 2, 1] }, health: { current: 50, max: 50, destroy_on_death: false }, health_bar: { offset: [0, 2.2, 0], width: 80, border: '#ffffff' },
        nameplate: { text: 'Goblin' }, map_icon: { icon: 'skull', color: '#ff4040', edge: true }, awareness: { level: 0.5 },
        rigidbody: {},
      },
    },
    'prefabs/flag.prefab.json': { components: { marker: { icon: 'flag', label: 'Goal' } } },
    'prefabs/camera.prefab.json': { components: { camera: { rig: 'fixed', fov: 60 } } },
    'scenes/main/scene.json': {
      entities: [
        { prefab: 'floor', id: 'floor' },
        { prefab: 'wall', id: 'wall', at: [0, 1.5, 8] },
        { prefab: 'player', id: 'player', at: [0, 1, 0] },
        { prefab: 'enemy', id: 'enemy', at: [0, 1, 6] },
        { prefab: 'flag', id: 'flag', at: [40, 0, 0] },
        { prefab: 'camera', id: 'camera', at: [0, 2, -4], components: { camera: { follow: 'player' } } },
        ...extra,
      ],
    },
  };
}

/**
 * The game component `xp` the stat bars read (a game @component in a real game), and a
 * stand-in `rigidbody` (physics3d's) so the enemy counts as a mover without loading Rapier.
 */
function xpComponent(): unknown[] {
  return [{ id: 'xp_plugin', components: [
    { id: 'xp', schema: { fraction: { type: { kind: 'number' }, default: 0 } } },
    { id: 'rigidbody', schema: {} },
  ] }];
}

function controls(): void {
  class Controls extends Actions {
    static jump = button(kw({ keyboard: 'Space' }));
    static dash = button(kw({ keyboard: 'ShiftLeft' }));
  }
  Controls.__init_subclass__();
}

describe('parallax.hud', () => {
  it('opens each built-in panel while its data exists, with per-seat state', () => {
    controls();
    const g = run(scene(), [hud(), combat(), ...xpComponent()]);
    expect(g.open()).toEqual(expect.arrayContaining([
      'hud_nameplates', 'hud_awareness', 'hud_markers', 'hud_crosshair', 'hud_minimap', 'hud_compass', 'hud_stat_bars',
      'hud_ability_bar', 'hud_combo', 'hud_key_hints', 'hud_screen',
    ]));
    expect(registeredPanels()).toContain(MinimapPanel);

    const map = g.state('hud_minimap');
    expect(map['shown']).toBe(true);
    expect(map['round']).toBe(true);
    expect(String(map['base'])).toMatch(/^data:image\/svg\+xml/);
    // The enemy is 6 m north of the player in a 20 m-radius map: 0.5 - 6 / 40 = 35%.
    const icons = map['icons'] as Record<string, unknown>[];
    expect(icons).toHaveLength(1);
    expect(icons[0]).toMatchObject({ icon: 'skull', glyph: '☠', x: '50%', y: '35%', edge: false });
    expect(map['player_turn']).toBe('rotate(0deg)');

    const compass = g.state('hud_compass');
    expect(compass['heading']).toBe(0);
    expect((compass['ticks'] as { label: string }[]).map((t) => t.label)).toContain('N');
    // The flag is due east (bearing 90): at 0.5 + 90/180 = 100% on a 180° strip.
    expect(compass['marks']).toEqual([expect.objectContaining({ glyph: '⚑', x: '100%', distance: '40 m' })]);

    const cross = g.state('hud_crosshair');
    expect(cross).toMatchObject({ shown: true, cross: true, dot: true, hit: 0, kill: false, reloading: false });
    expect(Number.parseFloat(String(cross['gap']))).toBeGreaterThan(4);

    const plates = g.state('hud_nameplates')['plates'] as Record<string, unknown>[];
    expect(plates).toHaveLength(1);
    expect(plates[0]).toMatchObject({ text: 'Goblin', named: true, health: true, fill: '100%', bar_width: '80px', bar_height: null, bar_background: null });
    expect(plates[0]!['bar_border']).toMatch(/255/);

    const stats = g.state('hud_stat_bars')['bars'] as Record<string, unknown>[];
    expect(stats.map((b) => [b['label'], b['text'], b['fill']])).toEqual([['HP', '100 / 100', '100%'], ['XP', '40%', '40%']]);

    const markers = g.state('hud_markers')['markers'] as Record<string, unknown>[];
    expect(markers).toEqual([expect.objectContaining({ icon: 'flag', glyph: '⚑', label: 'Goal', on_screen: false })]);

    const aware = g.state('hud_awareness');
    expect(aware['meters']).toEqual([expect.objectContaining({ fill: '50%', alerted: false, on_screen: true })]);
  });

  it('every built-in panel\'s state has exactly the keys its SDK docstring lists (parallax check binds subclasses to them)', async () => {
    const { readFileSync } = await import(/* @vite-ignore */ 'node:fs' as string) as { readFileSync(p: string, e: 'utf8'): string };
    const stub = readFileSync(new URL('../../../../sdk/parallax/hud.pyi', import.meta.url).pathname, 'utf8');
    /** Top-level keys of the `{a, b: [{…}], c}` a class docstring opens with. */
    const documented = (cls: string): string[] => {
      const start = stub.indexOf(`class ${cls}(PlayerPanel):`);
      const open = stub.indexOf('"""{', start);
      if (start < 0 || open < 0) throw new Error(`${cls} has no documented state`);
      let depth = 1;
      let text = '';
      for (let i = open + 4; depth > 0; i++) {
        const c = stub[i]!;
        if (c === '{' || c === '[') depth++;
        if (c === '}' || c === ']') depth--;
        if (depth === 1 && c !== ']' && c !== '}') text += c;
      }
      return text.split(',').map((k) => k.split(':')[0]!.trim()).filter((k) => k !== '').sort();
    };
    controls();
    const g = run(scene(), [hud(), combat(), ...xpComponent()]);
    const panels: Record<string, string> = {
      MinimapPanel: 'hud_minimap', CompassPanel: 'hud_compass', CrosshairPanel: 'hud_crosshair', NameplatesPanel: 'hud_nameplates',
      MarkersPanel: 'hud_markers', StatBarsPanel: 'hud_stat_bars', AbilityBarPanel: 'hud_ability_bar', ComboPanel: 'hud_combo',
      KeyHintsPanel: 'hud_key_hints', AwarenessPanel: 'hud_awareness', ScreenEffectsPanel: 'hud_screen',
    };
    for (const [cls, id] of Object.entries(panels)) expect([cls, Object.keys(g.state(id)).sort()]).toEqual([cls, documented(cls)]);
  });

  it('derives the base map from static shapes, skipping movers and icons', () => {
    controls();
    const g = run(scene(), [hud(), combat(), ...xpComponent()]);
    const engine = (g.r.ctx as unknown as { hud: HudApi }).hud;
    expect(engine).toBeInstanceOf(HudApi);
    const base = (g.r.kernel.context as unknown as { hud: { __state__(p: string, s: number): Record<string, unknown> } }).hud.__state__('minimap', 0);
    const svg = decodeURIComponent(String(base['base']).slice(String(base['base']).indexOf(',') + 1));
    // floor (plane → floor colour), wall (box → solid, tinted red), player capsule (no rigidbody: an obstacle footprint).
    expect((svg.match(/<polygon/g) ?? []).length).toBe(2);
    expect((svg.match(/<ellipse/g) ?? []).length).toBe(1);
    expect(svg).toContain('viewBox=');
  });

  it('reacts to combat: hit and kill markers, combo, hurt flash, arcs and hit-stop', () => {
    controls();
    const g = run(scene(), [hud(), combat(), ...xpComponent()]);
    const player = g.r.ctx.world.placed(new EntityRef('player'));
    const enemy = g.r.ctx.world.placed(new EntityRef('enemy'));
    (enemy.get(Health) as unknown as { damage(...a: unknown[]): unknown }).damage(10, kw({ source: player }));
    g.step();
    expect(g.state('hud_crosshair')['hit']).toBeGreaterThan(0.5);
    expect((player.get(Combo) as unknown as { count: number }).count).toBe(1);
    (enemy.get(Health) as unknown as { damage(...a: unknown[]): unknown }).damage(10, kw({ source: player }));
    g.step();
    expect(g.state('hud_combo')).toMatchObject({ shown: true, count: 2, best: 2 });
    // The window is 1 s of game time.
    g.step(70);
    expect((player.get(Combo) as unknown as { count: number }).count).toBe(0);

    (enemy.get(Health) as unknown as { damage(...a: unknown[]): unknown }).damage(100, kw({ source: player }));
    g.step();
    expect(g.state('hud_crosshair')['kill']).toBe(true);

    (player.get(Health) as unknown as { damage(...a: unknown[]): unknown }).damage(80, kw({ source: enemy }));
    g.step();
    const screen = g.state('hud_screen');
    expect(screen['flash']).toBeGreaterThan(0.3);
    // 20 / 100 health is under low_health 0.3: the vignette is on.
    expect(screen['vignette']).toBeGreaterThan(0.25);
    // The enemy is ahead (north) of the player and the camera looks north: the arc points up.
    expect(g.state('hud_awareness')['hits']).toEqual([expect.objectContaining({ turn: 'rotate(0deg)' })]);
  });

  it('screen_flash eases by ease=: a linear fade sits above the default out_quad halfway; a bad name is PP3033', () => {
    controls();
    const g = run(scene(), [hud(), combat(), ...xpComponent()]);
    const api = g.r.ctx as unknown as { hud: { screen_flash(...a: unknown[]): void } };
    api.hud.screen_flash(Color.WHITE, kw({ strength: 1, seconds: 1 }));
    g.step(30);
    const quad = g.state('hud_screen')['flash'] as number;
    g.step(60);
    api.hud.screen_flash(Color.WHITE, kw({ strength: 1, seconds: 1, ease: 'linear' }));
    g.step(30);
    const linear = g.state('hud_screen')['flash'] as number;
    expect(quad).toBeCloseTo(0.25, 1);
    expect(linear).toBeCloseTo(0.5, 1);
    expect(code(() => api.hud.screen_flash(Color.WHITE, kw({ ease: 'wobbly' })))).toBe('PP3033');
  });

  it('runs ability cooldowns and charges in game time; the bar shows keys', () => {
    controls();
    const g = run(scene(), [hud(), combat(), ...xpComponent()]);
    const player = g.r.ctx.world.placed(new EntityRef('player'));
    const abilities = player.get(Abilities) as unknown as {
      use(s: string): boolean; ready(s: string): boolean; remaining(s: string): number; available(s: string): number; refill(s?: string): void;
    };
    expect(abilities.use('dash')).toBe(true);
    expect(abilities.use('dash')).toBe(false);
    expect(abilities.remaining('dash')).toBe(2);
    expect(abilities.use('heal')).toBe(true);
    expect(abilities.available('heal')).toBe(1);
    g.step(31);
    const slots = g.state('hud_ability_bar')['slots'] as Record<string, unknown>[];
    expect(slots[0]).toMatchObject({ id: 'dash', ready: false, keys: [expect.objectContaining({ text: 'Left Shift', code: 'ShiftLeft' })] });
    expect(slots[0]!['seconds']).toBe('1.5');
    expect(slots[1]).toMatchObject({ id: 'heal', ready: true, show_charges: true });
    g.step(60);
    expect(abilities.ready('dash')).toBe(false);
    g.step(35);
    expect(abilities.ready('dash')).toBe(true);
    expect(abilities.available('heal')).toBe(2);
    expect(code(() => abilities.use('dahs'))).toBe('PP3554');
  });

  it('ability slots may show an image; engine-component text follows the player\'s language', () => {
    controls();
    const data = scene();
    const player = structuredClone(PLAYER) as { components: Record<string, Record<string, unknown>> };
    player.components['abilities'] = { slots: [{ id: 'dash', cooldown: 2, image: 'assets/ui/dash.png', label: 'ability.dash' }] };
    data['prefabs/player.prefab.json'] = player;
    data['locale/en.json'] = { 'ability.dash': 'Dash', Goblin: 'Goblin', Goal: 'Goal' };
    data['locale/fr.json'] = { 'ability.dash': 'Ruée', Goblin: 'Gobelin', Goal: 'But' };
    const g = run(data, [hud(), combat(), ...xpComponent()]);
    const slot = () => (g.state('hud_ability_bar')['slots'] as Record<string, unknown>[])[0]!;
    expect(slot()).toMatchObject({ image: 'assets/ui/dash.png', label: 'Dash' });
    const plates = () => (g.state('hud_nameplates')['plates'] as Record<string, unknown>[]).map((p) => p['text']);
    expect(plates()).toContain('Goblin');
    (g.r.resource('settings') as { language: string }).language = 'fr';
    g.step();
    expect(slot()['label']).toBe('Ruée');
    expect(plates()).toContain('Gobelin');
    const marks = (g.state('hud_markers')['markers'] as Record<string, unknown>[]).map((m) => m['label']);
    expect(marks).toContain('But');
  });

  it('noise cues: arcs toward recent noises the player could hear (HurtFeedback.noise_cues)', () => {
    controls();
    const data = scene();
    const player = structuredClone(PLAYER) as { components: Record<string, Record<string, unknown>> };
    player.components['hurt_feedback'] = { ...player.components['hurt_feedback'], noise_cues: true };
    data['prefabs/player.prefab.json'] = player;
    const g = run(data, [hud(), combat(), ai(), ...xpComponent()]);
    const ctx = g.r.ctx as unknown as { ai: { noise(...a: unknown[]): void } };
    ctx.ai.noise(new Vec3(10, 1, 0), 40);
    ctx.ai.noise(new Vec3(0, 1, 300), 40); // too far to hear
    g.step();
    const sounds = g.state('hud_awareness')['sounds'] as Record<string, unknown>[];
    expect(sounds).toHaveLength(1);
    expect(sounds[0]!['opacity']).toBeCloseTo(0.75, 1);
    expect(typeof sounds[0]!['turn']).toBe('string');
  });

  it('key hints follow the declared bindings, the player\'s remaps and the device', () => {
    class Controls extends Actions {
      static jump = button(kw({ keyboard: 'Space' }));
      static dash = button(kw({ keyboard: 'ShiftLeft' }));
    }
    Controls.__init_subclass__();
    const g = run(scene(), [hud(), combat(), ...xpComponent()]);
    expect((g.state('hud_key_hints')['hints'] as Record<string, unknown>[]).map((h) => [h['label'], (h['keys'] as { text: string }[])[0]!.text]))
      .toEqual([['Jump', 'Space'], ['Dash', 'Left Shift']]);
    (g.r.resource('settings') as { controls: { __setitem__(k: string, v: string): void } }).controls.__setitem__('Controls.jump:key', 'KeyJ');
    g.step(2);
    expect(((g.state('hud_key_hints')['hints'] as Record<string, unknown>[])[0]!['keys'] as { text: string }[])[0]!.text).toBe('J');
  });

  it('slow motion eases time.scale and survives a snapshot', () => {
    controls();
    const g = run(scene(), [hud(), combat(), ...xpComponent()]);
    const api = (g.r.ctx as unknown as { hud: HudApi }).hud;
    api.slow_motion(0.25, 1, kw({ ease_in: 0.2, ease_out: 0.2 }));
    g.step(30);
    expect(g.r.kernel.time.scale).toBeCloseTo(0.25, 5);
    const saved = g.r.snapshot();
    g.step(60);
    expect(g.r.kernel.time.scale).toBe(1);
    g.r.restore(saved);
    g.step();
    expect(g.r.kernel.time.scale).toBeLessThan(0.5);
    expect(code(() => api.slow_motion(2, 1))).toBe('PP3553');
  });

  it('pings show on screen and on the minimap, then expire', () => {
    controls();
    const g = run(scene(), [hud(), combat(), ...xpComponent()]);
    const api = (g.r.ctx as unknown as { hud: HudApi }).hud;
    const enemy = g.r.ctx.world.placed(new EntityRef('enemy'));
    api.ping(enemy, kw({ kind: 'enemy', seconds: 0.05 }));
    g.step();
    expect((g.state('hud_markers')['markers'] as Record<string, unknown>[]).some((m) => m['icon'] === 'ping_enemy')).toBe(true);
    expect((g.state('hud_minimap')['icons'] as Record<string, unknown>[]).some((m) => m['icon'] === 'ping_enemy')).toBe(true);
    const until = g.r.kernel.time.realNow + 0.2;
    while (g.r.kernel.time.realNow < until) g.step();
    expect((g.state('hud_markers')['markers'] as Record<string, unknown>[]).some((m) => m['ping'] === true)).toBe(false);
    expect(code(() => api.ping(enemy, kw({ kind: 'party' })))).toBe('PP3558');
  });

  it('hud(units=) is "metric" or "imperial"', () => {
    expect(code(() => hud(kw({ units: 'imperial' })))).toBe(undefined);
    expect(code(() => hud(kw({ units: 'parsecs' })))).toBe('PP3561');
  });

  it('honours accessibility settings: reduced motion softens the flash, text scale and contrast reach the state', () => {
    controls();
    const g = run(scene(), [hud(), combat(), ...xpComponent()]);
    const settings = g.r.resource('settings') as Record<string, unknown>;
    settings['reduced_motion'] = true;
    settings['high_contrast'] = true;
    settings['text_scale'] = 1.5;
    const player = g.r.ctx.world.placed(new EntityRef('player'));
    (player.get(Health) as unknown as { damage(...a: unknown[]): unknown }).damage(25);
    g.step();
    const screen = g.state('hud_screen');
    expect(screen['a11y']).toEqual({ contrast: true, calm: true, font: '150%' });
    expect(screen['flash']).toBeLessThan(0.3);
  });

  it('a game subclass replaces the built-in panel; viewers are unambiguous or fail loudly', () => {
    controls();
    class MyMap extends MinimapPanel {}
    ui('my_map', kw({ html: 'ui/my_map.html' }))(MyMap);
    const data = scene();
    (data['scenes/main/scene.json'] as { ui?: string[] }).ui = ['my_map'];
    const g = run(data, [hud(), combat(), ...xpComponent()]);
    expect(g.open()).toContain('my_map');
    expect(g.open()).not.toContain('hud_minimap');
    // A subclass gets the state as a Python dict (nested dicts, new lists) it may extend.
    const mine = g.state('my_map') as unknown as PyDict;
    expect(mine).toBeInstanceOf(PyDict);
    expect(mine.__getitem__('shown')).toBe(true);
    const icons = mine.__getitem__('icons') as PyDict[];
    expect(icons[0]).toBeInstanceOf(PyDict);
    expect(icons[0]!.__getitem__('icon')).toBe('skull');
    // A second Crosshair in a game whose camera follows nobody: the HUD can't tell who the player is.
    resetDeclarations();
    controls();
    const two = scene([{ prefab: 'player', id: 'clone', at: [3, 1, 0] }]);
    (two['scenes/main/scene.json'] as { entities: { id?: string; components?: unknown }[] }).entities.find((e) => e.id === 'camera')!.components = {};
    expect(() => run(two, [hud(), combat(), ...xpComponent()])).toThrow(/PP3556/);
    void builtinPanels; void CrosshairPanel; void KeyHintsPanel; void AbilityBarPanel; void StatBars; void MapIcon;
  });

  it('draws a 2D minimap on the x/y plane', () => {
    controls();
    const g = run({
      'prefabs/hero.prefab.json': { components: { sprite: {}, minimap: { range: 10 } } },
      'prefabs/coin.prefab.json': { components: { map_icon: { icon: 'star' } } },
      'prefabs/block.prefab.json': { components: { shape: { kind: 'rect', size: [4, 1, 1] } } },
      'prefabs/cam.prefab.json': { components: { camera: { mode: 'orthographic', size: 8 } } },
      'scenes/main/scene.json': {
        entities: [
          { prefab: 'hero', id: 'hero', at: [0, 0] }, { prefab: 'coin', at: [5, 0] }, { prefab: 'block', at: [0, -3] },
          { prefab: 'cam', at: [0, 0, 10] },
        ],
      },
    }, [hud()], '2d');
    const map = g.state('hud_minimap');
    // 5 m east in a 10 m map, north-up after rotate (2D heading of an unrotated hero is east: 90°).
    const icon = (map['icons'] as Record<string, unknown>[])[0]!;
    expect(icon['icon']).toBe('star');
    expect(String(map['base'])).toMatch(/^data:image\/svg/);
  });
});
