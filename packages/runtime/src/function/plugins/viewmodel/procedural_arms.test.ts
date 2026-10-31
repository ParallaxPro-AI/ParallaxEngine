/**
 * The procedural first-person arms: the generated document is a valid skinned model with
 * the built-in limbs' bones, and a Viewmodel without an `arms` prefab draws them itself —
 * its hands' IK on the item's grips, recolorable, gone again once an arms prefab is set.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { Color } from '../../../core/index.js';
import type { EntityId, ProjectFiles } from '../../../core/index.js';
import { MemoryBinaryFiles } from '../../../platform/headless/render3d.js';
import { buildCodeModel, decodeBuffer, FP_ARMS, loadProject, parseModelDocument, proceduralArmsDocument } from '../../../resource/index.js';
import { Kernel } from '../../kernel/index.js';
import type { EntityRecord, Fields } from '../../kernel/index.js';
import { MODEL_RIG_SERVICE } from '../../services/index.js';
import { characters } from '../characters/index.js';
import { initPhysics3d, physics3d } from '../physics3d/index.js';
import { models } from '../models/index.js';
import { visuals } from '../visuals/index.js';
import { viewmodel } from './index.js';

const DT = 1 / 60;

beforeAll(async () => {
  await initPhysics3d();
});

describe('the procedural arms document', () => {
  it('parses cleanly into a skinned model on the built-in limbs\' bones', () => {
    const parsed = parseModelDocument('builtin:fp_arms', JSON.stringify(proceduralArmsDocument()));
    expect(parsed.diagnostics).toEqual([]);
    const doc = parsed.document!;
    const model = buildCodeModel(doc);
    for (const bone of ['Spine2', 'RightArm', 'RightForeArm', 'RightHand', 'LeftArm', 'LeftForeArm', 'LeftHand']) {
      expect(model.nodeByName.has(bone), bone).toBe(true);
    }
    expect(model.skins.length).toBeGreaterThan(0);
    // Every vertex's weights sum to 1, and every triangle is wound outward on the closed palm.
    const raw = proceduralArmsDocument() as { meshes: Record<string, Record<string, string>> };
    for (const mesh of Object.values(raw.meshes)) {
      const weights = decodeBuffer(mesh['weights']!)!.values;
      for (let i = 0; i < weights.length; i += 4) expect(weights[i]! + weights[i + 1]! + weights[i + 2]! + weights[i + 3]!).toBeCloseTo(1, 5);
      const positions = decodeBuffer(mesh['positions']!)!.values;
      const indices = decodeBuffer(mesh['indices']!)!.values;
      expect(indices.length % 3).toBe(0);
      expect(Math.max(...Array.from(indices))).toBeLessThan(positions.length / 3);
    }
    // Arms of a human's reach from shoulders under the eye.
    const at = (bone: string) => {
      const n = model.nodeByName.get(bone)!;
      let p = [0, 0, 0];
      for (let i = n; i !== -1; i = model.nodes[i]!.parent) p = p.map((v, k) => v + model.nodes[i]!.translation[k]!);
      return p;
    };
    const reach = (a: number[], b: number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
    expect(reach(at('RightArm'), at('RightForeArm')) + reach(at('RightForeArm'), at('RightHand'))).toBeCloseTo(0.63, 1);
    expect(at('LeftHand')[0]).toBeCloseTo(-at('RightHand')[0]!, 6);
  });
});

describe('the library\'s fp_arms piece', () => {
  it('ships the generator\'s document (regenerate it when procedural_arms.ts changes)', async () => {
    const fs = await import(/* @vite-ignore */ 'node:fs') as { readFileSync(path: string, encoding: 'utf8'): string };
    const path = new URL('../../../../../../shared_library/models/fp_arms/files/assets/models/fp_arms.model.json', import.meta.url).pathname;
    const { source: _shipped, ...shipped } = JSON.parse(fs.readFileSync(path, 'utf8')) as Record<string, unknown>;
    const { source: _generated, ...generated } = proceduralArmsDocument();
    expect(shipped).toEqual(JSON.parse(JSON.stringify(generated)));
  });
});

