/**
 * Procedural first-person arms: a model document generated in code (no file), the default
 * arms of a Viewmodel without an `arms` prefab (sdk/parallax/viewmodel.pyi), served by the
 * models plugin as the built-in model `builtin:fp_arms`.
 *
 * Camera space, like every viewmodel: +x right, +y up, +z forward, meters; the model's
 * origin is where the Viewmodel's `arms_offset` puts it (just under the eye), with the
 * shoulders 0.2 m below it. Seven bones named as the Animator's built-in `left_hand` /
 * `right_hand` limbs expect (Spine2 → LeftArm / RightArm → …ForeArm → …Hand), so `reach`
 * bends the elbows (two-bone IK) to put each hand on an item's grip socket.
 *
 * Two skinned meshes: "sleeves" (material "sleeve") from the shoulder to the forearm,
 * and "hands" (material "skin"): the bare forearm end, the palm, four fingers curled for a
 * grip and the thumb. The elbow skin blends between the upper arm and forearm bones so it
 * bends smoothly; everything from the wrist on rides the hand. Recolor with
 * `Model.colors` ("skin", "sleeve") — the Viewmodel's `skin_color` / `sleeve_color`.
 * Sockets grip_r / grip_l sit in the palms.
 *
 * `shared_library/models/fp_arms` ships the same document as a file to copy and edit.
 */

import { encodeBuffer } from './parse.js';

export const BUILTIN_PREFIX = 'builtin:';
export const FP_ARMS = 'builtin:fp_arms';

type V = [number, number, number];

const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V, s: number): V => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V, b: V): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V): V => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l < 1e-12 ? [0, 0, 1] : mul(a, 1 / l);
};
/** `v` turned about the unit axis `k` by `deg` (Rodrigues). */
const turn = (v: V, k: V, deg: number): V => {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return add(add(mul(v, c), mul(cross(k, v), s)), mul(k, dot(k, v) * (1 - c)));
};

/** Bone influence per vertex: up to two bones. */
type Skin = readonly [joint: number, other: number, weight: number];

class MeshBuilder {
  readonly positions: number[] = [];
  readonly normals: number[] = [];
  readonly joints: number[] = [];
  readonly weights: number[] = [];
  readonly indices: number[] = [];

  vertex(p: V, n: V, skin: Skin): number {
    this.positions.push(...p);
    this.normals.push(...norm(n));
    this.joints.push(skin[0], skin[1], 0, 0);
    this.weights.push(skin[2], 1 - skin[2], 0, 0);
    return this.positions.length / 3 - 1;
  }

  /** A triangle wound outward (by its vertices' normals), as the engine's primitives are. */
  triangle(a: number, b: number, c: number): void {
    const p = (i: number): V => [this.positions[i * 3]!, this.positions[i * 3 + 1]!, this.positions[i * 3 + 2]!];
    const n = (i: number): V => [this.normals[i * 3]!, this.normals[i * 3 + 1]!, this.normals[i * 3 + 2]!];
    const face = cross(sub(p(b), p(a)), sub(p(c), p(a)));
    if (Math.hypot(...face) < 1e-14) return;
    if (dot(face, add(add(n(a), n(b)), n(c))) >= 0) this.indices.push(a, b, c);
    else this.indices.push(a, c, b);
  }

  /**
   * A tube through `centers` with elliptical rings (`rx` along each ring's `side`, `ry`
   * across), closed at the ends that ask for it.
   */
  tube(rings: readonly { center: V; side: V; rx: number; ry: number; skin: Skin }[], caps: { start: boolean; end: boolean }, sides = 12): void {
    const first = this.positions.length / 3;
    const dirs = rings.map((_, i) => norm(sub(rings[Math.min(i + 1, rings.length - 1)]!.center, rings[Math.max(i - 1, 0)]!.center)));
    rings.forEach((ring, i) => {
      const d = dirs[i]!;
      const a = norm(sub(ring.side, mul(d, dot(ring.side, d))));
      const b = cross(d, a);
      for (let k = 0; k < sides; k++) {
        const t = (k / sides) * Math.PI * 2;
        const p = add(ring.center, add(mul(a, Math.cos(t) * ring.rx), mul(b, Math.sin(t) * ring.ry)));
        const n = add(mul(a, Math.cos(t) / ring.rx), mul(b, Math.sin(t) / ring.ry));
        this.vertex(p, n, ring.skin);
      }
    });
    for (let i = 0; i + 1 < rings.length; i++) {
      for (let k = 0; k < sides; k++) {
        const a = first + i * sides + k;
        const b = first + i * sides + ((k + 1) % sides);
        this.triangle(a, b, b + sides);
        this.triangle(a, b + sides, a + sides);
      }
    }
    const cap = (i: number, outward: number): void => {
      const ring = rings[i]!;
      const d = mul(dirs[i]!, outward);
      const tip = this.vertex(add(ring.center, mul(d, Math.min(ring.rx, ring.ry) * 0.6)), d, ring.skin);
      for (let k = 0; k < sides; k++) this.triangle(tip, first + i * sides + k, first + i * sides + ((k + 1) % sides));
    };
    if (caps.start) cap(0, -1);
    if (caps.end) cap(rings.length - 1, 1);
  }

