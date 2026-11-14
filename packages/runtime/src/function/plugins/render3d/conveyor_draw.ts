/**
 * Conveyor items drawn (the `conveyors` service, function/plugins/conveyors): every item
 * of a kind is one more instance of that kind's model's meshes, at rest pose, turned to
 * the lane's heading. They join the frame's instanced batches like any repeated mesh, so
 * thousands of items cost a few draws.
 */

import { compose, multiply, nodeMatrices, restPose } from '../../../resource/index.js';
import type { ModelAsset } from '../../../resource/index.js';
import { CONVEYOR_ITEM_STRIDE } from '../../services/index.js';
import type { ConveyorSource, ModelPoseSource } from '../../services/index.js';
import type { BatchSink } from './draw.js';

const WHITE: [number, number, number, number] = [1, 1, 1, 1];
const NODE = new Float32Array(16);

export class ConveyorDraws {
  /** Rest node matrices per loaded model. */
  readonly #rest = new WeakMap<ModelAsset, Float32Array>();

  draw(source: ConveyorSource, models: ModelPoseSource, batches: BatchSink, alpha: number): void {
    for (const draw of source.draws(alpha)) {
      if (draw.count === 0) continue;
      const asset = models.get(models.resolve(draw.model, 'conveyors.look() model'));
      if (asset === undefined) continue;
      let rest = this.#rest.get(asset);
      if (rest === undefined) {
        rest = nodeMatrices(asset, restPose(asset));
        this.#rest.set(asset, rest);
      }
      const s = draw.scale;
      const items = draw.items;
      for (let i = 0; i < draw.count; i++) {
        const o = i * CONVEYOR_ITEM_STRIDE;
        const half = items[o + 3]! / 2;
        const at = compose(items[o]!, items[o + 1]!, items[o + 2]!, 0, Math.sin(half), 0, Math.cos(half), s, s, s);
        for (const n of asset.order) {
          const node = asset.nodes[n]!;
          if (node.mesh === null) continue;
          const world = multiply(at, rest.subarray(n * 16, n * 16 + 16), NODE);
          for (const primitive of asset.meshes[node.mesh] ?? []) batches.add(primitive.geometry, primitive.material, false, world, WHITE, null);
        }
      }
    }
  }
}
