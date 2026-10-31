/**
 * viewmodel — first-person arms and a held item (sdk/parallax/viewmodel.pyi). A Viewmodel
 * sits on an entity under the first-person camera; it spawns its `item` and `arms` prefabs as
 * children and, every frame after the camera rigs have moved (the kernel's 'ui' hook, before
 * drawing), poses the item in camera space from the procedural layers of `rig.ts` and puts
 * the arms' hands on the item's grip sockets through the arms' Animator IK (`reach`).
 *
 * What paces it: the body's motion from the `characters` service (speed, ground, running,
 * stance, landings) — the Viewmodel's `body`, else the camera's follow target — or, with no
 * character, the camera's own travel. Weapon code acts through the component's methods
 * (`fire`, `aim`, `play`); swapping `item` plays "draw". Sockets and grips come from the
 * `model_rig` service (render3d); in a run without the model files they are unknown, so
 * the aim pose falls back to the item's `aim` (or the centre line) and the hands hang free.
 *
 * Drawing: render3d reads `viewmodel.__view_layer__` (the overlay's field of view and near
 * plane, eased by aiming; the camera; the body and the Model options it shows in this view)
 * and draws this entity's subtree over the world. The renderers own that pass; this plugin
 * only computes poses, so it is deterministic, snapshot-able and headless.
 *
 * It imports no plugin: the camera, Model, Animator and Socket are read by component id with
 * the SDK's field names; the body through the characters service.
 */

import { closestMatch, fail, Quat, Vec3 } from '../../../core/index.js';
import type { Color } from '../../../core/index.js';
import { FP_ARMS, FP_ARMS_IK } from '../../../resource/index.js';
import type { EntityId } from '../../../core/index.js';
import type { Json } from '../../../resource/index.js';
import { componentEntity } from '../../kernel/index.js';
import type { ComponentDef, EntityRecord, EventDef, Fields, Kernel, KernelPlugin } from '../../kernel/index.js';
import { CHARACTERS_SERVICE, MODEL_RIG_SERVICE } from '../../services/index.js';
import { BUILT_IN_POSES, crossedCues } from './poses.js';
import type { ViewPose } from './poses.js';
import { fireRig, freshRig, loadRig, saveRig, solveAim, stepRig } from './rig.js';
import type { BodyMotion, RecoilSpec, RigState } from './rig.js';
import { VIEWMODEL, VIEWMODEL_ITEM, VIEWMODEL_ITEM_SCHEMA, VIEWMODEL_SCHEMA } from './schemas.js';

export { BUILT_IN_POSES, crossedCues, samplePose } from './poses.js';
export type { PoseCue, PoseKey, ViewPose } from './poses.js';
export {
  BOB_REFERENCE_SPEED, fireRig, freshRig, LAG_GAIN, LAG_MAX, solveAim, stepRig, STRIDE,
} from './rig.js';
export type { BodyMotion, RecoilSpec, RigInput, RigPose, RigState } from './rig.js';
export { ease, fbm, kick, noise, spring, stepSpring } from './springs.js';
export type { SpringState } from './springs.js';
export {
  POSE_CUE_RECORD, POSE_KEY_RECORD, RECOIL_RECORD, VIEW_POSE_RECORD, VIEWMODEL, VIEWMODEL_ITEM, VIEWMODEL_ITEM_SCHEMA, VIEWMODEL_SCHEMA,
} from './schemas.js';

export const VIEWMODEL_CUE: EventDef = { id: 'viewmodel_cue', target: 'entity' };

const CAMERA = 'camera';
const MODEL = 'model';
const ANIMATOR = 'animator';
const LIMBS = ['right_hand', 'left_hand'] as const;

/** What render3d reads to draw a viewmodel's subtree on its own layer. */
export interface ViewLayer {
  /** The camera whose view it overlays. */
  readonly camera: EntityId;
  /** Vertical degrees, eased from `fov` to `aim_fov` by aiming. */
  readonly fov: number;
  readonly near: number;
  /** The body this view belongs to (null: none), and the Model options it shows in this view only. */
  readonly body: EntityId | null;
  readonly bodyOptions: Readonly<Record<string, string>>;
  /** The body isn't drawn in this view at all (its shadow is). */
  readonly hideBody: boolean;
}