  json(): Record<string, string> {
    return {
      positions: encodeBuffer('f32', this.positions), normals: encodeBuffer('f32', this.normals), indices: encodeBuffer('u32', this.indices),
      joints: encodeBuffer('u16', this.joints), weights: encodeBuffer('f32', this.weights),
    };
  }
}

const smooth = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Bind-pose joint positions (model space) of one arm; `s` is +1 right, -1 left. */
function armJoints(s: number): { shoulder: V; elbow: V; wrist: V } {
  // A 0.32 m upper arm and a 0.31 m forearm from shoulders a little narrow and forward, as
  // first-person arms are, so a long gun's forend is in the off hand's reach.
  return { shoulder: [0.15 * s, -0.2, 0.04], elbow: [0.2 * s, -0.35, 0.32], wrist: [0.14 * s, -0.29, 0.62] };
}

/** One arm's meshes into `sleeves` and `hands`. Bones: [upper, fore, hand]. */
function arm(s: number, bones: readonly [number, number, number], sleeves: MeshBuilder, hands: MeshBuilder): void {
  const { shoulder, elbow, wrist } = armJoints(s);
  const up: V = [0, 1, 0];
  // A point along shoulder → elbow → wrist by u (0 shoulder, 1 elbow, 2 wrist), its radius and skin.
  const along = (u: number): { center: V; radius: number; skin: Skin } => {
    const center = u <= 1 ? add(shoulder, mul(sub(elbow, shoulder), u)) : add(elbow, mul(sub(wrist, elbow), u - 1));
    const radius = u <= 1 ? 0.054 + (0.043 - 0.054) * u : 0.043 + (0.029 - 0.043) * Math.min(1, u - 1);
    const fore = smooth(0.82, 1.18, u);
    return { center, radius, skin: [bones[0], bones[1], 1 - fore] };
  };
  const ring = (u: number, grow: number) => {
    const a = along(u);
    return { center: a.center, side: up, rx: a.radius * grow, ry: a.radius * grow * 0.92, skin: a.skin };
  };
  // The sleeve: shoulder to a cuff on the forearm, a little wider than the arm under it.
  sleeves.tube([0, 0.2, 0.45, 0.7, 0.85, 0.95, 1, 1.05, 1.15, 1.35, 1.55, 1.68, 1.72].map((u) => ring(u, u > 1.66 ? 1.2 : 1.12)), { start: true, end: false });
  // The bare forearm from inside the cuff to the wrist (all on the forearm by then).
  hands.tube([1.5, 1.7, 1.85, 2].map((u) => ring(u, 1)), { start: false, end: false });

  // The hand frame: f along the forearm, the palm facing inward (toward -s·x), u its "up".
  const f = norm(sub(wrist, elbow));
  const inward = norm(sub([-s, 0, 0], mul(f, dot([-s, 0, 0], f))));
  const across = norm(cross(inward, f));
  const u = across[1] >= 0 ? across : mul(across, -1);
  const hand: Skin = [bones[2], bones[2], 1];
  // Palm: a flattened tube from the wrist to the knuckles (wide along u, thin across).
  const palm = (t: number, wide: number, thick: number) => ({ center: add(wrist, mul(f, t)), side: u, rx: wide, ry: thick, skin: hand });
  hands.tube([palm(-0.01, 0.03, 0.022), palm(0.02, 0.04, 0.02), palm(0.06, 0.045, 0.017), palm(0.09, 0.043, 0.014)], { start: true, end: true });
  // Fingers: from the knuckle line, three segments each, curled toward the palm side.
  const knuckles = add(wrist, mul(f, 0.085));
  const fingers: readonly (readonly [number, readonly [number, number, number], number])[] = [
    [0.03, [0.042, 0.026, 0.02], 0.0092], [0.01, [0.046, 0.029, 0.022], 0.0095], [-0.01, [0.043, 0.027, 0.021], 0.0092], [-0.03, [0.034, 0.022, 0.018], 0.0082],
  ];
  // Turning f about f × inward by a positive angle bends it toward the palm side.
  const curl = norm(cross(f, inward));
  for (const [offset, lengths, radius] of fingers) {
    let p = add(add(knuckles, mul(u, offset)), mul(inward, 0.004));
    let dir = f;
    const rings = [{ center: p, side: u, rx: radius, ry: radius * 0.9, skin: hand }];
    lengths.forEach((length, i) => {
      dir = norm(turn(dir, curl, [38, 55, 45][i]!));
      p = add(p, mul(dir, length));
      rings.push({ center: p, side: u, rx: radius * (1 - 0.1 * (i + 1)), ry: radius * 0.9 * (1 - 0.1 * (i + 1)), skin: hand });
    });
    hands.tube(rings, { start: false, end: true }, 8);
  }
  // Thumb: from the palm's base on the inner side, forward and up over the grip.
  let p = add(add(add(wrist, mul(f, 0.025)), mul(u, 0.03)), mul(inward, 0.012));
  let dir = norm(add(add(f, mul(u, 0.55)), mul(inward, 0.45)));
  const thumb = [{ center: p, side: u, rx: 0.012, ry: 0.011, skin: hand }];
  for (const [length, bend] of [[0.035, 20], [0.03, 25]] as const) {
    dir = norm(turn(dir, norm(cross(dir, inward)), bend));
    p = add(p, mul(dir, length));
    thumb.push({ center: p, side: u, rx: 0.0105, ry: 0.0095, skin: hand });
  }
  hands.tube(thumb, { start: true, end: true }, 8);
}

