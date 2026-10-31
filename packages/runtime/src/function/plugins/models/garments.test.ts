/**
 * Skinned garments worn on a body's skeleton (bone names matched exactly or rig-neutrally,
 * bones the body lacks following rigidly), and the characters plugin's Wardrobe: the
 * outfit as data spawning and taking off garments, tints, and the body parts they hide.
 */

import { describe, expect, it } from 'vitest';
import { Color, Vec3 } from '../../../core/index.js';
import type { ProjectFiles } from '../../../core/index.js';
import { MemoryBinaryFiles } from '../../../platform/headless/render3d.js';
import { loadProject } from '../../../resource/index.js';
import { Kernel } from '../../kernel/index.js';
import type { Fields } from '../../kernel/index.js';
import { characters } from '../characters/index.js';
import { visuals } from '../visuals/index.js';
import { garmentMap } from './garments.js';
import { models } from './index.js';
import { writeGlb } from './testing.js';

const DT = 1 / 30;
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** A triangle skinned to a two-bone chain (Hips → Spine 1 m up), named with `prefix`, plus `extra` bones under Spine. */
function rig(prefix: string, extra: readonly string[], clip: boolean): Uint8Array {
  const bones = [`${prefix}Hips`, `${prefix}Spine`, ...extra];
  const half = Math.SQRT1_2;
  return writeGlb({
    nodes: [
      { name: 'skin_mesh', mesh: 0, skin: 0 },
      { name: bones[0], children: [2] },
      { name: bones[1], translation: [0, 1, 0], children: extra.map((_, i) => 3 + i) },
      ...extra.map((name) => ({ name, translation: [0, 0.5, 0] })),
    ],
    meshes: [{ positions: [0, 0, 0, 0.1, 0, 0, 0, 1, 0], joints: [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0], weights: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], indices: [0, 1, 2], material: 0 }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1] } }],
    skins: [{ joints: bones.map((_, i) => i + 1), inverseBind: bones.flatMap(() => IDENTITY) }],
    animations: clip ? [{ name: 'bend', channels: [{ node: 2, path: 'rotation', times: [0, 1], values: [0, 0, half, half, 0, 0, half, half] }] }] : [],
  });
}

function text(contents: Record<string, unknown>): ProjectFiles {
  const t = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, typeof v === 'string' ? v : JSON.stringify(v)]));
  return { list: () => Object.keys(t).sort(), read: (p) => t[p]! };
}

async function world() {
  const files = text({
    'assets/models/body.glb': '',
    'assets/models/coat.glb': '',
    'assets/models/hat.glb': '',
    'prefabs/body.prefab.json': {
      components: { model: { model: 'models/body', offset: [0, 0.2, 0] }, animator: { default_clip: 'bend' }, wardrobe: { outfit: { torso: 'coat' } } },
    },
    'prefabs/coat.prefab.json': { components: { model: { model: 'models/coat' }, garment: { slot: 'torso', hides: ['skin_mesh'] } } },
    'prefabs/hat.prefab.json': { components: { model: { model: 'models/hat' }, garment: { slot: 'head' } } },
    'scenes/main/scene.json': { entities: [{ prefab: 'body', id: 'body', at: [3, 0, 0] }] },
  });
  const project = loadProject(files);
  expect(project.diagnostics).toEqual([]);
  const plugin = models({
    files,
    binary: new MemoryBinaryFiles(new Map([
      ['assets/models/body.glb', rig('', [], true)],
      ['assets/models/coat.glb', rig('mixamorig:', ['Tail'], false)],
      ['assets/models/hat.glb', rig('', [], false)],
    ])),
  });
  const kernel = new Kernel({
    project, game: { components: [], resources: [], events: [], behaviors: [], systems: [] },
    plugins: [visuals({ dimension: '3d' }), plugin, characters()], context: {}, fixedStep: DT,
  });
  plugin.source.preload();
  await plugin.source.whenLoaded();
  kernel.start('main');
  const body = [...kernel.world.live()].find((r) => r.placedId === 'body')!;
  return { kernel, source: plugin.source, body };
}

const translationOf = (m: Float32Array, n: number): number[] => [m[n * 16 + 12]!, m[n * 16 + 13]!, m[n * 16 + 14]!].map((v) => Math.round(v * 1e4) / 1e4);

