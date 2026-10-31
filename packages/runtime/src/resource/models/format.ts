/**
 * Parallax model documents (`assets/models/<name>.model.json`): a 3D model as plain data —
 * named parts in a hierarchy, triangle meshes and engine shapes, named materials, a
 * skeleton, and the model's own controls: pose joints (hinges, sliders, scale joints),
 * sockets (named frames things attach to or effects come from) and customization options.
 * A tool can export models to this format; a hand-written one is just as valid.
 *
 * A model document is a project file like any data file: one JSON text, read with the
 * project, so its rig (joints, sockets, options, parts) is known everywhere — headless
 * playtests, servers and `parallax check` — and its meshes need no separate binary.
 *
 * Conventions (the engine's, `core/ports/render3d.ts`): y up, +x right, +z forward
 * (left-handed), meters; a rotation is Euler degrees [pitch, yaw, roll] (as a Transform's
 * and a scene's `rotation`: yaw about y, then pitch about x, then roll about z) or a unit
 * quaternion [x, y, z, w] (what exporters write); either is stored as a quaternion. Colors are sRGB as
 * authored (`[r, g, b]`, `[r, g, b, a]` 0..1, or "#rrggbb").
 *
 * The spec has two halves. The core below is everything a hand-written model uses: parts
 * drawn as engine shapes, materials, joints, sockets and options. The appendix after it is
 * what exporters write (triangle meshes, a skeleton and skinning, advanced material layers);
 * a hand-written model never needs it.
 *
 * ── Core ────────────────────────────────────────────────────────────────────────────────
 *
 * The file, key by key (everything not marked required has the default shown):
 *
 *   format      "parallax.model" (required)
 *   version     1 (required)
 *   source      provenance, free text
 *   provides    tags a socket's `accepts` matches when this model is attached to one
 *   materials   { name: Material } (required, may be empty)
 *   parts       [Part] — parents before children (required)
 *   joints      [Joint]
 *   sockets     [Socket]
 *   options     [Option]
 *
 *   Material  The same names and defaults as the 3D `shape` component's: color (required);
 *             metallic 0; roughness 0.5; emissive [0,0,0] with emissive_strength 1 (a
 *             multiplier, no upper bound: above 1 glows past white and blooms); texture
 *             (sRGB, multiplied by color) and normal_map (tangent space, glTF convention)
 *             with normal_strength 1, each null (none), an image under assets/
 *             ("assets/images/…png") or a hosted image URL
 *             ("https://r2.parallaxpro.ai/assets/image_texture/…jpg", core/remote_assets.ts),
 *             tiled by the part's uv_scale; alpha "opaque" | "blend" | "mask"; alpha_cutoff
 *             0.5; double_sided false; unlit false.
 *   Part      name (required, unique among parts and bones), parent (a part name, or null:
 *             the model root), position [0,0,0], rotation [0,0,0], scale [1,1,1]; what it
 *             draws: shape ("box", "sphere", "cylinder", "cone", "capsule", "plane" — the
 *             `shape` component's 3D kinds; a plane is flat on x and z, facing +y) with
 *             size [1,1,1] (its full extents) and material (required with a shape);
 *             uv_scale [1,1] (how often its material's maps tile on it); cast_shadows true;
 *             hidden false (hidden by default; options and `Model.parts` can show it).
 *             A part that draws nothing is a pivot or a group.
 *   Joint     name (required), part (required: the part it moves), type "hinge" |
 *             "slider" | "scale" (required), kind "pose" | "aperture" (doors, lids and
 *             drawers are apertures), axis (required, normalized), limits [min, max]
 *             (required for sliders and scale joints; a hinge without limits turns
 *             freely), default, duration 0.5 (seconds `open`/`close` take).
 *             Values are in the joint's own units, measured from the part's authored
 *             transform: a hinge turns the part by `value` degrees about `axis` (in the
 *             parent's frame) around its own origin; a slider moves it `value` meters along
 *             `axis` (parent frame); a scale joint multiplies its scale by `value` on the
 *             axes `axis` names. Defaults: 0 (hinge, slider), 1 (scale), clamped to limits.
 *             Pivot rule: a hinge turns about its part's origin (`position`), not the
 *             centre of what it draws, so a lid or door is an empty pivot part placed on
 *             the hinge line with the visible shape as its child, offset from it (a box
 *             hinged on itself spins about its middle). Direction: positive degrees turn
 *             by the right-hand rule componentwise — about [1,0,0] +y turns towards +z,
 *             about [0,1,0] +z towards +x, about [0,0,1] +x towards +y; a negated axis
 *             turns the other way (a lid hinged at its -z edge opens upwards about
 *             [-1,0,0]).
 *   Socket    name (required), parent (a part name, or null), position, rotation,
 *             kind (what it is for: "exhaust", "muzzle", …), accepts (tags; absent: anything),
 *             limit (most entities attached at once; absent: no limit)
 *   Option    name (required), default (required), and either
 *               { "materials": [material names], "choices": { choice: Material keys } } —
 *               a choice sets those keys (any of Material's, none required) on each of
 *               the materials — several options may change one material (a wood type
 *               and a finish over it): they apply in document order, a later option's
 *               keys over an earlier one's — or
 *               { "parts": [part names], "choices": { choice: [part names shown] } } — a
 *               choice shows its parts and hides the axis's others.
 *             What the model shows with no choice made is each option's default.
 *
 * ── Appendix: what exporters produce ────────────────────────────────────────────────────
 *
 * Meshes, skeletons, skinning and layered materials come from exporters (glTF, the
 * code-model exporter); they are valid by hand but nobody writes base64 buffers by hand.
 *
 *   meshes      { name: Mesh } at the root; a Part draws one with `mesh` (a mesh name)
 *               instead of `shape`, its `size` then the mesh's own scale (applied to this
 *               part's mesh only — not to its children). Maps tile across the mesh's uvs.
 *   skeleton    { bones: [Bone], inverse_bind: "f32:…" } at the root (inverse_bind: 16
 *               numbers per bone, column-major, model space → the bone's bind space).
 *               A part's or socket's `parent` may name a bone as well as a part.
 *
 *   Mesh      positions (required), normals (absent: flat), uvs (absent: 0), indices
 *             (absent: 0, 1, 2, …), joints + weights (both or neither; 4 per vertex).
 *             Buffers are little-endian base64 with their element type as a prefix:
 *             "f32:…" (positions, normals, uvs, weights, inverse bind matrices),
 *             "u16:…" / "u32:…" (indices, joint indices).
 *   Bone      name (required), parent (bone index or null), position, rotation, scale —
 *             the bind pose, relative to the parent bone
 *   Skinning  a mesh with joints + weights is skinned by the skeleton; a part drawing it
 *             is in model space: it has no parent, transform or size.
 *   Material  advanced layers: clearcoat 0, clearcoat_roughness 0, transmission 0,
 *   layers    subsurface 0, subsurface_color [1,1,1], anisotropy 0, anisotropy_rotation 0
 *             (degrees). Exporters may also write an emissive color above 1 (it is
 *             multiplied by emissive_strength like any other).
 *
 * Renamed keys are errors with the new name as the fix (PP1003): a material's
 * base_color_map is `texture`, normal_scale is `normal_strength`.
 */

