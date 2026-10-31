/**
 * Python values through a running game: dict / set / tuple fields as pyrt objects on
 * components, state and resources; entity facades as keys; `print` routed to the runtime;
 * engine components presented with `.entity` and *Ref fields; defaults that collide with a
 * class's own properties (`name`, `length`).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { ProjectFiles } from '../core/index.js';
import { Cell } from '../core/index.js';
import { HeadlessInput } from '../function/plugins/input/index.js';
import { HeadlessAudio } from '../platform/headless/audio.js';
import { RecordingSurface2d } from '../platform/headless/render.js';
import { loadProject } from '../resource/index.js';
import { PyDict, PySet } from './pyrt/collections.js';
import { print } from './pyrt/builtins.js';
import { Ellipsis } from './pyrt/values.js';
import {
  Behavior, behavior, component, content, ContentRef, createRuntime, Entity, EntityRef, field, Game, ImageRef, kw, PrefabRef, resetDeclarations,
  param, resource, rt, SceneRef, Sprite, state, System, system, Tag, tag,
} from './index.js';
import type { GameRuntime } from './index.js';
import { schemaOf } from './types.js';

const STEP = 1 / 60;

function files(contents: Record<string, unknown>): ProjectFiles {
  const all: Record<string, unknown> = {
    'prefabs/camera.prefab.json': { components: { camera: { mode: 'orthographic', size: 8 } } },
    ...contents,
  };
  const text = Object.fromEntries(Object.entries(all).map(([p, v]) => [p, typeof v === 'string' ? v : JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

function run(data: Record<string, unknown>, systems: unknown[] = [], print?: (text: string) => void): GameRuntime {
  const projectFiles = files(data);
  const project = loadProject(projectFiles);
  expect(project.diagnostics).toEqual([]);
  const game = new Game(kw({ id: 't', title: 'T', sdk: '1.0', start_scene: new SceneRef('main'), mode: '2d', systems }));
  const runtime = createRuntime(game, project, {
    seed: 1, devices: new HeadlessInput(), audio: new HeadlessAudio(), assets: null, files: projectFiles,
    surface: new RecordingSurface2d(), ...(print !== undefined && { print }),
  });
  runtime.start();
  return runtime;
}

function code(fn: () => unknown): string | undefined {
  try { fn(); } catch (e) { return (e as { diagnostic?: { code: string } }).diagnostic?.code; }
  return undefined;
}

beforeEach(() => resetDeclarations());

describe('containers in a running game', () => {
  it('component, state and resource dicts/sets/tuples are pyrt values, per entity and kept across frames', () => {
    class ItemC { static __annotations__ = { name: () => rt.str }; }
    const Item = content('item')(ItemC);
    class BagC {
      static __annotations__ = {
        counts: () => rt.dict(rt.generic(ContentRef, Item), rt.int),
        kinds: () => rt.set(Tag),
        path: () => rt.tuple(rt.int, Ellipsis),
        home: () => Cell,
      };
      static counts = field(new PyDict());
      static kinds = field(new PySet());
      static path = field(Object.freeze([1, 2]));
      static home = field(new Cell(1, 2));
    }
    const Bag = component('bag')(BagC);
    class SeenC { static __annotations__ = { by: () => rt.dict(rt.str, rt.list(PrefabRef)) }; static by = field(new PyDict()); }
    resource('seen')(SeenC);
    const runtime = run({
      'content/item/sword.json': { name: 'Sword' },
      'prefabs/bagger.prefab.json': { components: { bag: { counts: { sword: 2 }, kinds: ['red'] } } },
      'scenes/main/scene.json': { entities: [{ prefab: 'camera' }, { prefab: 'bagger', id: 'a' }, { prefab: 'bagger', id: 'b' }] },
    });
    const [a, b] = ['a', 'b'].map((id) => runtime.ctx.world.placed(new EntityRef(id)) as Entity);
    const bagA = a!.get(Bag) as unknown as { counts: PyDict; kinds: PySet; path: readonly number[]; home: Cell };
    expect(bagA.counts).toBeInstanceOf(PyDict);
    const sword = runtime.contentList(Item).get('sword');
    expect(bagA.counts.__getitem__(sword)).toBe(2);
    bagA.counts.__setitem__(sword, 7);
    expect(bagA.kinds.__contains__(new Tag('red'))).toBe(true);
    expect(Object.isFrozen(bagA.path)).toBe(true);
    expect(bagA.home).toEqual(new Cell(1, 2));
    const bagB = b!.get(Bag) as unknown as { counts: PyDict };
    expect(bagB.counts).not.toBe(bagA.counts);
    expect(bagB.counts.__getitem__(sword)).toBe(2);
    runtime.step(STEP);
    expect((a!.get(Bag) as unknown as { counts: PyDict }).counts.__getitem__(sword)).toBe(7);
    const seen = runtime.resource('seen') as unknown as { by: PyDict };
    expect(seen.by).toBeInstanceOf(PyDict);
  });

  it('a behavior state dict persists between frames', () => {
    const log: number[] = [];
    class Counter extends Behavior {
      static __annotations__ = { visits: () => rt.dict(rt.int, rt.str) };
      static visits = state(new PyDict());
      update(): void {
        const v = (this as unknown as { visits: PyDict }).visits;
        v.__setitem__(v.__len__(), 'step');
        log.push(v.__len__());
      }
    }
    behavior('counter')(Counter);
    const runtime = run({
      'prefabs/c.prefab.json': { behaviors: { counter: {} } },
      'scenes/main/scene.json': { entities: [{ prefab: 'camera' }, { prefab: 'c' }, { prefab: 'c' }] },
    });
    runtime.step(STEP);
    runtime.step(STEP);
    expect(log).toEqual([1, 1, 2, 2]);
  });

  it('spawn(params=) takes the dicts compiled code passes', () => {
    class Mover extends Behavior {
      static __annotations__ = { speed: () => rt.float };
      static speed = param(1);
    }
    behavior('mover')(Mover);
    const runtime = run({
      'prefabs/m.prefab.json': { behaviors: { mover: {} } },
      'scenes/main/scene.json': { entities: [{ prefab: 'camera' }] },
    });
    const params = PyDict.from([['mover', PyDict.from([['speed', 5]])]]);
    const e = runtime.ctx.world.spawn(new PrefabRef('m'), kw({ params })) as Entity;
    const instance = runtime.kernel.world.require(e.__entity_id__).behaviors[0]!.instance as unknown as { speed: number };
    expect(instance.speed).toBe(5);
    expect(code(() => runtime.ctx.world.spawn(new PrefabRef('m'), kw({ params: PyDict.from([[3, PyDict.from([])]]) })))).toBe('PP3004');
  });

  it('entity facades are dict keys and set elements by id', () => {
    const runtime = run({ 'prefabs/p.prefab.json': {}, 'scenes/main/scene.json': { entities: [{ prefab: 'camera' }] } });
    const e = runtime.ctx.world.spawn(new PrefabRef('p')) as Entity;
    const d = new PyDict();
    d.__setitem__(e, 'hp');
    // A second facade for the same id (what the wrap cache makes after pruning) is the same key.
    const again = new Entity(runtime, e.__entity_id__);
    expect(again).not.toBe(e);
    expect(d.__getitem__(again)).toBe('hp');
    expect(new PySet([e, again]).__len__()).toBe(1);
  });

  it('print() goes to the runtime: kept in `printed`, or to the print option', () => {
    class Talk extends System { update(): void { print('tick', 1, kw({ sep: '-' })); } }
    system('talk')(Talk);
    const data = { 'scenes/main/scene.json': { entities: [{ prefab: 'camera' }] } };
    const kept = run(data, [Talk]);
    kept.step(STEP);
    expect(kept.printed).toEqual(['tick-1\n']);
    const out: string[] = [];
    const routed = run(data, [Talk], (text) => out.push(text));
    routed.step(STEP);
    kept.step(STEP);
    expect(out).toEqual(['tick-1\n']);
    expect(kept.printed).toEqual(['tick-1\n', 'tick-1\n']);
    expect(routed.printed).toEqual([]);
  });
});

describe('engine components as game code sees them', () => {
  it('have .entity, read reference fields as *Ref objects and store ids', () => {
    const runtime = run({
      'assets/images/hero.png': 'png',
      'prefabs/hero.prefab.json': { components: { sprite: { image: 'images/hero' } } },
      'scenes/main/scene.json': { entities: [{ prefab: 'camera' }, { prefab: 'hero', id: 'hero' }] },
    });
    const hero = runtime.ctx.world.spawn(new PrefabRef('hero')) as Entity;
    const sprite = hero.get(Sprite) as unknown as { image: unknown; entity: Entity };
    expect(sprite.entity).toBe(hero);
    expect(sprite.image).toEqual(new ImageRef('images/hero'));
    expect(hero.get(Sprite)).toBe(sprite);
    sprite.image = new ImageRef('images/other');
    expect(runtime.kernel.world.require(hero.__entity_id__).components.get('sprite')!['image']).toBe('images/other');
    sprite.image = null;
    expect(sprite.image).toBeNull();
    runtime.step(STEP);
  });

  it('presents an engine component\'s dict fields as Python dicts (Model.colors, Sprite.animations)', () => {
    const runtime = run({
      'assets/images/hero.png': 'png',
      'prefabs/hero.prefab.json': { components: { sprite: { image: 'images/hero', animations: { run: { frames: ['images/hero'], fps: 8 } } } } },
      'scenes/main/scene.json': { entities: [{ prefab: 'camera' }, { prefab: 'hero', id: 'hero' }] },
    });
    const hero = runtime.ctx.world.spawn(new PrefabRef('hero')) as Entity;
    const sprite = hero.get(Sprite) as unknown as { animations: PyDict };
    const animations = sprite.animations;
    expect(animations).toBeInstanceOf(PyDict);
    expect(animations.__getitem__('run')).toMatchObject({ frames: ['images/hero'], fps: 8 });
    expect(animations.get('walk', null)).toBeNull();
    expect([...animations.keys()]).toEqual(['run']);
    // A dict assigned is stored as the JSON object the renderer reads.
    sprite.animations = PyDict.from([['idle', { frames: ['images/hero'], fps: 2 }]]);
    expect(runtime.kernel.world.require(hero.__entity_id__).components.get('sprite')!['animations']).toMatchObject({ idle: { frames: ['images/hero'], fps: 2 } });
    runtime.step(STEP);
  });
});

describe('class attributes that are not defaults', () => {
  it('a field named `name` or `length` without a default is required, not the class name', () => {
    class ItemC {
      static __annotations__ = { name: () => rt.str, length: () => rt.int, kind: () => Tag };
      static kind = field(tag('poison'));
    }
    const Item = content('effect_item')(ItemC);
    const info = schemaOf(Item, 'content Item');
    expect(info.schema['name']).toEqual({ type: { kind: 'string' } });
    expect(info.schema['length']).toEqual({ type: { kind: 'int' } });
    expect(info.schema['kind']).toEqual({ type: { kind: 'tag' }, default: 'poison' });
    const runtime = run({
      'content/effect_item/venom.json': { name: 'Venom', length: 3 },
      'scenes/main/scene.json': { entities: [{ prefab: 'camera' }] },
    });
    const venom = runtime.contentList(Item).get('venom') as unknown as { data: { name: string; length: number; kind: unknown } };
    expect(venom.data.name).toBe('Venom');
    expect(venom.data.length).toBe(3);
    expect(venom.data.kind).toEqual(new Tag('poison'));
  });
});
