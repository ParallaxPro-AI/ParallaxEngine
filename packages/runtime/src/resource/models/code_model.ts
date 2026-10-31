/**
 * A model document (resource/models: `assets/models/<name>.model.json`) → the same
 * `ModelAsset` a glTF file becomes, so everything that draws, poses, skins or collides
 * with models works on it unchanged:
 *
 *   nodes   the skeleton's bones first (bone i is node i), then the parts (part p is node
 *           bones + p), then one unnamed node per drawn part, holding its mesh and its
 *           `size` (a part's size scales its own mesh, never its children)
 *   meshes  the document's meshes, and the engine's unit shapes for shape parts (shared
 *           across models, so equal shapes with equal materials instance together)
 *   skins   one, when the document has a skeleton: every bone, its inverse bind matrix
 *   clips   none: a document has no animations (an Animator plays clips from glTF files
 *           by name, `assets/models/<anims>.glb#run`, onto the skeleton's bones)
 *
 * Materials are the document's, with each option's default choice applied; per-entity
 * looks (other choices, recolors, shown parts) and joints are `code_model_pose.ts`.
 * Documents are already in the engine's handedness: nothing is mirrored here.
 */

import type { Geometry3d, Material3d, MaterialLayers3d, Texture3d } from '../../core/index.js';
import { chosenMaterial } from './rig.js';
import type { ModelDocument, ModelMaterial, ModelMesh } from './format.js';
import type { ModelAsset, ModelNode, ModelPrimitive, ModelSkin } from './gltf.js';
import { capsule, unitShape } from './primitives.js';

/** A document's texture map (an image under assets/, or a hosted image URL), tiling. */
function mapTexture(path: string, colorSpace: 'srgb' | 'linear'): Texture3d {
  // Keyed as render3d keys a repeating image, so a file drawn both ways uploads once.
  return {
    id: colorSpace === 'srgb' ? `${path}|repeat` : `${path}|repeat|linear`,
    source: { kind: 'file', path }, colorSpace, wrapU: 'repeat', wrapV: 'repeat', filter: 'linear',
  };
}

/** A Material3d for a document material, with its texture maps. */
export function codeMaterial(id: string, m: ModelMaterial): Material3d {
  const layered = m.clearcoat > 0 || m.transmission > 0 || m.subsurface > 0 || m.anisotropy !== 0;
  const layers: MaterialLayers3d = {
    clearcoat: m.clearcoat,
    clearcoatRoughness: m.clearcoatRoughness,
    transmission: m.transmission,
    subsurface: m.subsurface,
    subsurfaceColor: m.subsurfaceColor,
    anisotropy: m.anisotropy,
    anisotropyRotation: m.anisotropyRotation,
  };
  return {
    id,
    baseColor: m.color,
    baseColorTexture: m.texture === null ? null : mapTexture(m.texture, 'srgb'),
    metallic: m.metallic,
    roughness: m.roughness,
    metallicRoughnessTexture: null,
    // emissive × emissive_strength (an exporter's emissive may also exceed 1) is its color at
    // peak 1 times a linear strength: an sRGB color clamps at 1 when the surface converts it,
    // and would never bloom.
    ...emissiveOf([m.emissive[0] * m.emissiveStrength, m.emissive[1] * m.emissiveStrength, m.emissive[2] * m.emissiveStrength]),
    emissiveTexture: null,
    ...(m.normalMap !== null && { normalTexture: mapTexture(m.normalMap, 'linear'), normalScale: m.normalStrength }),
    alphaMode: m.alpha,
    alphaCutoff: m.alphaCutoff,
    doubleSided: m.doubleSided,
    unlit: m.unlit,
    ...(layered && { layers }),
  };
}

/** A model document's emissive as the port's color (each channel 0..1) and `emissiveStrength`. */
export function emissiveOf(c: readonly [number, number, number]): { emissive: [number, number, number]; emissiveStrength?: number } {
  const peak = Math.max(c[0], c[1], c[2]);
  if (!(peak > 1)) return { emissive: [c[0], c[1], c[2]] };
  return { emissive: [c[0] / peak, c[1] / peak, c[2] / peak], emissiveStrength: peak };
}

