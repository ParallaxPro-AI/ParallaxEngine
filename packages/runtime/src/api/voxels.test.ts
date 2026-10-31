/**
 * `parallax.voxels` as compiled game code sees it, through `createRuntime`: a game kind
 * extending BlockDef, Cell3 values and fields, `ctx.voxels` with Python arguments,
 * BlockHit, block entities carrying VoxelBlock, and BlockChanged.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { ParallaxError, Vec3 } from '../core/index.js';
import type { ProjectFiles } from '../core/index.js';
import { HeadlessInput } from '../function/plugins/input/index.js';
import { HeadlessAudio } from '../platform/headless/audio.js';
import { MemoryBinaryFiles, RecordingSurface3d } from '../platform/headless/render3d.js';
import { loadProject } from '../resource/index.js';
import { ContentRef } from './content.js';
import { component, content, createRuntime, field, Game, kw, on, resetDeclarations, rt, SceneRef, system, System } from './index.js';
import type { Context, Entity, GameRuntime } from './index.js';
import { BlockChanged, BlockDef, BlockHit, Cell3, VoxelBlock, voxels, VoxelsApi } from './voxels.js';

const PROJECT: Record<string, unknown> = {
  'content/block/stone.json': { name: 'Stone', hardness: 1.5, loot: 'pebble' },
  'content/block/grass.json': { name: 'Grass', loot: 'dirt' },
  'content/block/chest.json': { name: 'Chest', prefab: 'chest', loot: 'chest' },
  'prefabs/chest.prefab.json': { components: {} },
  'prefabs/eye.prefab.json': { components: { camera: {} } },
  'scenes/w/scene.json': {
    voxels: { y_range: [-4, 12], generator: { type: 'landscape', base_height: 2, strata: [{ block: 'grass', depth: 1 }, { block: 'stone' }] } },
    entities: [{ id: 'eye', prefab: 'eye', at: [0, 6, 0] }],
  },
};

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

function code(fn: () => unknown): string {
  try { fn(); } catch (e) { if (e instanceof ParallaxError) return e.diagnostic.code; throw e; }
  return 'no error';
}

const heard: string[] = [];

interface Ctx extends Context { voxels: VoxelsApi }

function start(): { runtime: GameRuntime; ctx: Ctx; Marker: new (...a: unknown[]) => { at: Cell3 | null } } {
  // @content("block") class Block(BlockDef): loot: str
  class BlockFields extends (BlockDef as unknown as new () => object) {
    static readonly __annotations__ = { loot: () => rt.str };
    static readonly loot = field('');
  }
  content('block')(BlockFields);
  // @component("waypoint") class Marker: at: Cell3 | None = field(None)
  class MarkerFields {
    static readonly __annotations__ = { at: () => rt.optional(Cell3) };
    static readonly at = field(null);
  }
  const Marker = component('waypoint')(MarkerFields) as unknown as new (...a: unknown[]) => { at: Cell3 | null };
  class Log extends System {
    changed(_ctx: Context, e: { cell: Cell3; old: ContentRef<unknown> | null; new: ContentRef<unknown> | null; source: Entity | null }) {
      heard.push(`${String(e.cell)} ${e.old?.id ?? 'air'}→${e.new?.id ?? 'air'} by=${e.source === null ? 'None' : 'entity'}`);
    }
  }
  on(BlockChanged)(Log.prototype.changed);
  system('log')(Log);
  const game = new Game(kw({
    id: 'blocks', title: 'Blocks', sdk: '1.0', mode: '3d', start_scene: new SceneRef('w'),
    plugins: [voxels(kw({ chunk_size: 8 }))], systems: [Log],
  }));
  const project = loadProject(files(PROJECT));
  expect(project.diagnostics).toEqual([]);
  const runtime = createRuntime(game, project, {
    seed: 1, devices: new HeadlessInput(), audio: new HeadlessAudio(), assets: null, files: files(PROJECT),
    surface3d: new RecordingSurface3d(), binary: new MemoryBinaryFiles({}),
  });
  runtime.start();
  return { runtime, ctx: runtime.ctx as Ctx, Marker };
}

beforeEach(() => {
  resetDeclarations();
  heard.length = 0;
});

describe('Cell3', () => {
  it('is an immutable, hashable integer position', () => {
    const c = new Cell3(1, 2, 3);
    expect(c.__add__(Cell3.UP).toJSON()).toEqual([1, 3, 3]);
    expect(c.__sub__(Cell3.DOWN).toJSON()).toEqual([1, 3, 3]);
    expect(c.__eq__(new Cell3(1, 2, 3))).toBe(true);
    expect(c.__hash__()).toBe(new Cell3(1, 2, 3).__hash__());
    expect(c.center()).toEqual(new Vec3(1.5, 2.5, 3.5));
    expect(String(c)).toBe('Cell3(1, 2, 3)');
    expect(code(() => { (c as { x: number }).x = 4; })).toBe('PP3020');
    expect(code(() => new Cell3(1.5, 0, 0))).toBe('PP3022');
  });
});

describe('parallax.voxels in a running game', () => {
  it('reads blocks as the game\'s own kind and edits them with by=', () => {
    const { runtime, ctx } = start();
    const v = ctx.voxels;
    const top = v.get(new Cell3(0, 2, 0))!;
    expect(top).toBeInstanceOf(ContentRef);
    expect(top.id).toBe('grass');
    expect((top.data as { loot: string; hardness: number }).loot).toBe('dirt');
    expect(v.get(new Cell3(0, 3, 0))).toBeNull();
    expect(v.surface_height(Vec3.ZERO)).toBe(3);
    expect(v.surface_height(kw({ point: new Vec3(5.7, 40, -4.2) }))).toBe(3);

    const stone = ctx.content(BlockDef).get('stone');
    const eye = runtime.wrap([...runtime.kernel.world.live()][0]!.id);
    v.set(new Cell3(0, 3, 0), stone, kw({ by: eye }));
    v.set(new Cell3(0, 3, 0), null);
    runtime.step(1 / 60);
    expect(heard).toEqual(['Cell3(0, 3, 0) air→stone by=entity', 'Cell3(0, 3, 0) stone→air by=None']);
    expect(v.cell_at(new Vec3(-0.5, 2.9, 7.2)).toJSON()).toEqual([-1, 2, 7]);
    expect(code(() => v.set([0, 3, 0], stone))).toBe('PP3624');
    expect(code(() => v.set(new Cell3(0, 3, 0), 'stone'))).toBe('PP3624');
    expect(code(() => v.surface_height(0))).toBe('PP3624');
  });

  it('gives block entities a VoxelBlock cell and BlockHits a place_cell', () => {
    const { ctx } = start();
    const v = ctx.voxels;
    const cell = new Cell3(3, v.surface_height(new Vec3(3, 0, 3)), 3);
    v.set(cell, ctx.content(BlockDef).get('chest'));
    const chest = v.block_entity(cell)!;
    expect((chest.get(VoxelBlock) as { cell: Cell3 }).cell.__eq__(cell)).toBe(true);
    expect(chest.transform.position).toEqual(new Vec3(3.5, 3, 3.5));

    const hit = v.raycast(new Vec3(0.5, 6, 0.5), new Vec3(0, -1, 0))!;
    expect(hit).toBeInstanceOf(BlockHit);
    expect(hit.cell.toJSON()).toEqual([0, 2, 0]);
    expect(hit.face.__eq__(Cell3.UP)).toBe(true);
    expect(hit.place_cell.toJSON()).toEqual([0, 3, 0]);
    expect(hit.block.id).toBe('grass');
    expect(v.raycast(new Vec3(0.5, 6, 0.5), new Vec3(0, -1, 0), kw({ max_distance: 2 }))).toBeNull();
  });

  it('stores Cell3 in game component fields', () => {
    const { runtime, Marker } = start();
    const eye = runtime.wrap([...runtime.kernel.world.live()][0]!.id);
    eye.add(new Marker(kw({ at: new Cell3(1, 2, 3) })));
    const marker = eye.get(Marker) as { at: Cell3 | null };
    expect(marker.at!.__add__(Cell3.UP).toJSON()).toEqual([1, 3, 3]);
    // Snapshots encode it as [x, y, z].
    const snap = runtime.snapshot();
    expect(JSON.stringify(snap)).toContain('"at":[1,2,3]');
  });

  it('voxels() checks its arguments', () => {
    expect(code(() => voxels(kw({ chunk_size: 3 })))).toBe('PP3629');
    expect(code(() => voxels(kw({ save_edits: 1 })))).toBe('PP3629');
    expect(code(() => voxels(kw({ chunksize: 16 })))).toBe('PP3030');
  });
});