interface PoseRun {
  name: string;
  t: number;
  seconds: number;
  started: boolean;
}

interface VmState {
  rig: RigState;
  item: EntityId | null;
  itemFor: string | null;
  arms: EntityId | null;
  armsFor: string | null;
  /** The procedural arms are drawn by this entity's own Model and Animator, added for them. */
  procedural: boolean;
  pose: PoseRun | null;
  landedFrame: number;
  /** The camera's world position last frame (pace without a character). */
  lastCamera: [number, number, number] | null;
}

interface SavedVm {
  readonly id: number;
  readonly rig: unknown;
  readonly item: number | null;
  readonly itemFor: string | null;
  readonly arms: number | null;
  readonly armsFor: string | null;
  readonly procedural?: boolean;
  readonly pose: PoseRun | null;
  readonly landedFrame: number;
  readonly lastCamera: [number, number, number] | null;
}

function nameOf(record: EntityRecord): string {
  return `"${record.placedId ?? record.prefab ?? record.id}"`;
}

function stored(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  const toJSON = (value as { toJSON?: unknown }).toJSON;
  if (typeof toJSON === 'function') {
    const form = (toJSON as () => unknown).call(value);
    if (typeof form === 'string') return form;
  }
  return fail('PP3873', `Expected a prefab or model reference, got ${String(value)}`);
}

function describe(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'object') return value.constructor?.name ?? 'object';
  return JSON.stringify(value);
}

/** Python keyword arguments: one trailing api `Kwargs` (or a plain object from TypeScript). */
function keywords(args: readonly unknown[], name: string, allowed: readonly string[]): { positional: unknown[]; k: Readonly<Record<string, unknown>> } {
  const last = args[args.length - 1];
  let k: Record<string, unknown> | undefined;
  if (typeof last === 'object' && last !== null && !(last instanceof Vec3) && !Array.isArray(last)) {
    if (Object.getPrototypeOf(last) === Object.prototype) k = last as Record<string, unknown>;
    else if (typeof (last as { values?: unknown }).values === 'object') k = (last as { values: Record<string, unknown> }).values;
  }
  if (k === undefined) return { positional: [...args], k: {} };
  for (const key of Object.keys(k)) {
    if (!allowed.includes(key)) fail('PP3030', `${name}() got an unexpected keyword argument "${key}"`, { fix: `Accepted: ${allowed.join(', ') || '(none)'}.` });
  }
  return { positional: args.slice(0, -1), k };
}

class Viewmodels {
  readonly #kernel: Kernel;
  readonly #states = new Map<EntityId, VmState>();

  constructor(kernel: Kernel) {
    this.#kernel = kernel;
  }

  get kernel(): Kernel {
    return this.#kernel;
  }