function meshGeometry(id: string, mesh: ModelMesh): Geometry3d {
  const source = mesh.positions;
  const count = source.length / 3;
  const index = (i: number): number => (mesh.indices === null ? i : mesh.indices[i]!);
  const triangles = mesh.indices === null ? count : mesh.indices.length;
  // Without normals a mesh is flat-shaded: every triangle gets its own three vertices.
  const flat = mesh.normals === null;
  const vertexCount = flat ? triangles : count;
  const src = (v: number): number => (flat ? index(v) : v);
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const joints = mesh.joints === null ? null : new Uint16Array(vertexCount * 4);
  const weights = mesh.weights === null ? null : new Float32Array(vertexCount * 4);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < vertexCount; v++) {
    const s = src(v);
    for (let k = 0; k < 3; k++) {
      const p = source[s * 3 + k]!;
      positions[v * 3 + k] = p;
      min[k] = Math.min(min[k]!, p);
      max[k] = Math.max(max[k]!, p);
      if (mesh.normals !== null) normals[v * 3 + k] = mesh.normals[s * 3 + k]!;
    }
    if (mesh.uvs !== null) {
      uvs[v * 2] = mesh.uvs[s * 2]!;
      uvs[v * 2 + 1] = mesh.uvs[s * 2 + 1]!;
    }
    if (joints !== null && weights !== null) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += mesh.weights![s * 4 + k]!;
      for (let k = 0; k < 4; k++) {
        joints[v * 4 + k] = mesh.joints![s * 4 + k]!;
        weights[v * 4 + k] = sum > 0 ? mesh.weights![s * 4 + k]! / sum : k === 0 ? 1 : 0;
      }
    }
  }
  const indices = vertexCount > 65535 ? new Uint32Array(triangles) : new Uint16Array(triangles);
  for (let i = 0; i < triangles; i++) indices[i] = flat ? i : index(i);
  if (flat) {
    for (let i = 0; i + 2 < triangles; i += 3) {
      const a = i * 3; const b = (i + 1) * 3; const c = (i + 2) * 3;
      const e1 = [positions[b]! - positions[a]!, positions[b + 1]! - positions[a + 1]!, positions[b + 2]! - positions[a + 2]!];
      const e2 = [positions[c]! - positions[a]!, positions[c + 1]! - positions[a + 1]!, positions[c + 2]! - positions[a + 2]!];
      const n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
      const l = Math.hypot(n[0]!, n[1]!, n[2]!) || 1;
      for (const at of [a, b, c]) for (let k = 0; k < 3; k++) normals[at + k] = n[k]! / l;
    }
  }
  return {
    id, positions, normals, uvs, indices, joints, weights, colors: null,
    min: vertexCount === 0 ? [0, 0, 0] : [min[0]!, min[1]!, min[2]!],
    max: vertexCount === 0 ? [0, 0, 0] : [max[0]!, max[1]!, max[2]!],
  };
}

const capsules = new Map<string, Geometry3d>();
/** Copies of a geometry with its uvs scaled (a part's uv_scale), by geometry. */
const uvScaled = new WeakMap<Geometry3d, Map<string, Geometry3d>>();

/** `geometry` with its uvs multiplied by `scale` (shared: equal shapes at equal scales instance together). */
function withUvScale(geometry: Geometry3d, scale: readonly [number, number]): Geometry3d {
  if (scale[0] === 1 && scale[1] === 1) return geometry;
  let byScale = uvScaled.get(geometry);
  if (byScale === undefined) {
    byScale = new Map();
    uvScaled.set(geometry, byScale);
  }
  const key = `${scale[0]},${scale[1]}`;
  let made = byScale.get(key);
  if (made === undefined) {
    const uvs = new Float32Array(geometry.uvs.length);
    for (let i = 0; i < uvs.length; i += 2) {
      uvs[i] = geometry.uvs[i]! * scale[0];
      uvs[i + 1] = geometry.uvs[i + 1]! * scale[1];
    }
    made = { ...geometry, id: `${geometry.id}@uv${key}`, uvs };
    byScale.set(key, made);
  }
  return made;
}

