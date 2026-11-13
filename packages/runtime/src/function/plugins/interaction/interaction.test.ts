/**
 * The interaction plugin on a bare kernel with a stand-in actions service (what the runtime
 * provides from the input engine) and a stand-in camera: focus by proximity and by look,
 * press and hold-to-interact, `once`, the release latch, and the Interacted event reaching
 * the interactable's behaviors.
 */

import { describe, expect, it } from 'vitest';
import { ParallaxError, Quat, Vec3 } from '../../../core/index.js';
import type { EntityId, ProjectFiles } from '../../../core/index.js';
import { loadProject } from '../../../resource/index.js';
import { componentEntity, Kernel } from '../../kernel/index.js';
import type { BehaviorDef, Fields, KernelPlugin } from '../../kernel/index.js';
import { ACTIONS_SERVICE, PHYSICS3D_SERVICE } from '../../services/index.js';
import { INTERACTION_EVENTS, interaction } from './index.js';
import type { InteractionPlugin } from './index.js';

const DT = 1 / 60;
const INTERACT = { action: 'interact' };

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

function code(fn: () => unknown): string | undefined {
  try { fn(); } catch (e) { if (e instanceof ParallaxError) return e.diagnostic.code; throw e; }
  return undefined;
}

interface Rig {
  readonly kernel: Kernel;
  readonly plugin: InteractionPlugin;
  readonly keys: { pressed: boolean; held: boolean };
  readonly heard: string[];
  step(frames?: number): void;
  id(placed: string): EntityId;
  focus(): string | null;
}

function rig(data: Record<string, unknown>, camera = { at: new Vec3(0, 1.6, 0), rotation: Quat.IDENTITY }, extra: KernelPlugin[] = []): Rig {
  const keys = { pressed: false, held: false };
  const heard: string[] = [];
  const visuals: KernelPlugin = {
    id: 'fake_visuals',
    components: [{
      id: 'camera', schema: {},
      methods: {
        get __view__() {
          return {
            entity: componentEntity(this as unknown as Fields), seat: 0, active: true, dimension: '3d', mode: 'perspective',
            position: camera.at, rotation: camera.rotation, fov: 60, size: 5, near: 0.1, far: 1000, aspect: 16 / 9,
            viewport: { width: 1280, height: 720 },
          };
        },
      },
    }],
    install(k) {
      k.provide(ACTIONS_SERVICE, {
        pressed: (a) => a === INTERACT && keys.pressed,
        held: (a) => a === INTERACT && keys.held,
        live: () => true,
        device: () => 'keyboard',
        find: () => undefined,
        names: () => [],
        glyphs: () => [{ device: 'keyboard', code: 'KeyE', text: 'E' }],
      });
    },
  };
  const chest: BehaviorDef = {
    id: 'chest', requires: [], params: {}, state: {},
    handlers: [{ event: INTERACTION_EVENTS.interacted, method: 'used' }],
    create: () => ({ used: (_ctx: unknown, e: Fields) => { heard.push(`used by ${String(e['source'])}`); } }),
  } as unknown as BehaviorDef;
  const plugin = interaction({ action: INTERACT });
  const project = loadProject(files(data));
  expect(project.diagnostics).toEqual([]);
  const kernel = new Kernel({
    project, game: { components: [], events: [], behaviors: [chest], systems: [], resources: [] }, plugins: [visuals, plugin, ...extra],
  });
  kernel.start('main');
  const r: Rig = {
    kernel, plugin, keys, heard,
    step(frames = 1) { for (let i = 0; i < frames; i++) kernel.step(DT); },
    id(placed) {
      const found = kernel.world.query([]).find(([id]) => kernel.world.get(id)?.placedId === placed);
      if (found === undefined) throw new Error(`no ${placed}`);
      return found[0];
    },
    focus() {
      const f = kernel.world.get(r.id('player'))!.components.get('interactor')!['focus'];
      return f === null ? null : kernel.world.get(f as EntityId)!.placedId ?? null;
    },
  };
  return r;
}

function world(player: Record<string, unknown> = {}, chestExtra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    'prefabs/cam.prefab.json': { components: { camera: {} } },
    'prefabs/player.prefab.json': { components: { interactor: player } },
    'prefabs/chest.prefab.json': { components: { interactable: { prompt: 'Open', ...chestExtra } }, behaviors: { chest: {} } },
    'scenes/main/scene.json': {
      entities: [
        { prefab: 'cam', id: 'cam' },
        { prefab: 'player', id: 'player', at: [0, 0, 0] },
        { prefab: 'chest', id: 'near', at: [0, 0, 1.5] },
        { prefab: 'chest', id: 'far', at: [0.5, 0, 2.4] },
        { prefab: 'chest', id: 'behind', at: [0, 0, -1] },
      ],
    },
  };
}