  added(records: readonly EntityRecord[]): void {
    for (const r of records) {
      if (r.components.has(VIEWMODEL) && !this.#states.has(r.id)) {
        this.#states.set(r.id, {
          rig: freshRig(), item: null, itemFor: null, arms: null, armsFor: null, procedural: false, pose: null, landedFrame: -1, lastCamera: null,
        });
      }
    }
  }

  removed(records: readonly EntityRecord[]): void {
    const gone = new Set(records.map((r) => r.id));
    for (const r of records) this.#states.delete(r.id);
    for (const s of this.#states.values()) {
      if (s.item !== null && gone.has(s.item)) s.item = null;
      if (s.arms !== null && gone.has(s.arms)) s.arms = null;
    }
  }

  changed(record: EntityRecord): void {
    if (record.components.has(VIEWMODEL)) this.added([record]);
    else this.#states.delete(record.id);
  }

  state(id: EntityId): VmState {
    const s = this.#states.get(id);
    if (s === undefined) fail('PP3871', 'This viewmodel is not in the world', { fix: 'Use the Viewmodel of a live entity.' });
    return s;
  }

  // ── Per frame ─────────────────────────────────────────────────────────────

  frame(): void {
    const dt = this.#kernel.time.dt;
    for (const [id, s] of this.#states) {
      const record = this.#kernel.world.get(id);
      const fields = record?.components.get(VIEWMODEL);
      if (record === undefined || fields === undefined) continue;
      this.#frameOne(record, fields, s, dt);
    }
  }

  #camera(record: EntityRecord): EntityRecord {
    let at: EntityRecord | undefined = record;
    while (at !== undefined) {
      if (at.components.has(CAMERA)) return at;
      at = at.parent === null ? undefined : this.#kernel.world.get(at.parent);
    }
    return fail('PP3871', `The viewmodel of ${nameOf(record)} isn't under a camera`, {
      fix: 'Put the Viewmodel on a child of the first-person camera (a "children" entry of the camera prefab).',
    });
  }

  #body(fields: Fields, camera: EntityRecord): EntityId | null {
    const kernel = this.#kernel;
    const own = fields['body'];
    if (own !== null && own !== undefined) {
      const id = kernel.handles.unwrap(own);
      return id !== undefined && kernel.world.isAlive(id) ? id : null;
    }
    const follow = camera.components.get(CAMERA)!['follow'];
    if (follow === null || follow === undefined || Array.isArray(follow) || typeof follow === 'string') return null;
    const id = kernel.handles.unwrap(follow);
    return id !== undefined && kernel.world.isAlive(id) ? id : null;
  }

  #spawned(record: EntityRecord, current: EntityId | null, was: string | null, wanted: string | null): { id: EntityId | null; changed: boolean } {
    if (wanted === was && (current === null) === (wanted === null)) return { id: current, changed: false };
    if (current !== null && this.#kernel.world.isAlive(current)) this.#kernel.destroy(current);
    if (wanted === null) return { id: null, changed: true };
    return { id: this.#kernel.spawn(wanted, {}, { parent: record.id }).id, changed: true };
  }

  #poses(fields: Fields): Record<string, ViewPose> {
    return { ...BUILT_IN_POSES, ...(fields['poses'] as Record<string, ViewPose>) };
  }

  play(id: EntityId, fields: Fields, name: string, seconds: number | null): void {
    const poses = this.#poses(fields);
    const pose = poses[name];
    if (pose === undefined) {
      const known = Object.keys(poses);
      const guess = closestMatch(name, known);
      fail('PP3870', `play(): this viewmodel has no pose "${name}"`, { fix: guess !== undefined ? `Did you mean "${guess}"?` : `Poses: ${known.join(', ')}.` });
    }
    if (seconds !== null && !(seconds > 0)) fail('PP3873', `play(seconds=${seconds}) must be positive`);
    this.state(id).pose = { name, t: 0, seconds: seconds ?? pose.seconds, started: true };
    fields['pose'] = name;
  }

  #itemSpec(item: EntityRecord | undefined): Fields {
    const spec = item?.components.get(VIEWMODEL_ITEM) ?? Object.fromEntries(Object.entries(VIEWMODEL_ITEM_SCHEMA).map(([k, s]) => [k, s.default]));
    const grips = spec['grips'] as readonly string[];
    if (grips.length !== 2) {
      fail('PP3873', `The viewmodel_item of ${item === undefined ? 'the item' : nameOf(item)} lists ${grips.length} grips`, {
        fix: 'Give two socket names, right hand then left: ["grip_r", "grip_l"] ("" leaves that hand free).',
      });
    }
    return spec;
  }

  /** A socket of an entity's Model in its own frame, when the model's file is in this run and has it. */
  #socket(entity: EntityRecord | undefined, socket: string): { position: Vec3; rotation: Quat } | null {
    if (entity === undefined || socket === '') return null;
    const model = entity.components.get(MODEL);
    if (model === undefined) return null;
    const rigs = this.#kernel.tryService(MODEL_RIG_SERVICE);
    const rig = rigs?.rig(stored(model['model'])!);
    if (rig === null || rig === undefined || !rig.sockets.includes(socket)) return null;
    return rigs!.socket(entity.id, socket, 'local') ?? null;
  }

  #frameOne(record: EntityRecord, fields: Fields, s: VmState, dt: number): void {
    const kernel = this.#kernel;
    const item = this.#spawned(record, s.item, s.itemFor, stored(fields['item']));
    s.item = item.id;
    s.itemFor = stored(fields['item']);
    if (item.changed && item.id !== null) this.play(record.id, fields, 'draw', null);
    const arms = this.#spawned(record, s.arms, s.armsFor, stored(fields['arms']));
    s.arms = arms.id;
    s.armsFor = stored(fields['arms']);
    this.#proceduralArms(record, fields, s);

    const camera = this.#camera(record);
    const bodyId = this.#body(fields, camera);
    const camPos = camera.transform.worldPosition();
    let body: BodyMotion;
    const view = bodyId === null ? undefined : kernel.tryService(CHARACTERS_SERVICE)?.view(bodyId);
    if (view !== undefined) {
      let landing: number | null = null;
      if (view.landed !== null && view.landed.frame !== s.landedFrame) {
        if (s.landedFrame !== -1 || kernel.time.frame - view.landed.frame < 2) landing = view.landed.speed;
        s.landedFrame = view.landed.frame;
      }
      body = { speed: view.velocity.flat().length(), grounded: view.grounded, running: view.running, stance: view.stance, landing };
    } else {
      const last = s.lastCamera;
      const speed = last === null || dt <= 0 ? 0 : Math.hypot(camPos.x - last[0], camPos.z - last[2]) / dt;
      body = { speed, grounded: true, running: false, stance: 'stand', landing: null };
    }
    s.lastCamera = [camPos.x, camPos.y, camPos.z];

    // The pose clock and its cues.
    const pose = s.pose;
    let poseInput: { def: ViewPose; t: number } | null = null;
    if (pose !== null) {
      const def = this.#poses(fields)[pose.name]!;
      const before = pose.t;
      pose.t = Math.min(1, pose.t + (dt > 0 ? dt / pose.seconds : 0));
      for (const cue of crossedCues(def, before, pose.t, pose.started)) {
        kernel.emit(VIEWMODEL_CUE, { entity: kernel.handles.wrap(record.id), pose: pose.name, cue });
      }
      if (dt > 0) pose.started = false;
      poseInput = { def, t: pose.t };
      if (pose.t >= 1 && !def.hold) {
        s.pose = null;
        fields['pose'] = null;
      }
    }

    const itemRecord = s.item === null ? undefined : kernel.world.get(s.item);
    const spec = this.#itemSpec(itemRecord);
    const hip = spec['hip'] as Vec3;
    const sight = this.#socket(itemRecord, spec['sight'] as string);
    const aim = (spec['aim'] as Vec3 | null) ?? (sight !== null ? solveAim(sight.position, spec['eye_relief'] as number) : new Vec3(0, hip.y, hip.z));
    const euler = camera.transform.worldRotation().to_euler();
    const out = stepRig(s.rig, {
      dt, body, view: { yaw: euler.y, pitch: -euler.x }, hip, hipTurn: spec['hip_turn'] as Vec3, aim, aimTime: spec['aim_time'] as number,
      itemSway: spec['sway'] as number, sway: fields['sway'] as number, bob: fields['bob'] as number, lag: fields['lag'] as number,
      recoil: spec['recoil'] as RecoilSpec, sprintOffset: fields['sprint_offset'] as Vec3, sprintTurn: fields['sprint_turn'] as Vec3, pose: poseInput,
    });
    fields['aiming'] = s.rig.aiming;

    if (itemRecord !== undefined) {
      itemRecord.transform.position = out.offset;
      // Viewmodel turns pitch positive up; Euler x tips forward down.
      itemRecord.transform.rotation = Quat.from_euler(new Vec3(-out.turn.x, out.turn.y, out.turn.z));
    }
    const armsRecord = s.arms === null ? undefined : kernel.world.get(s.arms);
    if (armsRecord !== undefined) {
      armsRecord.transform.position = (fields['arms_offset'] as Vec3).__add__(out.arms);
      armsRecord.transform.rotation = Quat.IDENTITY;
      this.#grip(armsRecord, itemRecord, spec['grips'] as readonly [string, string]);
    } else if (s.procedural) {
      // The procedural arms are this entity's own Model: placed by its offset (the item's frame is untouched).
      const model = record.components.get(MODEL)!;
      model['offset'] = (fields['arms_offset'] as Vec3).__add__(out.arms);
      model['colors'] = { skin: fields['skin_color'] as Color, sleeve: fields['sleeve_color'] as Color };
      this.#grip(record, itemRecord, spec['grips'] as readonly [string, string]);
    }
  }

  /**
   * Without an `arms` prefab (and `procedural_arms` on), the viewmodel entity draws the
   * engine's procedural arms itself: it is given a Model of `builtin:fp_arms` and an
   * Animator (for the hands' IK), which go again once an `arms` prefab is set. An entity
   * that already has a Model of its own keeps it (no procedural arms).
   */
  #proceduralArms(record: EntityRecord, fields: Fields, s: VmState): void {
    const kernel = this.#kernel;
    const wanted = s.arms === null && fields['procedural_arms'] === true;
    if (wanted && !s.procedural) {
      const components = kernel.registry.components;
      if (record.components.has(MODEL) || record.components.has(ANIMATOR) || !components.has(MODEL) || !components.has(ANIMATOR)) return;
      kernel.addComponent(record.id, MODEL, { model: FP_ARMS, cast_shadows: false });
      kernel.addComponent(record.id, ANIMATOR, { ik: JSON.parse(JSON.stringify(FP_ARMS_IK)) });
      s.procedural = true;
    } else if (!wanted && s.procedural) {
      s.procedural = false;
      if (record.components.get(MODEL)?.['model'] === FP_ARMS) {
        kernel.removeComponent(record.id, MODEL);
        kernel.removeComponent(record.id, ANIMATOR);
      }
    }
  }

  /** World points of the item's grip sockets, posed now: [right, left] (null: that hand is free). */
  #gripPoints(item: EntityRecord | undefined, grips: readonly [string, string]): [Vec3 | null, Vec3 | null] {
    const at = (socket: string): Vec3 | null => {
      const frame = this.#socket(item, socket);
      if (frame === null || item === undefined) return null;
      return item.transform.worldPosition().__add__(item.transform.worldRotation().rotate(frame.position));
    };
    return [at(grips[0]), at(grips[1])];
  }

  /** Each hand reaches its grip socket on the item, or hangs free. */
  #grip(arms: EntityRecord, item: EntityRecord | undefined, grips: readonly [string, string]): void {
    const animator = arms.components.get(ANIMATOR) as (Fields & { reach(limb: string, target: Vec3 | null): void }) | undefined;
    if (animator === undefined) return;
    const points = this.#gripPoints(item, grips);
    LIMBS.forEach((limb, i) => animator.reach(limb, points[i]!));
  }

  /** The grip targets for each hand now (world points), for tests and tools. */
  grips(id: EntityId): { right: Vec3 | null; left: Vec3 | null } {
    const s = this.state(id);
    const item = s.item === null ? undefined : this.#kernel.world.get(s.item);
    const [right, left] = this.#gripPoints(item, this.#itemSpec(item)['grips'] as readonly [string, string]);
    return { right, left };
  }

  layer(record: EntityRecord, fields: Fields): ViewLayer {
    const camera = this.#camera(record);
    const a = fields['aiming'] as number;
    const e = a * a * (3 - 2 * a);
    return {
      camera: camera.id,
      fov: (fields['fov'] as number) + ((fields['aim_fov'] as number) - (fields['fov'] as number)) * e,
      near: fields['near'] as number,
      body: this.#body(fields, camera),
      bodyOptions: fields['body_options'] as Record<string, string>,
      hideBody: fields['hide_body'] === true,
    };
  }

  snapshot(): SavedVm[] {
    return [...this.#states].map(([id, s]) => ({
      id: id as number, rig: saveRig(s.rig), item: s.item as number | null, itemFor: s.itemFor, arms: s.arms as number | null, armsFor: s.armsFor, procedural: s.procedural,
      pose: s.pose === null ? null : { ...s.pose }, landedFrame: s.landedFrame, lastCamera: s.lastCamera,
    }));
  }

  restore(saved: readonly SavedVm[]): void {
    this.#states.clear();
    const world = this.#kernel.world;
    const alive = (id: number | null): EntityId | null => (id !== null && world.isAlive(id as EntityId) ? id as EntityId : null);
    this.added([...world.live()]);
    for (const v of saved) {
      if (!this.#states.has(v.id as EntityId)) continue;
      const item = alive(v.item);
      const arms = alive(v.arms);
      this.#states.set(v.id as EntityId, {
        rig: loadRig(v.rig), item, itemFor: item === null ? null : v.itemFor, arms, armsFor: arms === null ? null : v.armsFor,
        procedural: v.procedural === true && world.get(v.id as EntityId)?.components.get(MODEL)?.['model'] === FP_ARMS,
        pose: v.pose === null ? null : { ...v.pose }, landedFrame: v.landedFrame, lastCamera: v.lastCamera,
      });
    }
  }
}