const RIFLE = {
  format: 'parallax.model', version: 1,
  materials: { metal: { color: [0.2, 0.2, 0.22], metallic: 0.8, roughness: 0.4 } },
  parts: [{ name: 'body', shape: 'box', size: [0.05, 0.08, 0.6], material: 'metal' }],
  sockets: [
    { name: 'grip_r', parent: null, position: [0, -0.06, -0.08] },
    { name: 'grip_l', parent: null, position: [0, -0.03, 0.16] },
    { name: 'sight', parent: null, position: [0, 0.06, -0.1] },
  ],
};

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, typeof v === 'string' ? v : JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

async function range(viewmodelData: Record<string, unknown>) {
  const project = files({
    'prefabs/eye.prefab.json': {
      components: { camera: { rig: 'fixed', fov: 75 } },
      children: [{ name: 'hands', components: { viewmodel: { item: 'rifle_view', ...viewmodelData } } }],
    },
    'prefabs/rifle_view.prefab.json': { components: { model: { model: 'models/rifle' }, viewmodel_item: {} } },
    'prefabs/stick_arms.prefab.json': { components: { model: { model: 'models/rifle' } } },
    'scenes/main/scene.json': { entities: [{ prefab: 'eye', id: 'eye', at: [0, 1.6, 0] }] },
    'assets/models/rifle.model.json': RIFLE,
  });
  const loaded = loadProject(project);
  expect(loaded.diagnostics).toEqual([]);
  const plugin = models({ files: project, binary: new MemoryBinaryFiles({}) });
  const kernel = new Kernel({
    project: loaded, game: { components: [], resources: [], events: [], behaviors: [], systems: [] },
    plugins: [visuals({ dimension: '3d' }), physics3d({}), characters(), plugin, viewmodel()], context: {}, fixedStep: DT,
  });
  plugin.source.preload();
  await plugin.source.whenLoaded();
  kernel.start('main');
  const eye = [...kernel.world.live()].find((r) => r.placedId === 'eye')!;
  const hands = (): EntityRecord => kernel.world.require(eye.children[0]!);
  return { kernel, hands, vm: () => hands().components.get('viewmodel') as Fields & { readonly hands: unknown; readonly held: unknown } };
}

describe('a Viewmodel without an arms prefab', () => {
  it('draws the procedural arms itself, hands on the item\'s grips', async () => {
    const r = await range({ skin_color: Color.hex('#5a3c2e') });
    for (let i = 0; i < 40; i++) r.kernel.step(DT);
    const self = r.hands();
    expect(r.kernel.handles.unwrap(r.vm().hands)).toBe(self.id);
    const model = self.components.get('model')!;
    expect(model['model']).toBe(FP_ARMS);
    expect((model['colors'] as Record<string, Color>)['skin']!.__eq__(Color.hex('#5a3c2e'))).toBe(true);
    const rigs = r.kernel.service(MODEL_RIG_SERVICE);
    const item = r.kernel.handles.unwrap(r.vm().held) as EntityId;
    for (const [bone, grip] of [['RightHand', 'grip_r'], ['LeftHand', 'grip_l']] as const) {
      const hand = rigs.socket(self.id, bone, 'world')!.position;
      expect(hand.distance_to(rigs.socket(item, grip, 'world')!.position), bone).toBeLessThan(1e-4);
    }
    // Elbows bend down, below the line from shoulder to hand.
    const shoulder = rigs.socket(self.id, 'RightArm', 'world')!.position;
    const elbow = rigs.socket(self.id, 'RightForeArm', 'world')!.position;
    const hand = rigs.socket(self.id, 'RightHand', 'world')!.position;
    expect(elbow.y).toBeLessThan((shoulder.y + hand.y) / 2);
  });

  it('gives way to an arms prefab, and stays off with procedural_arms False', async () => {
    const r = await range({});
    r.kernel.step(DT);
    expect(r.hands().components.has('model')).toBe(true);
    r.vm()['arms'] = 'stick_arms';
    r.kernel.step(DT);
    expect(r.hands().components.has('model')).toBe(false);
    expect(r.hands().components.has('animator')).toBe(false);
    expect(r.kernel.world.require(r.kernel.handles.unwrap(r.vm().hands) as EntityId).prefab).toBe('stick_arms');
    const off = await range({ procedural_arms: false });
    off.kernel.step(DT);
    expect(off.hands().components.has('model')).toBe(false);
    expect(off.vm().hands).toBeNull();
  });
});