import type { Rgb, Rgba } from '../../core/index.js';

export const MODEL_FORMAT = 'parallax.model';
export const MODEL_VERSION = 1;
/** Files the loader treats as model documents. */
export const MODEL_DOCUMENT = /\.model\.json$/;

/** The `shape` component's 3D kinds. */
export type ModelShape = 'box' | 'sphere' | 'cylinder' | 'cone' | 'capsule' | 'plane';
export const MODEL_SHAPES: readonly ModelShape[] = ['box', 'sphere', 'cylinder', 'cone', 'capsule', 'plane'];

/** Material defaults, the same as the `shape` component's (visuals/schemas.ts SHAPE_SCHEMA). */
export const MATERIAL_DEFAULTS = { metallic: 0, roughness: 0.5, emissiveStrength: 1, normalStrength: 1 } as const;

/** Material keys renamed to the `shape` component's names: old → new. */
export const RENAMED_MATERIAL_KEYS: Readonly<Record<string, string>> = { base_color_map: 'texture', normal_scale: 'normal_strength' };

export type Vec3Tuple = readonly [number, number, number];
export type QuatTuple = readonly [number, number, number, number];

export interface ModelMaterial {
  readonly name: string;
  readonly color: Rgba;
  readonly metallic: number;
  readonly roughness: number;
  readonly emissive: Rgb;
  /** Multiplies `emissive` (linear, no upper bound). */
  readonly emissiveStrength: number;
  readonly alpha: 'opaque' | 'blend' | 'mask';
  readonly alphaCutoff: number;
  readonly doubleSided: boolean;
  readonly unlit: boolean;
  readonly clearcoat: number;
  readonly clearcoatRoughness: number;
  readonly transmission: number;
  readonly subsurface: number;
  readonly subsurfaceColor: Rgb;
  readonly anisotropy: number;
  /** Degrees. */
  readonly anisotropyRotation: number;
  /** An image under assets/ or a hosted image URL (canonical); null: none. */
  readonly texture: string | null;
  readonly normalMap: string | null;
  readonly normalStrength: number;
}

