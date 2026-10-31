/**
 * Entities → the 3D frame's draws. Reads the shared rendering components by id with the
 * SDK's field names (defined by the visuals plugin):
 *
 *   shape       kind (box, sphere, capsule, cylinder, cone, plane; circle and rect lie
 *               flat on x/z facing up; ring: a torus `thickness` thick, or a flat annulus
 *               `thickness` wide when size.y is 0), size (full extents; flat kinds use x and z),
 *               offset, color, emissive (× emissive_strength), metallic, roughness, texture, uv_scale (repeats),
 *               normal_map + normal_strength, cast_shadows
 *   model       drawn by `model_draw.ts` (posed by the models plugin)
 *   light       kind, color, intensity, range, angle (full cone, degrees), shadows
 *   text_mesh   text spans (`text_mesh.__spans__`), size (line height), color, face_camera
 *   world_bar   value, offset (world meters above the entity), color, `__bands__`, shown
 *   outline     color, width (pixels), through_walls, fill — around the entity's meshes
 *
 * Repeated geometry with one material becomes one instanced batch.
 */

import { BILLBOARD_STRIDE, Color, fail, Vec2, Vec3 } from '../../../core/index.js';
import type {
  BillboardBatch, DrawLayer3d, EntityId, Geometry3d, Light3d, Material3d, MeshBatch, Outline3d, Rgba, Text3d, TextSpan, Texture3d, ViewMask3d,
} from '../../../core/index.js';
import type { EntityRecord, Fields, World } from '../../kernel/index.js';
import type { RenderPoseSource } from '../../services/index.js';
import { refString } from '../../../resource/index.js';
import { skinPalette } from '../../../resource/index.js';
import type { ModelAsset } from '../../../resource/index.js';
import { compose, identity, multiply, normalize3, transformDirection } from '../../../resource/index.js';
import type { M4 } from '../../../resource/index.js';
import { capsule, ring, unitShape } from '../../../resource/index.js';
import type { UnitShape } from '../../../resource/index.js';

export const SHAPE = 'shape';
export const MODEL = 'model';
export const ANIMATOR = 'animator';
export const LIGHT = 'light';
export const TEXT_MESH = 'text_mesh';
export const WORLD_BAR = 'world_bar';
export const PARTICLES = 'particles';
export const CAMERA = 'camera';
export const OUTLINE = 'outline';

/** Shape kinds with no 3D meaning (a polygon's points are 2D). */
const SHAPES_2D = ['polygon'];
/** A world bar's size in meters (the SDK gives it no size field), as in 2D. */
export const BAR_SIZE = [1, 0.12] as const;
const BAR_BACK: Rgba = [0, 0, 0, 0.6];

export function describe(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'object') return value.constructor?.name ?? 'object';
  return JSON.stringify(value);
}

export function rgba(value: unknown, where: string): Rgba {
  if (value instanceof Color) return [value.r, value.g, value.b, value.a];
  return fail('PP3800', `${where} must be a Color, got ${describe(value)}`, { fix: 'Use Color(r, g, b) or Color.hex("#rrggbb").' });
}

export function vec3(value: unknown, where: string): [number, number, number] {
  if (value instanceof Vec3) return [value.x, value.y, value.z];
  return fail('PP3800', `${where} must be a Vec3, got ${describe(value)}`, { fix: 'Pass vec3(x, y, z).' });
}

export function finite(value: unknown, where: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return fail('PP3800', `${where} must be a finite number, got ${describe(value)}`);
}

export function nameOf(record: EntityRecord): string {
  return record.prefab === undefined ? `entity ${record.id}` : `prefab "${record.prefab}"`;
}

// ── Placement ────────────────────────────────────────────────────────────────

export interface Placed3d {
  /** Local → world. */
  readonly m: M4;
  readonly visible: boolean;
}

const ROOT: Placed3d = { m: identity(), visible: true };

/**
 * World matrices and visibility, composed up the hierarchy once per entity per frame.
 * Physics-moved entities are placed at their interpolated render pose (`poses`, the
 * physics plugin's `render_pose` service) instead of their transform's last fixed step.
 */
export class Placements {
  readonly #world: World;
  readonly #cache = new Map<EntityId, Placed3d>();
  readonly #source: () => RenderPoseSource | undefined;
  #poses: RenderPoseSource | undefined;

  constructor(world: World, poses: () => RenderPoseSource | undefined = () => undefined) {
    this.#world = world;
    this.#source = poses;
  }

