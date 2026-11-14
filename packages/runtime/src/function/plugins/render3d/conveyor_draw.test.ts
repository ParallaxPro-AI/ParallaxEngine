import { describe, expect, it } from 'vitest';
import { buildCodeModel, parseModelDocument } from '../../../resource/index.js';
import type { ModelAsset } from '../../../resource/index.js';
import type { ModelPoseSource } from '../../services/index.js';
import { ConveyorNet } from '../conveyors/index.js';
import { ConveyorDraws } from './conveyor_draw.js';
import { Batches } from './draw.js';

function asset(): ModelAsset {
  const doc = {
    format: 'parallax.model', version: 1,
    materials: { body: { color: '#ff8800' } },
    parts: [
      { name: 'a', shape: 'box', size: [0.2, 0.1, 0.2], material: 'body' },
      { name: 'b', parent: 'a', position: [0, 0.1, 0], shape: 'sphere', size: [0.1, 0.1, 0.1], material: 'body' },
    ],
  };
  const parsed = parseModelDocument('assets/models/ore.model.json', JSON.stringify(doc));
  return buildCodeModel(parsed.document!);
}

function poses(model: ModelAsset): ModelPoseSource {
  return {
    resolve: (ref: string) => ref,
    get: (path: string) => (path === 'models/ore' ? model : undefined),
  } as unknown as ModelPoseSource;
}

describe('conveyor items drawn', () => {
  it('adds one instance per item per mesh, at the lane point, in batches shared across items', () => {
    const net = new ConveyorNet();
    net.look('ore', { model: 'models/ore', scale: 2, lift: 0.5 });
    const lane = net.lane([[0, 0, 0], [10, 0, 0]], { speed: 1, spacing: 0.25 });
    for (let i = 0; i < 40; i++) net.push(lane, 'ore', i * 0.25);
    net.push(lane, 'hidden_kind', 9.9);
    const batches = new Batches();
    new ConveyorDraws().draw(net, poses(asset()), batches, 1);
    const meshes = batches.close();
    // Two parts, two batches, forty instances each: the unlooked kind draws nothing.
    expect(meshes.length).toBe(2);
    expect(meshes.map((m) => m.count)).toEqual([40, 40]);
    // The look's scale multiplies the model's own node scale, and the lift raises it.
    const m = meshes[0]!.instances;
    const unit = new ConveyorNet();
    unit.look('ore', { model: 'models/ore', scale: 1, lift: 0 });
    unit.push(unit.lane([[0, 0, 0], [10, 0, 0]], { speed: 1, spacing: 0.25 }), 'ore');
    const plain = new Batches();
    new ConveyorDraws().draw(unit, poses(asset()), plain, 1);
    const u = plain.close()[0]!.instances;
    expect(Math.hypot(m[0]!, m[1]!, m[2]!) / Math.hypot(u[0]!, u[1]!, u[2]!)).toBeCloseTo(2, 5);
    const lifted = new ConveyorNet();
    lifted.look('ore', { model: 'models/ore', scale: 1, lift: 0.5 });
    lifted.push(lifted.lane([[0, 0, 0], [10, 0, 0]], { speed: 1, spacing: 0.25 }), 'ore');
    const up = new Batches();
    new ConveyorDraws().draw(lifted, poses(asset()), up, 1);
    expect(up.close()[0]!.instances[13]! - u[13]!).toBeCloseTo(0.5, 5);
    // Heading +x: the model's +z axis points along +x.
    expect(m[8]! / Math.hypot(m[8]!, m[9]!, m[10]!)).toBeCloseTo(1, 5);
  });

  it('draws nothing while the model is loading', () => {
    const net = new ConveyorNet();
    net.look('ore', { model: 'models/missing', scale: 1, lift: 0 });
    const lane = net.lane([[0, 0, 0], [1, 0, 0]], { speed: 1, spacing: 0.25 });
    net.push(lane, 'ore');
    const batches = new Batches();
    new ConveyorDraws().draw(net, poses(asset()), batches, 1);
    expect(batches.close()).toEqual([]);
  });
});