export interface ModelMesh {
  readonly name: string;
  readonly positions: Float32Array;
  readonly normals: Float32Array | null;
  readonly uvs: Float32Array | null;
  readonly indices: Uint16Array | Uint32Array | null;
  readonly joints: Uint16Array | null;
  readonly weights: Float32Array | null;
}

export interface ModelBone {
  readonly name: string;
  /** Bone index, or -1 for a root bone. */
  readonly parent: number;
  readonly position: Vec3Tuple;
  /** Authored as Euler degrees or a quaternion; stored as a quaternion. */
  readonly rotation: QuatTuple;
  readonly scale: Vec3Tuple;
}

export interface ModelSkeleton {
  readonly bones: readonly ModelBone[];
  /** 16 numbers per bone, column-major: model space → the bone's bind space. */
  readonly inverseBind: Float32Array;
}

/** What a part, joint target or socket hangs from: another part, a bone, or the model root. */
export type ModelParent =
  | { readonly kind: 'part'; readonly index: number }
  | { readonly kind: 'bone'; readonly index: number }
  | null;

export interface ModelPart {
  readonly name: string;
  readonly parent: ModelParent;
  readonly position: Vec3Tuple;
  readonly rotation: QuatTuple;
  readonly scale: Vec3Tuple;
  /** What it draws (null: a pivot or group). */
  readonly draws: { readonly mesh: string } | { readonly shape: ModelShape } | null;
  /** Shape extents, or the mesh's own scale. */
  readonly size: Vec3Tuple;
  readonly material: string | null;
  /** Multiplies the uvs its material's maps are sampled at. */
  readonly uvScale: readonly [number, number];
  readonly castShadows: boolean;
  /** Hidden until an option or `Model.parts` shows it. */
  readonly hidden: boolean;
  /** Its mesh is skinned (model space, posed by the skeleton). */
  readonly skinned: boolean;
}

export type JointType = 'hinge' | 'slider' | 'scale';

export interface ModelJoint {
  readonly name: string;
  /** Index into `parts`. */
  readonly part: number;
  readonly type: JointType;
  readonly kind: 'pose' | 'aperture';
  /** Unit vector. */
  readonly axis: Vec3Tuple;
  /** null: a hinge that turns freely. */
  readonly limits: readonly [number, number] | null;
  readonly default: number;
  /** Seconds `open()` / `close()` take. */
  readonly duration: number;
}

export interface ModelSocket {
  readonly name: string;
  readonly parent: ModelParent;
  readonly position: Vec3Tuple;
  readonly rotation: QuatTuple;
  readonly kind: string | null;
  /** null: anything attaches. */
  readonly accepts: readonly string[] | null;
  /** null: no limit. */
  readonly limit: number | null;
}

/** Material keys a material option's choice sets (the rest keep the material's own). */
export type MaterialOverride = Partial<Omit<ModelMaterial, 'name'>>;

export type ModelOption =
  | {
    readonly name: string;
    readonly kind: 'material';
    readonly default: string;
    /** The materials a choice changes. */
    readonly materials: readonly string[];
    readonly choices: ReadonlyMap<string, MaterialOverride>;
  }
  | {
    readonly name: string;
    readonly kind: 'parts';
    readonly default: string;
    /** Every part the axis switches (part indices). */
    readonly parts: readonly number[];
    /** choice → the parts it shows (part indices). */
    readonly choices: ReadonlyMap<string, readonly number[]>;
  };

/** A parsed, validated model document. */
export interface ModelDocument {
  readonly path: string;
  readonly source: string | null;
  readonly provides: readonly string[];
  readonly materials: ReadonlyMap<string, ModelMaterial>;
  readonly meshes: ReadonlyMap<string, ModelMesh>;
  readonly skeleton: ModelSkeleton | null;
  readonly parts: readonly ModelPart[];
  readonly partByName: ReadonlyMap<string, number>;
  readonly boneByName: ReadonlyMap<string, number>;
  readonly joints: ReadonlyMap<string, ModelJoint>;
  readonly sockets: ReadonlyMap<string, ModelSocket>;
  readonly options: ReadonlyMap<string, ModelOption>;
}