/** A capsule part's geometry and the scale its mesh node keeps: round ends of radius x / 2, stretched along z. */
function capsuleOf(size: readonly [number, number, number]): { geometry: Geometry3d; scale: [number, number, number] } {
  const radius = size[0] / 2;
  const height = Math.max(size[1], size[0]);
  const key = `${radius}:${height}`;
  let geometry = capsules.get(key);
  if (geometry === undefined) {
    geometry = capsule(radius, height);
    capsules.set(key, geometry);
  }
  return { geometry, scale: [1, 1, size[2] / size[0]] };
}

export function buildCodeModel(doc: ModelDocument): ModelAsset {
  const bones = doc.skeleton?.bones ?? [];
  const nodes: (ModelNode & { children: number[] })[] = [];
  const partNode: number[] = [];
  const boneNode: number[] = [];
  bones.forEach((bone, i) => {
    boneNode.push(nodes.length);
    nodes.push({
      name: bone.name, parent: bone.parent, children: [], translation: bone.position, rotation: bone.rotation, scale: bone.scale,
      mesh: null, skin: null,
    });
    if (bone.parent !== -1) nodes[bone.parent]!.children.push(i);
  });
  doc.parts.forEach((part) => {
    const index = nodes.length;
    partNode.push(index);
    const parent = part.parent === null ? -1 : part.parent.kind === 'bone' ? boneNode[part.parent.index]! : partNode[part.parent.index]!;
    nodes.push({
      name: part.name, parent, children: [], translation: part.position, rotation: part.rotation, scale: part.scale, mesh: null, skin: null,
    });
    if (parent !== -1) nodes[parent]!.children.push(index);
  });

  const meshes: ModelPrimitive[][] = [];
  const meshPart: number[] = [];
  const geometries = new Map<string, Geometry3d>();
  const materials = new Map<string, Material3d>();
  const material = (name: string): Material3d => {
    let made = materials.get(name);
    if (made === undefined) {
      made = codeMaterial(`${doc.path}#material:${name}`, chosenMaterial(doc, name, {}));
      materials.set(name, made);
    }
    return made;
  };
  doc.parts.forEach((part, p) => {
    if (part.draws === null || part.material === null) return;
    let geometry: Geometry3d;
    let scale: readonly [number, number, number] = part.size;
    if ('mesh' in part.draws) {
      const name = part.draws.mesh;
      let made = geometries.get(name);
      if (made === undefined) {
        made = meshGeometry(`${doc.path}#mesh:${name}`, doc.meshes.get(name)!);
        geometries.set(name, made);
      }
      geometry = made;
    } else if (part.draws.shape === 'capsule') {
      ({ geometry, scale } = capsuleOf(part.size));
    } else {
      geometry = unitShape(part.draws.shape);
    }
    geometry = withUvScale(geometry, part.uvScale);
    const holder = partNode[p]!;
    const index = nodes.length;
    meshes.push([{ geometry, material: material(part.material), materialName: part.material }]);
    meshPart.push(p);
    nodes.push({
      name: '', parent: holder, children: [], translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale,
      mesh: meshes.length - 1, skin: part.skinned ? 0 : null,
    });
    nodes[holder]!.children.push(index);
  });

  const roots = nodes.flatMap((n, i) => (n.parent === -1 ? [i] : []));
  const order: number[] = [];
  const visit = (i: number): void => {
    order.push(i);
    nodes[i]!.children.forEach(visit);
  };
  roots.forEach(visit);
  const skins: ModelSkin[] = doc.skeleton === null ? [] : [{ joints: boneNode, inverseBind: doc.skeleton.inverseBind }];
  const nodeByName = new Map<string, number>();
  nodes.forEach((n, i) => { if (n.name !== '') nodeByName.set(n.name, i); });
  return {
    path: doc.path, nodes, roots, order, meshes, skins, clips: new Map(), nodeByName, warnings: [],
    code: { document: doc, partNode, boneNode, meshPart },
  };
}