function methods(current: () => Viewmodels): object {
  const own = (fields: unknown): EntityId => componentEntity(fields as Fields);
  return {
    fire(this: Fields, ...args: unknown[]): void {
      const { positional, k } = keywords(args, 'fire', ['strength']);
      if (positional.length > 0) fail('PP3030', 'fire() takes only strength=');
      const strength = k['strength'] ?? 1;
      if (typeof strength !== 'number' || !Number.isFinite(strength) || strength < 0) fail('PP3873', `fire(strength=) must be a number ≥ 0, got ${describe(strength)}`);
      const vm = current();
      const s = vm.state(own(this));
      const item = s.item === null ? undefined : vm.kernel.world.get(s.item);
      const recoil = (item?.components.get(VIEWMODEL_ITEM)?.['recoil'] ?? VIEWMODEL_ITEM_SCHEMA['recoil']!.default) as RecoilSpec;
      fireRig(s.rig, recoil, strength);
    },
    aim(this: Fields, ...args: unknown[]): void {
      const { positional, k } = keywords(args, 'aim', ['on']);
      const on = positional[0] ?? k['on'];
      if (typeof on !== 'boolean') fail('PP3873', `aim() takes True or False, got ${describe(on)}`);
      current().state(own(this)).rig.aimGoal = on;
    },
    play(this: Fields, ...args: unknown[]): void {
      const { positional, k } = keywords(args, 'play', ['pose', 'seconds']);
      const pose = positional[0] ?? k['pose'];
      if (typeof pose !== 'string') fail('PP3870', `play() takes a pose name, got ${describe(pose)}`);
      const seconds = k['seconds'] ?? null;
      if (seconds !== null && typeof seconds !== 'number') fail('PP3873', `play(seconds=) must be a number, got ${describe(seconds)}`);
      current().play(own(this), this, pose, seconds as number | null);
    },
    get held(): unknown {
      const vm = current();
      const id = vm.state(own(this)).item;
      return id === null ? null : vm.kernel.handles.wrap(id);
    },
    get hands(): unknown {
      const vm = current();
      const s = vm.state(own(this));
      const id = s.arms ?? (s.procedural ? own(this) : null);
      return id === null ? null : vm.kernel.handles.wrap(id);
    },
    get __view_layer__(): ViewLayer {
      const vm = current();
      const id = own(this);
      return vm.layer(vm.kernel.world.require(id), this as unknown as Fields);
    },
  };
}