/** Column-major inverse bind of a bone with no rotation at `p`. */
const inverseBind = (p: V): number[] => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -p[0], -p[1], -p[2], 1];

/** The procedural arms as a model document (JSON), for `parseModelDocument`. */
export function proceduralArmsDocument(): Record<string, unknown> {
  const right = armJoints(1);
  const left = armJoints(-1);
  const world: Record<string, V> = {
    Spine2: [0, 0, 0],
    RightArm: right.shoulder, RightForeArm: right.elbow, RightHand: right.wrist,
    LeftArm: left.shoulder, LeftForeArm: left.elbow, LeftHand: left.wrist,
  };
  const order = ['Spine2', 'RightArm', 'RightForeArm', 'RightHand', 'LeftArm', 'LeftForeArm', 'LeftHand'];
  const parents: Record<string, string | null> = {
    Spine2: null, RightArm: 'Spine2', RightForeArm: 'RightArm', RightHand: 'RightForeArm', LeftArm: 'Spine2', LeftForeArm: 'LeftArm', LeftHand: 'LeftForeArm',
  };
  const bones = order.map((name) => {
    const parent = parents[name]!;
    const position = parent === null ? world[name]! : sub(world[name]!, world[parent]!);
    return { name, parent: parent === null ? null : order.indexOf(parent), position: position.map((v) => Math.round(v * 1e6) / 1e6) };
  });
  const sleeves = new MeshBuilder();
  const hands = new MeshBuilder();
  arm(1, [1, 2, 3], sleeves, hands);
  arm(-1, [4, 5, 6], sleeves, hands);
  const palmSocket = (s: number): V => {
    const { elbow, wrist } = armJoints(s);
    const f = norm(sub(wrist, elbow));
    // In the curled fingers' hold: ahead of the palm and a little inward, relative to the hand bone.
    return sub(add(add(wrist, mul(f, 0.075)), [-0.03 * s, -0.005, 0]), wrist).map((v) => Math.round(v * 1e6) / 1e6) as V;
  };
  return {
    format: 'parallax.model',
    version: 1,
    source: 'engine: procedural first-person arms (resource/models/procedural_arms.ts)',
    materials: {
      skin: { color: [0.8, 0.6, 0.48], metallic: 0, roughness: 0.62, subsurface: 0.25, subsurface_color: [0.9, 0.35, 0.25] },
      sleeve: { color: [0.16, 0.18, 0.22], metallic: 0, roughness: 0.88 },
    },
    meshes: { sleeves: sleeves.json(), hands: hands.json() },
    skeleton: { bones, inverse_bind: encodeBuffer('f32', order.flatMap((name) => inverseBind(world[name]!))) },
    parts: [
      { name: 'sleeves', mesh: 'sleeves', material: 'sleeve', cast_shadows: false },
      { name: 'hands', mesh: 'hands', material: 'skin', cast_shadows: false },
    ],
    sockets: [
      { name: 'palm_r', parent: 'RightHand', position: palmSocket(1) },
      { name: 'palm_l', parent: 'LeftHand', position: palmSocket(-1) },
    ],
  };
}

/**
 * The Animator `ik` the arms want: the built-in hand limbs with elbows that drop down and
 * out (the default pole points behind, which a forward reach turns into an elbow up).
 */
export const FP_ARMS_IK = {
  limbs: {
    right_hand: { bones: ['RightArm', 'RightForeArm', 'RightHand'], pole: [0.5, -1, -0.2] },
    left_hand: { bones: ['LeftArm', 'LeftForeArm', 'LeftHand'], pole: [-0.5, -1, -0.2] },
  },
} as const;

/** Built-in model documents by reference (`Model.model`), generated on first use. */
export const BUILTIN_MODELS: Readonly<Record<string, () => Record<string, unknown>>> = {
  [FP_ARMS]: proceduralArmsDocument,
};
