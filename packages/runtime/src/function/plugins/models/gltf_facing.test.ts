import { describe, expect, it } from 'vitest';
import { buildModel, nodeMatrices, restPose, sampleClip, skinPalette } from '../../../resource/index.js';
import type { GltfJson, ModelAsset } from '../../../resource/index.js';
import { gltfParts } from './testing.js';
import type { GlbSpec } from './testing.js';

/**
 * Facing: a plain glTF faces +z (glTF's convention) and a ParallaxPro asset-store file (a
 * root wrapper marked `extras.parallaxproBakedFacing`, turning the model to face -z) both
 * load facing the engine's +z, with their right side at +x.
 */

const WRAPPER = { parallaxproBakedFacing: true, front: '+z', rotationYDegrees: 180 };
/** glTF quaternion for 180° about y (the bake's rotation for a +z-front pack). */
const YAW_180 = [0, 1, 0, 0];

/** A marker mesh in glTF space: a nose vertex on the front axis, a vertex on the model's right, a top vertex. */
function marker(front: 1 | -1): { positions: number[]; normals: number[]; indices: number[] } {
  // Right-handed, +y up: facing +z, the right is -x; facing -z, the right is +x.
  const right = -front;
  return {
    positions: [0, 0, front, right, 0, 0, 0, 1, 0],
    normals: [0, 0, front, right, 0, 0, 0, 1, 0],
    indices: [0, 1, 2],
  };
}

function build(spec: GlbSpec): ModelAsset {
  const { json, bin } = gltfParts(spec);
  return buildModel('m.glb', json as GltfJson, [bin]);
}

/** Model-space positions of a static mesh's vertices (its node's rest matrix applied). */
function placed(model: ModelAsset, node: number): number[][] {
  const worlds = nodeMatrices(model, restPose(model));
  const m = worlds.subarray(node * 16, node * 16 + 16);
  const g = model.meshes[model.nodes[node]!.mesh!]![0]!.geometry;
  const out: number[][] = [];
  for (let v = 0; v < g.positions.length / 3; v++) {
    const [x, y, z] = [g.positions[v * 3]!, g.positions[v * 3 + 1]!, g.positions[v * 3 + 2]!];
    out.push([0, 1, 2].map((r) => m[r]! * x + m[4 + r]! * y + m[8 + r]! * z + m[12 + r]!));
  }
  return out;
}

function close(a: number[], b: number[]): void {
  a.forEach((x, i) => expect(x).toBeCloseTo(b[i]!, 5));
}

describe('glTF facing', () => {
  it('a plain glTF faces +z with its right side at +x', () => {
    const model = build({ nodes: [{ mesh: 0 }], meshes: [marker(1)] });
    const [nose, right, top] = placed(model, 0);
    close(nose!, [0, 0, 1]);
    close(right!, [1, 0, 0]);
    close(top!, [0, 1, 0]);
  });

  it('a ParallaxPro wrapper file (turned to face -z) faces +z with its right side at +x', () => {
    // As the asset store bakes a +z-front pack: the wrapper turns the +z model to -z.
    const model = build({
      nodes: [{ name: 'parallaxpro_baked_facing_root', children: [1], rotation: YAW_180, extras: WRAPPER }, { mesh: 0 }],
      meshes: [marker(1)],
    });
    const [nose, right, top] = placed(model, 1);
    close(nose!, [0, 0, 1]);
    close(right!, [1, 0, 0]);
    close(top!, [0, 1, 0]);
  });

  it('a -x front pack (wrapper turned -90°) faces +z too', () => {
    const s = Math.SQRT1_2;
    // Front -x, right -z in glTF; the bake turns it -90° about y to face -z.
    const model = build({
      nodes: [{ children: [1], rotation: [0, -s, 0, s], extras: { parallaxproBakedFacing: true, front: '-x' } }, { mesh: 0 }],
      meshes: [{ positions: [-1, 0, 0, 0, 0, -1, 0, 1, 0], indices: [0, 1, 2] }],
    });
    const [nose, right] = placed(model, 1);
    close(nose!, [0, 0, 1]);
    close(right!, [1, 0, 0]);
  });

  it('the wrapper\'s translation, scale and any channel on it turn with it', () => {
    const model = build({
      nodes: [{ children: [1], translation: [1, 2, 3], scale: [2, 2, 2], extras: WRAPPER }, { mesh: 0 }],
      meshes: [marker(-1)],
      animations: [{ name: 'bob', channels: [{ node: 0, path: 'translation', times: [0, 1], values: [1, 2, 3, 1, 2, 5] }] }],
    });
    // A -z file without a wrapper rotation: the wrapper only moves and scales it.
    const [nose, right] = placed(model, 1);
    // Mirrored across z: the wrapper's origin lands at (1, 2, -3), the nose 2 m in front of it (+z), the right side 2 m to +x.
    close(nose!, [1, 2, -1]);
    close(right!, [3, 2, -3]);
    const pose = restPose(model);
    sampleClip(model.clips.get('bob')!, 1, pose, null);
    close(Array.from(pose.subarray(0, 3)), [1, 2, -5]);
  });

  it('only a root wrapper turns the file; the nodes below it keep a +z file\'s numbers', () => {
    const plain = build({ nodes: [{ children: [1] }, { mesh: 0, translation: [0.5, 0, 0.25], rotation: [0, 0.6, 0, 0.8] }], meshes: [marker(1)] });
    const wrapped = build({
      nodes: [{ children: [1], extras: WRAPPER }, { mesh: 0, translation: [0.5, 0, 0.25], rotation: [0, 0.6, 0, 0.8] }],
      meshes: [marker(1)],
    });
    expect(wrapped.nodes[1]).toEqual(plain.nodes[1]);
    const nested = build({
      nodes: [{ children: [1] }, { children: [2], extras: WRAPPER }, { mesh: 0 }],
      meshes: [marker(1)],
    });
    close(placed(nested, 2)[0]!, [0, 0, 1]);
  });

  it('a skinned mesh under the wrapper faces +z (inverse bind matrices without the wrapper, as Meshy writes them)', () => {
    // Joint at the origin, identity inverse bind: the wrapper reaches the vertices only through the joint's world.
    const spec: GlbSpec = {
      nodes: [
        { children: [1, 2], rotation: YAW_180, extras: WRAPPER },
        { name: 'hips' },
        { mesh: 0, skin: 0 },
      ],
      meshes: [{ ...marker(1), joints: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], weights: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0] }],
      skins: [{ joints: [1], inverseBind: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }],
    };
    const model = build(spec);
    const palette = skinPalette(model.skins[0]!, nodeMatrices(model, restPose(model)));
    const g = model.meshes[0]![0]!.geometry;
    const skinned = [0, 1, 2].map((v) => {
      const [x, y, z] = [g.positions[v * 3]!, g.positions[v * 3 + 1]!, g.positions[v * 3 + 2]!];
      return [0, 1, 2].map((r) => palette[r]! * x + palette[4 + r]! * y + palette[8 + r]! * z + palette[12 + r]!);
    });
    close(skinned[0]!, [0, 0, 1]);
    close(skinned[1]!, [1, 0, 0]);
  });
});