describe('interaction', () => {
  it('line of sight: a wall hides an interactable, its own child collider does not', () => {
    let blocker: 'wall' | 'own' = 'wall';
    let k: Kernel | undefined;
    const physics: KernelPlugin = {
      id: 'fake_physics',
      install(kernel) {
        k = kernel;
        kernel.provide(PHYSICS3D_SERVICE, {
          raycast: () => {
            const all = kernel.world.query([]).map(([id]) => kernel.world.get(id)!);
            const hit = blocker === 'wall' ? all.find((e) => e.placedId === 'wall') : all.find((e) => e.parent !== null && kernel.world.get(e.parent)?.placedId === 'near');
            return hit === undefined ? undefined : { entity: hit.id, distance: 0.6, point: new Vec3(0, 1, 0.6), normal: new Vec3(0, 0, -1) };
          },
        } as never);
      },
    };
    const data = world();
    data['prefabs/chest.prefab.json'] = { components: { interactable: { prompt: 'Open' } }, behaviors: { chest: {} }, children: [{ at: [0, 1, 0], components: {} }] };
    data['prefabs/wall.prefab.json'] = { components: {} };
    (data['scenes/main/scene.json'] as { entities: unknown[] }).entities.push({ prefab: 'wall', id: 'wall', at: [0, 0, 0.6] });
    const r = rig(data, undefined, [physics]);
    r.step();
    expect(r.focus()).toBeNull();
    blocker = 'own';
    r.step();
    expect(r.focus()).toBe('near');
    expect(k).toBeDefined();
  });

  it('focuses the nearest interactable in the facing cone; a press emits Interacted to its behaviors', () => {
    const r = rig(world());
    r.step();
    expect(r.focus()).toBe('near');
    r.keys.pressed = true;
    r.step();
    r.keys.pressed = false;
    expect(r.heard).toEqual([`used by ${r.id('player')}`]);
    // Turned around, the one behind is in front.
    r.kernel.world.get(r.id('player'))!.transform.rotation = Quat.from_euler(new Vec3(0, 180, 0));
    r.step();
    expect(r.focus()).toBe('behind');
  });

  it('look mode aims through the camera center', () => {
    const r = rig(world({ mode: 'look', range: 5 }), { at: new Vec3(0.5, 1, 0), rotation: Quat.IDENTITY });
    r.step();
    // From (0.5, 1, 0) looking north, "far" at (0.5, 1 + offset 0 … its anchor (0.5, 1, 2.4)) is dead ahead.
    expect(r.focus()).toBe('far');
  });

  it('the offset turns with the interactable: a chest turned to face west is aimed at on its west side', () => {
    // Every chest's anchor is 1 m up and 0.6 m out of its front (+z). "far" (0.5, 0, 2.4) is turned to
    // face west, so its anchor is (-0.1, 1, 2.4): dead ahead of a view at (-0.1, 1, 0) looking north,
    // closer to the view's center than "near"'s (0, 1, 2.1). Unturned it would sit at (0.5, 1, 3.0).
    const data = world({ mode: 'look', range: 5 }, { offset: [0, 1, 0.6] });
    const far = (data['scenes/main/scene.json'] as { entities: Record<string, unknown>[] }).entities[3]!;
    far['rotation'] = [0, -90, 0];
    const r = rig(data, { at: new Vec3(-0.1, 1, 0), rotation: Quat.IDENTITY });
    r.step();
    expect(r.focus()).toBe('far');
  });

  it('look mode measures reach to the point it aims at, not to the middle of the interactable', () => {
    // A wide gate whose prompt point (its anchor) is 4 m from its origin: from 3 m in front of that
    // point the origin is 7 m off, past a 5 m reach, but the point itself is in reach.
    const data = world({ mode: 'look', range: 5 }, { offset: [0, 1, -4], range: 5 });
    const entities = (data['scenes/main/scene.json'] as { entities: Record<string, unknown>[] }).entities;
    entities.splice(2, 3, { prefab: 'chest', id: 'gate', at: [0, 0, 7] });
    const r = rig(data, { at: new Vec3(0, 1, 0), rotation: Quat.IDENTITY });
    r.step();
    expect(r.focus()).toBe('gate');
  });

  it('hold-to-interact fills progress, fires once, and waits for release', () => {
    const r = rig(world({}, { hold: 0.5, once: true }));
    r.step();
    r.keys.held = true;
    r.step(15);
    const me = r.kernel.world.get(r.id('player'))!.components.get('interactor')!;
    expect(me['progress']).toBeCloseTo(0.5, 1);
    expect(r.heard).toEqual([]);
    r.step(16);
    expect(r.heard).toHaveLength(1);
    // `once`: the used chest disables itself; the next one comes into focus, but the key must be released first.
    r.step(40);
    expect(r.focus()).toBe('far');
    expect(r.heard).toHaveLength(1);
    r.keys.held = false;
    r.step();
    r.keys.held = true;
    r.step(31);
    expect(r.heard).toHaveLength(2);
  });

  it('needs an action, and a 3D camera for look mode', () => {
    expect(code(() => interaction({ action: undefined }))).toBe('PP4580');
    const data = world({ mode: 'look' });
    (data['scenes/main/scene.json'] as { entities: unknown[] }).entities.shift();
    const r = rig(data);
    expect(code(() => r.step())).toBe('PP3581');
  });
});