  /** Forget last frame's placements (call once per frame, before reading any). */
  clear(): void {
    this.#cache.clear();
    this.#poses = this.#source();
  }

  of(record: EntityRecord): Placed3d {
    const cached = this.#cache.get(record.id);
    if (cached !== undefined) return cached;
    const parentRecord = record.parent === null ? undefined : this.#world.peek(record.parent);
    const parent = parentRecord === undefined ? ROOT : this.of(parentRecord);
    const pose = this.#poses?.local(record.id);
    const p = pose?.position ?? record.transform.position;
    const q = pose?.rotation ?? record.transform.rotation;
    const s = record.transform.scale;
    const local = compose(p.x, p.y, p.z, q.x, q.y, q.z, q.w, s.x, s.y, s.z);
    const placed: Placed3d = { m: multiply(parent.m, local), visible: parent.visible && record.visible };
    this.#cache.set(record.id, placed);
    return placed;
  }
}

// ── Materials ────────────────────────────────────────────────────────────────

/** A shape material's tiling and normal map (`Shape.uv_scale`, `normal_map`, `normal_strength`). */
export interface ShapeMaps {
  readonly uvScale: readonly [number, number];
  readonly normal: Texture3d | null;
  readonly normalScale: number;
}

const PLAIN_MAPS: ShapeMaps = { uvScale: [1, 1], normal: null, normalScale: 1 };

/** Shape materials by their settings, and blended copies of model materials (tint alpha below 1). */
export class Materials {
  readonly #byKey = new Map<string, Material3d>();

  shape(
    metallic: number, roughness: number, emissive: Rgba, texture: Texture3d | null, blend: boolean, maps: ShapeMaps = PLAIN_MAPS,
    emissiveStrength = 1,
  ): Material3d {
    const tiled = maps.uvScale[0] !== 1 || maps.uvScale[1] !== 1;
    const key = `shape|${metallic}|${roughness}|${emissive[0]},${emissive[1]},${emissive[2]}|${texture?.id ?? ''}|${blend}`
      + (emissiveStrength === 1 ? '' : `|e${emissiveStrength}`)
      + (tiled ? `|uv${maps.uvScale[0]},${maps.uvScale[1]}` : '')
      + (maps.normal === null ? '' : `|n${maps.normal.id}*${maps.normalScale}`);
    let material = this.#byKey.get(key);
    if (material === undefined) {
      material = {
        ...(tiled && { uvScale: maps.uvScale }),
        ...(maps.normal !== null && { normalTexture: maps.normal, normalScale: maps.normalScale }),
        ...(emissiveStrength !== 1 && { emissiveStrength }),
        id: key,
        baseColor: [1, 1, 1, 1],
        baseColorTexture: texture,
        metallic,
        roughness,
        metallicRoughnessTexture: null,
        emissive: [emissive[0], emissive[1], emissive[2]],
        emissiveTexture: null,
        alphaMode: blend ? 'blend' : 'opaque',
        alphaCutoff: 0.5,
        doubleSided: false,
        unlit: false,
      };
      this.#byKey.set(key, material);
    }
    return material;
  }

  /** One object per material id (a swapped look built each frame keeps its identity). */
  keep(material: Material3d): Material3d {
    // Effect materials (surface_fx.ts) carry this frame's numbers: never an older copy.
    if (material.effects !== undefined) return material;
    const known = this.#byKey.get(material.id);
    if (known !== undefined) return known;
    this.#byKey.set(material.id, material);
    return material;
  }

  blended(material: Material3d): Material3d {
    if (material.alphaMode === 'blend') return material;
    const key = `${material.id}|blend`;
    let copy = this.#byKey.get(key);
    if (copy === undefined) {
      copy = { ...material, id: key, alphaMode: 'blend' };
      this.#byKey.set(key, copy);
    }
    return copy;
  }
}

// ── Batching ─────────────────────────────────────────────────────────────────

/**
 * How an entity's meshes are drawn beyond their geometry and material: the layer (the
 * first-person viewmodel), which views draw them, and a level-of-detail fade. The plain
 * world draw is `WORLD_DRAW`.
 */
export interface DrawStyle {
  readonly layer: DrawLayer3d;
  readonly views: ViewMask3d | undefined;
  /** `MeshBatch.fades` rules. */
  readonly fade: number;
  /** False forces shadows off (the viewmodel layer, a body's own-view copy). */
  readonly shadows: boolean;
}

export const WORLD_DRAW: DrawStyle = { layer: 'world', views: undefined, fade: 1, shadows: true };