describe('garments', () => {
  it('map bones by name, exactly or rig-neutrally; non-bones and missing bones follow rigidly', async () => {
    const { source } = await world();
    const body = source.get('assets/models/body.glb')!;
    const coat = source.get('assets/models/coat.glb')!;
    const map = Array.from(garmentMap(coat, body));
    expect(map).toEqual([-1, body.nodeByName.get('Hips'), body.nodeByName.get('Spine'), -1]);
  });

  it('are posed by the body\'s skeleton, on its origin, across Model offsets', async () => {
    const { kernel, source, body } = await world();
    kernel.step(DT);
    const coat = kernel.world.get(body.children[0]!)!;
    expect(coat.prefab).toBe('coat');
    expect(coat.components.get('garment')!['slot']).toBe('torso');
    // Displaced garments are put back on the body's origin.
    coat.transform.position = new Vec3(5, 5, 5);
    for (let i = 0; i < 10; i++) kernel.step(DT);
    expect(coat.transform.position.__eq__(Vec3.ZERO)).toBe(true);

    const bodyAsset = source.get('assets/models/body.glb')!;
    const coatAsset = source.get('assets/models/coat.glb')!;
    const posedBody = source.posed(body.id)!;
    const posedCoat = source.posed(coat.id)!;
    // The coat's model space sits 0.2 m below the body's (its offset is 0, the body's 0.2).
    const bodySpine = translationOf(posedBody.worlds, bodyAsset.nodeByName.get('Spine')!);
    const coatSpine = translationOf(posedCoat.worlds, coatAsset.nodeByName.get('mixamorig:Spine')!);
    expect(coatSpine).toEqual([bodySpine[0]!, bodySpine[1]! + 0.2, bodySpine[2]!]);
    // The spine is bent 90° about z: its +y axis lies along x now (sideways)...
    const s = coatAsset.nodeByName.get('mixamorig:Spine')! * 16;
    const axis = [posedCoat.worlds[s + 4]!, posedCoat.worlds[s + 5]!, posedCoat.worlds[s + 6]!];
    expect(Math.abs(axis[0]!)).toBeCloseTo(1, 3);
    expect(axis[1]).toBeCloseTo(0, 3);
    // ...and the tail, a bone the body lacks, rides it rigidly: 0.5 m along that axis.
    const tail = translationOf(posedCoat.worlds, coatAsset.nodeByName.get('Tail')!);
    expect(tail[0]).toBeCloseTo(coatSpine[0]! + 0.5 * axis[0]!, 3);
    expect(tail[1]).toBeCloseTo(coatSpine[1]!, 3);
  });
});

describe('the wardrobe', () => {
  interface Wardrobe extends Fields {
    wear(garment: string, kw?: object): unknown;
    take_off(slot: string): boolean;
    worn(slot: string): unknown;
    slots(): string[];
  }

  it('wears its outfit as children, tints them, hides what they cover, and takes them off', async () => {
    const { kernel, body } = await world();
    kernel.step(DT);
    const wardrobe = body.components.get('wardrobe') as Wardrobe;
    const live = () => body.children.flatMap((c) => { const r = kernel.world.get(c); return r === undefined ? [] : [r]; });
    const model = body.components.get('model')!;
    expect(wardrobe.slots()).toEqual(['torso']);
    expect(model['parts']).toEqual({ skin_mesh: false });
    expect(wardrobe['hidden']).toEqual(['skin_mesh']);

    // A slot from the prefab's garment; a tint.
    const hat = wardrobe.wear('hat', { tint: Color.hex('#ff0000') });
    expect(hat).not.toBeNull();
    expect(wardrobe.slots()).toEqual(['head', 'torso']);
    const hatRecord = kernel.world.require(kernel.handles.unwrap(hat)!);
    expect((hatRecord.components.get('model')!['tint'] as Color).__eq__(Color.hex('#ff0000'))).toBe(true);
    expect(live().length).toBe(2);

    // Wearing into a taken slot replaces what is there.
    wardrobe.wear('hat', { slot: 'torso' });
    expect(model['parts']).toEqual({});
    expect(live().map((r) => r.prefab).sort()).toEqual(['hat', 'hat']);

    expect(wardrobe.take_off('torso')).toBe(true);
    expect(wardrobe.take_off('torso')).toBe(false);
    expect(live().length).toBe(1);
    expect(wardrobe.worn('torso')).toBeNull();

    // The outfit is data: assigning it dresses on the next frame.
    wardrobe['outfit'] = { torso: 'coat' };
    kernel.step(DT);
    expect(live().map((r) => r.prefab)).toEqual(['coat']);
    expect(model['parts']).toEqual({ skin_mesh: false });
  });
});