export interface ViewmodelPlugin extends KernelPlugin {
  /** The grip targets the last frame gave each hand (world points), for tests and tools. */
  grips(entity: EntityId): { right: Vec3 | null; left: Vec3 | null };
}

export function viewmodel(): ViewmodelPlugin {
  let engine: Viewmodels | undefined;
  const current = (): Viewmodels => {
    if (engine === undefined) fail('PP9870', 'The viewmodel plugin is used before its kernel was built');
    return engine;
  };
  const components: ComponentDef[] = [
    { id: VIEWMODEL, schema: VIEWMODEL_SCHEMA, methods: methods(current) },
    { id: VIEWMODEL_ITEM, schema: VIEWMODEL_ITEM_SCHEMA },
  ];
  return {
    id: 'viewmodel',
    components,
    events: [VIEWMODEL_CUE],
    install(kernel) {
      if (engine !== undefined) fail('PP9871', 'This viewmodel plugin is already installed in another kernel', { fix: 'Call viewmodel() once per kernel.' });
      const created = new Viewmodels(kernel);
      engine = created;
      kernel.observeEntities({
        added: (records) => created.added(records),
        removed: (records) => created.removed(records),
        changed: (record) => created.changed(record),
      });
      kernel.addHook('ui', () => created.frame());
    },
    grips: (entity) => current().grips(entity),
    snapshot: () => current().snapshot() as unknown as Json,
    restore: (_kernel, saved) => current().restore(saved as unknown as SavedVm[]),
  };
}