interface OpenBatch {
  readonly geometry: Geometry3d;
  readonly material: Material3d;
  readonly castShadows: boolean;
  readonly style: DrawStyle;
  readonly numbers: number[];
  readonly entities: (number | null)[];
  readonly fades: number[];
  faded: boolean;
}

const maskKey = (mask: ViewMask3d | undefined): string => (mask === undefined ? '' : 'only' in mask ? `only:${mask.only}` : `except:${mask.except}`);

/** Where entity draws go: instanced batches, or static chunks to merge (`static_merge.ts`). */
export interface BatchSink {
  add(geometry: Geometry3d, material: Material3d, castShadows: boolean, matrix: ArrayLike<number>, tint: Rgba, entity: number | null, style?: DrawStyle): void;
}

/** A style's batch-key suffix, cached per style object (keys are built per draw, every frame). */
const styleKeys = new WeakMap<DrawStyle, string>();
const styleKey = (style: DrawStyle): string => {
  let key = styleKeys.get(style);
  if (key === undefined) styleKeys.set(style, (key = `${style.layer}|${maskKey(style.views)}`));
  return key;
};

export class Batches implements BatchSink {
  /** geometry id → material id → layer|mask → [no shadows, shadows]: nested so no key string is built per draw. */
  readonly #open = new Map<string, Map<string, Map<string, [OpenBatch | undefined, OpenBatch | undefined]>>>();
  /** Batches in first-draw order (the order `close` hands them over). */
  readonly #order: OpenBatch[] = [];

  add(
    geometry: Geometry3d, material: Material3d, castShadows: boolean, matrix: ArrayLike<number>, tint: Rgba, entity: number | null,
    style: DrawStyle = WORLD_DRAW,
  ): void {
    const casts = castShadows && style.shadows && style.layer === 'world';
    let byMaterial = this.#open.get(geometry.id);
    if (byMaterial === undefined) this.#open.set(geometry.id, (byMaterial = new Map()));
    let byStyle = byMaterial.get(material.id);
    if (byStyle === undefined) byMaterial.set(material.id, (byStyle = new Map()));
    const key = styleKey(style);
    let pair = byStyle.get(key);
    if (pair === undefined) byStyle.set(key, (pair = [undefined, undefined]));
    const slot = casts ? 1 : 0;
    let batch = pair[slot];
    if (batch === undefined) {
      batch = { geometry, material, castShadows: casts, style, numbers: [], entities: [], fades: [], faded: false };
      pair[slot] = batch;
      this.#order.push(batch);
    }
    for (let i = 0; i < 16; i++) batch.numbers.push(matrix[i]!);
    batch.numbers.push(tint[0], tint[1], tint[2], tint[3]);
    batch.entities.push(entity);
    batch.fades.push(style.fade);
    if (style.fade !== 1) batch.faded = true;
  }

  close(): MeshBatch[] {
    return this.#order.map((b) => ({
      geometry: b.geometry,
      material: b.material,
      count: b.entities.length,
      instances: new Float32Array(b.numbers),
      entities: b.entities,
      castShadows: b.castShadows,
      ...(b.style.layer !== 'world' && { layer: b.style.layer }),
      ...(b.style.views !== undefined && { views: b.style.views }),
      ...(b.faded && { fades: new Float32Array(b.fades) }),
    }));
  }
}

// ── Shapes ───────────────────────────────────────────────────────────────────

const capsules = new Map<string, Geometry3d>();
const rings = new Map<string, Geometry3d>();

