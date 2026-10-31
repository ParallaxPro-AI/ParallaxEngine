/**
 * Generated world meshes drawn (the procgen plugin's `meshes()`: swept tracks and roads,
 * structures, dungeons, smooth voxels; the surfaces plugin's `overlays()`: coverage masks
 * and scalar fields). Each part becomes one instance at its mesh's world matrix, with a
 * material built once per `GeneratedMaterial.id`. Part geometries are versioned (their id
 * changes when rebuilt), so a surface keeps their GPU buffers until they change.
 */

import type { Material3d, MeshBatch, Texture3d } from '../../../core/index.js';
import type { GeneratedMaterial, GeneratedMesh } from '../../services/index.js';

const WHITE = [1, 1, 1, 1] as const;

export class GeneratedDraws {
  readonly #materials = new Map<string, Material3d>();

  #material(m: GeneratedMaterial, texture: (path: string, data?: boolean) => Texture3d): Material3d {
    let material = this.#materials.get(m.id);
    if (material === undefined) {
      material = {
        id: `generated:${m.id}`,
        baseColor: m.color,
        baseColorTexture: m.texture === null ? null : texture(m.texture),
        metallic: m.metallic,
        roughness: m.roughness,
        metallicRoughnessTexture: null,
        emissive: [0, 0, 0],
        emissiveTexture: null,
        alphaMode: m.blend ? 'blend' : 'opaque',
        alphaCutoff: 0.5,
        doubleSided: m.doubleSided,
        unlit: m.unlit,
        ...(m.normal !== undefined && m.normal !== null && { normalTexture: texture(m.normal, true) }),
      };
      this.#materials.set(m.id, material);
    }
    return material;
  }

  /** One batch per part of every mesh. */
  draws(meshes: readonly GeneratedMesh[], texture: (path: string, data?: boolean) => Texture3d): MeshBatch[] {
    const out: MeshBatch[] = [];
    for (const mesh of meshes) {
      for (const part of mesh.parts) {
        if (part.geometry.indices.length === 0) continue;
        const instances = new Float32Array(20);
        instances.set(mesh.world, 0);
        instances.set(WHITE, 16);
        const material = this.#material(part.material, texture);
        out.push({
          geometry: part.geometry, material, count: 1, instances, entities: [mesh.entity],
          castShadows: part.castShadows && material.alphaMode !== 'blend',
        });
      }
    }
    return out;
  }
}
