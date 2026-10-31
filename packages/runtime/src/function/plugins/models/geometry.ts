/**
 * A loaded model's triangles as one indexed list in model space — what render3d draws
 * for an entity without an animator, before `Model.offset` — for the model geometry
 * service (physics3d's mesh and convex colliders, nav's static world).
 *
 * Every mesh node reachable from the default scene, in the rest pose: a static mesh is
 * placed by its node's model-space matrix (a model document's: its joints at their
 * defaults, and only the parts it shows with every option at its default); a skinned mesh is skinned on the CPU with the
 * rest pose's bone palette (its bind pose when the rest pose is the bind pose), exactly as
 * the GPU would skin it. Winding is the loader's (front faces counter-clockwise, engine
 * handedness).
 */

import type { ModelGeometry } from '../../services/index.js';
import { applyJoints, jointValues, lookOf } from '../../../resource/index.js';
import { nodeMatrices, restPose, skinPalette } from '../../../resource/index.js';
import type { ModelAsset } from '../../../resource/index.js';

export function modelGeometry(model: ModelAsset): ModelGeometry {
  const doc = model.code?.document;
  const rest = nodeMatrices(model, restPose(model));
  const worlds = doc === undefined ? rest : applyJoints(model, rest, jointValues(doc, {}, 0, model.path));
  const hidden = doc === undefined ? null : lookOf(model, {}, model.path).hidden;
  const vertices: number[] = [];
  const indices: number[] = [];
  const palettes = new Map<number, Float32Array>();
  for (const n of model.order) {
    const node = model.nodes[n]!;
    if (node.mesh === null || hidden?.[n] === 1) continue;
    for (const primitive of model.meshes[node.mesh] ?? []) {
      const g = primitive.geometry;
      const first = vertices.length / 3;
      const count = g.positions.length / 3;
      if (node.skin !== null && g.joints !== null && g.weights !== null) {
        let palette = palettes.get(node.skin);
        if (palette === undefined) {
          palette = skinPalette(model.skins[node.skin]!, worlds);
          palettes.set(node.skin, palette);
        }
        for (let v = 0; v < count; v++) {
          const x = g.positions[v * 3]!;
          const y = g.positions[v * 3 + 1]!;
          const z = g.positions[v * 3 + 2]!;
          let ox = 0;
          let oy = 0;
          let oz = 0;
          for (let k = 0; k < 4; k++) {
            const w = g.weights[v * 4 + k]!;
            if (w === 0) continue;
            const m = palette.subarray(g.joints[v * 4 + k]! * 16);
            ox += w * (m[0]! * x + m[4]! * y + m[8]! * z + m[12]!);
            oy += w * (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!);
            oz += w * (m[2]! * x + m[6]! * y + m[10]! * z + m[14]!);
          }
          vertices.push(ox, oy, oz);
        }
      } else {
        const m = worlds.subarray(n * 16, n * 16 + 16);
        for (let v = 0; v < count; v++) {
          const x = g.positions[v * 3]!;
          const y = g.positions[v * 3 + 1]!;
          const z = g.positions[v * 3 + 2]!;
          vertices.push(m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!, m[2]! * x + m[6]! * y + m[10]! * z + m[14]!);
        }
      }
      for (const i of g.indices) indices.push(first + i);
    }
  }
  return { vertices: new Float32Array(vertices), indices: new Uint32Array(indices) };
}