export function shapeDraw(
  batches: BatchSink, materials: Materials, record: EntityRecord, shape: Fields, at: Placed3d,
  texture: (ref: unknown, where: string, data?: boolean) => Texture3d | null,
  style: DrawStyle = WORLD_DRAW, swap: ((material: Material3d, name: string | null) => Material3d) | null = null,
): void {
  const where = `${nameOf(record)} shape`;
  const kind = String(shape['kind']);
  if (SHAPES_2D.includes(kind)) {
    fail('PP3812', `${where} kind "${kind}" can't be drawn in 3D: a polygon's points are 2D`, {
      fix: 'Use box, sphere, capsule, cylinder, cone, plane, circle, rect or ring (circle and rect lie flat on the ground), or a model.',
    });
  }
  const [sx, sy, sz] = vec3(shape['size'], `${where}.size`);
  if (!(sx >= 0 && sy >= 0 && sz >= 0)) fail('PP3800', `${where}.size is (${sx}, ${sy}, ${sz}); sizes can't be negative`);
  const flatKind = kind === 'plane' || kind === 'rect' || kind === 'circle' || kind === 'ring';
  if (sx === 0 || sz === 0 || (sy === 0 && !flatKind)) return;
  const [ox, oy, oz] = vec3(shape['offset'], `${where}.offset`);
  const color = rgba(shape['color'], `${where}.color`);
  let geometry: Geometry3d;
  let local: M4;
  if (kind === 'capsule') {
    const radius = sx / 2;
    const height = Math.max(sy, sx);
    const key = `${radius}:${height}`;
    geometry = capsules.get(key) ?? capsule(radius, height);
    capsules.set(key, geometry);
    local = compose(ox, oy, oz, 0, 0, 0, 1, 1, 1, sz / sx);
  } else if (kind === 'ring') {
    const thickness = finite(shape['thickness'], `${where}.thickness`);
    if (!(thickness > 0)) return;
    const key = `${sx}:${sz}:${thickness}:${sy === 0}`;
    geometry = rings.get(key) ?? ring(sx, sz, thickness, sy === 0);
    rings.set(key, geometry);
    local = compose(ox, oy, oz, 0, 0, 0, 1, 1, 1, 1);
  } else {
    // In 3D, "rect" and "circle" lie flat on x/z, facing up, like a plane (ground markers, range rings).
    const flat = kind === 'plane' || kind === 'rect' || kind === 'circle';
    geometry = unitShape(kind === 'rect' ? 'plane' : kind as UnitShape);
    local = compose(ox, oy, oz, 0, 0, 0, 1, sx, flat ? 1 : sy, sz);
  }
  const tex = shape['texture'] === null || shape['texture'] === undefined ? null : texture(shape['texture'], `${where}.texture`);
  const plain = materials.shape(
    finite(shape['metallic'], `${where}.metallic`), finite(shape['roughness'], `${where}.roughness`),
    rgba(shape['emissive'], `${where}.emissive`), tex, color[3] < 1, shapeMaps(shape, where, texture),
    // Absent (an older snapshot): 1.
    shape['emissive_strength'] === undefined ? 1 : finite(shape['emissive_strength'], `${where}.emissive_strength`),
  );
  const material = swap === null ? plain : materials.keep(swap(plain, null));
  batches.add(geometry, material, material.alphaMode !== 'blend' && shape['cast_shadows'] === true, multiply(at.m, local), color, record.id, style);
}

/** A shape's tiling and normal map; absent fields (an older snapshot) read as none. */
function shapeMaps(shape: Fields, where: string, texture: (ref: unknown, where: string, data?: boolean) => Texture3d | null): ShapeMaps {
  const scale = shape['uv_scale'];
  let uvScale: readonly [number, number] = [1, 1];
  if (scale !== undefined && scale !== null) {
    if (!(scale instanceof Vec2)) fail('PP3800', `${where}.uv_scale must be a Vec2, got ${describe(scale)}`, { fix: 'Use Vec2(u_repeats, v_repeats), e.g. Vec2(4, 4).' });
    if (!(scale.x > 0 && scale.y > 0 && Number.isFinite(scale.x) && Number.isFinite(scale.y))) {
      fail('PP3800', `${where}.uv_scale is (${scale.x}, ${scale.y}); repeats must be positive`, { fix: 'Use Vec2(1, 1) for no tiling, Vec2(4, 4) to repeat the texture four times each way.' });
    }
    uvScale = [scale.x, scale.y];
  }
  const ref = shape['normal_map'];
  const normal = ref === null || ref === undefined ? null : texture(ref, `${where}.normal_map`, true);
  const strength = shape['normal_strength'] === undefined ? 1 : finite(shape['normal_strength'], `${where}.normal_strength`);
  return uvScale[0] === 1 && uvScale[1] === 1 && normal === null ? PLAIN_MAPS : { uvScale, normal, normalScale: strength };
}

// ── Lights ───────────────────────────────────────────────────────────────────

/** A Light component as drawn; `share` (0..1, its `when` by the hour: `lightShare`) scales the intensity. */
export function lightOf(record: EntityRecord, light: Fields, at: Placed3d, share = 1): Light3d {
  const where = `${nameOf(record)} light`;
  const color = rgba(light['color'], `${where}.color`);
  const m = at.m;
  return {
    kind: light['kind'] as Light3d['kind'],
    color: [color[0], color[1], color[2]],
    intensity: finite(light['intensity'], `${where}.intensity`) * share,
    position: [m[12]!, m[13]!, m[14]!],
    direction: normalize3(transformDirection(m, 0, 0, 1)),
    range: finite(light['range'], `${where}.range`),
    angle: finite(light['angle'], `${where}.angle`),
    ...(typeof light['inner_angle'] === 'number' && { innerAngle: Math.min(finite(light['inner_angle'], `${where}.inner_angle`), finite(light['angle'], `${where}.angle`)) }),
    entity: record.id,
    shadows: light['shadows'] === true,
  };
}

// ── Text and bars ────────────────────────────────────────────────────────────

interface SpanView {
  readonly text: string;
  readonly color: Color | null;
  readonly bold: boolean;
}

export function textDraw(record: EntityRecord, text: Fields, at: Placed3d): Text3d | null {
  const where = `${nameOf(record)} text_mesh`;
  if (typeof text['text'] !== 'string') fail('PP3800', `${where}.text must be a string, got ${describe(text['text'])}`);
  if (text['text'] === '') return null;
  const views = (text as { __spans__?: readonly SpanView[] }).__spans__;
  if (views === undefined) {
    return fail('PP9801', `${where} has no __spans__`, { fix: 'render3d reads parsed text from the visuals plugin; build the game with it.' });
  }
  const base = rgba(text['color'], `${where}.color`);
  const spans: TextSpan[] = views.map((s) => ({
    text: s.text,
    color: s.color === null ? base : [s.color.r, s.color.g, s.color.b, s.color.a * base[3]],
    bold: s.bold,
  }));
  const m = at.m;
  const up = transformDirection(m, 0, 1, 0);
  const scale = Math.hypot(up[0], up[1], up[2]);
  return {
    entity: record.id,
    position: [m[12]!, m[13]!, m[14]!],
    size: finite(text['size'], `${where}.size`) * scale,
    spans,
    faceCamera: text['face_camera'] === true,
    right: normalize3(transformDirection(m, 1, 0, 0)),
    up: normalize3(up),
  };
}

interface BandView {
  readonly from: number;
  readonly to: number;
  readonly color: Color;
}

export function barDraw(record: EntityRecord, bar: Fields, at: Placed3d): BillboardBatch | null {
  if (bar['shown'] !== true) return null;
  const where = `${nameOf(record)} world_bar`;
  const bands = (bar as { __bands__?: readonly BandView[] }).__bands__;
  if (bands === undefined) {
    return fail('PP9801', `${where} has no __bands__`, { fix: 'render3d reads checked bands from the visuals plugin; build the game with it.' });
  }
  const value = Math.min(1, Math.max(0, finite(bar['value'], `${where}.value`)));
  const [ox, oy, oz] = vec3(bar['offset'], `${where}.offset`);
  const x = at.m[12]! + ox;
  const y = at.m[13]! + oy;
  const z = at.m[14]! + oz;
  const [w, h] = BAR_SIZE;
  const pieces: number[] = [];
  const piece = (from: number, to: number, color: Rgba): void => {
    if (to <= from) return;
    pieces.push(x, y, z, ((from + to) / 2 - 0.5) * w, 0, (to - from) * w, h, 0, color[0], color[1], color[2], color[3]);
  };
  piece(0, 1, BAR_BACK);
  for (const band of bands) piece(Math.max(0, band.from), Math.min(1, band.to), [band.color.r, band.color.g, band.color.b, band.color.a]);
  piece(0, value, rgba(bar['color'], `${where}.color`));
  return { layer: 'overlay', shape: 'square', image: null, count: pieces.length / BILLBOARD_STRIDE, data: new Float32Array(pieces), entity: record.id };
}

// ── Outlines ─────────────────────────────────────────────────────────────────

export function outlineOf(record: EntityRecord, outline: Fields): Outline3d {
  const where = `${nameOf(record)} outline`;
  const color = rgba(outline['color'], `${where}.color`);
  const width = finite(outline['width'], `${where}.width`);
  const fill = finite(outline['fill'], `${where}.fill`);
  if (!(width >= 0 && width <= 16)) fail('PP3800', `${where}.width is ${width}; it must be 0 to 16 pixels`);
  if (!(fill >= 0 && fill <= 1)) fail('PP3800', `${where}.fill is ${fill}; it must be 0 to 1`);
  return { entity: record.id, color: [color[0], color[1], color[2]], width, throughWalls: outline['through_walls'] === true, fill };
}
