/**
 * The viewmodel: spring and noise math, poses, each procedural layer of the rig on its own,
 * and the plugin in a headless 3D kernel (render3d's model rig for sockets, visuals for the
 * camera and the arms' Animator, characters for the body): items spawned from data, the aim
 * pose solved from the sight socket, hands reaching the grip sockets, cues, snapshots.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { Quat, Vec3 } from '../../../core/index.js';
import type { EntityId, ProjectFiles } from '../../../core/index.js';
import { MemoryBinaryFiles, RecordingSurface3d } from '../../../platform/headless/render3d.js';
import { encodeBuffer, loadProject } from '../../../resource/index.js';
import { Kernel } from '../../kernel/index.js';
import type { EntityRecord, Fields, SystemDef } from '../../kernel/index.js';
import { MODEL_RIG_SERVICE } from '../../services/index.js';
import { characters as apiCharacters } from '../../../api/characters.js';
import { initPhysics3d, physics3d } from '../physics3d/index.js';
import { models } from '../models/index.js';
import { render3d } from '../render3d/index.js';
import { visuals } from '../visuals/index.js';
import type { AnimatorPlayback } from '../visuals/index.js';
import {
  BUILT_IN_POSES, crossedCues, ease, fbm, fireRig, freshRig, kick, noise, samplePose, solveAim, spring, stepRig, stepSpring, STRIDE,
  viewmodel, VIEWMODEL_CUE,
} from './index.js';
import type { RecoilSpec, RigInput, ViewPose } from './index.js';

const DT = 1 / 60;

beforeAll(async () => {
  await initPhysics3d();
});

// ── Springs and noise ─────────────────────────────────────────────────────────

describe('springs', () => {
  it('settles on its target; under-damped ones overshoot first, critical ones never do', () => {
    const ringing = spring();
    let peak = 0;
    for (let i = 0; i < 240; i++) peak = Math.max(peak, stepSpring(ringing, 1, 9, 0.42, DT));
    expect(peak).toBeGreaterThan(1.05);
    expect(ringing.x).toBeCloseTo(1, 4);
    const critical = spring();
    let most = 0;
    for (let i = 0; i < 240; i++) most = Math.max(most, stepSpring(critical, 1, 9, 1, DT));
    expect(most).toBeLessThanOrEqual(1 + 1e-9);
    expect(critical.x).toBeCloseTo(1, 4);
  });

  it('stays stable through long frames (a 200 ms hitch on a 12 Hz spring)', () => {
    const s = spring();
    kick(s, 5);
    for (let i = 0; i < 20; i++) stepSpring(s, 0, 12, 0.4, 0.2);
    expect(Number.isFinite(s.x)).toBe(true);
    expect(Math.abs(s.x)).toBeLessThan(1e-3);
    // dt 0 changes nothing.
    const before = { ...s };
    stepSpring(s, 3, 12, 0.4, 0);
    expect(s).toEqual(before);
  });

  it('a kick of size·ω peaks at about half of size with the default ring', () => {
    const s = spring();
    kick(s, 0.02 * 9 * Math.PI * 2);
    let peak = 0;
    for (let i = 0; i < 60; i++) peak = Math.max(peak, stepSpring(s, 0, 9, 0.42, DT));
    expect(peak).toBeGreaterThan(0.008);
    expect(peak).toBeLessThan(0.012);
  });

  it('noise is deterministic, bounded, continuous and not periodic', () => {
    expect(noise(3.7, 5)).toBe(noise(3.7, 5));
    let worst = 0;
    let prev = fbm(0, 1);
    for (let i = 1; i < 20000; i++) {
      const v = fbm(i * 0.01, 1);
      expect(Math.abs(v)).toBeLessThanOrEqual(1);
      worst = Math.max(worst, Math.abs(v - prev));
      prev = v;
    }
    expect(worst).toBeLessThan(0.05);
    // No short period: values a "period" apart differ.
    expect(fbm(10, 1)).not.toBeCloseTo(fbm(10 + 512, 1), 6);
    expect(ease(0, 1, 10, 0.1)).toBeCloseTo(1 - Math.exp(-1), 9);
  });
});

// ── Poses ─────────────────────────────────────────────────────────────────────

describe('poses', () => {
  it('start and end at rest unless keyed; a holding pose keeps its last key', () => {
    const reload = BUILT_IN_POSES['reload']!;
    expect(samplePose(reload, 0).offset.length()).toBe(0);
    expect(samplePose(reload, 1).turn.length()).toBe(0);
    expect(samplePose(reload, 0.5).turn).toEqual(new Vec3(-18, -18, 40));
    const between = samplePose(reload, 0.35).turn;
    expect(between.x).toBeLessThan(-10);
    expect(between.x).toBeGreaterThan(-18);
    const holster = BUILT_IN_POSES['holster']!;
    expect(samplePose(holster, 1).offset).toEqual(new Vec3(0, -0.3, -0.05));
    const lone: ViewPose = { seconds: 1, hold: true, cues: [], keys: [{ at: 0.5, offset: new Vec3(0, 1, 0), turn: Vec3.ZERO }] };
    expect(samplePose(lone, 0.9).offset.y).toBe(1);
  });

  it('reports the cues a step passed, once', () => {
    const reload = BUILT_IN_POSES['reload']!;
    expect(crossedCues(reload, 0, 0.2, true)).toEqual([]);
    expect(crossedCues(reload, 0.2, 0.31, false)).toEqual(['mag_out']);
    expect(crossedCues(reload, 0.3, 0.7, false)).toEqual(['mag_in']);
    expect(crossedCues({ ...reload, cues: [{ at: 0, name: 'go' }] }, 0, 0.1, true)).toEqual(['go']);
    expect(crossedCues({ ...reload, cues: [{ at: 0, name: 'go' }] }, 0, 0.1, false)).toEqual([]);
  });
});

// ── The rig, layer by layer ───────────────────────────────────────────────────

const RECOIL: RecoilSpec = { kick_back: 0.02, kick_up: 0.007, pitch: 3, yaw: 0.8, roll: 1.8, frequency: 9, damping: 0.42, pattern: [1.45, 1.3, 1.0], reset: 0.3 };

function input(over: Partial<RigInput> = {}): RigInput {
  return {
    dt: DT, body: { speed: 0, grounded: true, running: false, stance: 'stand', landing: null }, view: { yaw: 0, pitch: 0 },
    hip: new Vec3(0.14, -0.3, 0.4), hipTurn: Vec3.ZERO, aim: new Vec3(0, -0.25, 0.3), aimTime: 0.2, itemSway: 1, sway: 0, bob: 1, lag: 1, recoil: RECOIL,
    sprintOffset: new Vec3(0.04, -0.07, -0.06), sprintTurn: new Vec3(-8, -28, 14), pose: null, ...over,
  };
}

describe('rig layers', () => {
  it('rests at the hip, and eases to the aim pose over aim_time (and back)', () => {
    const s = freshRig();
    expect(stepRig(s, input()).offset.distance_to(new Vec3(0.14, -0.3, 0.4))).toBeLessThan(1e-9);
    s.aimGoal = true;
    let out = stepRig(s, input());
    expect(out.offset.x).toBeLessThan(0.14);
    for (let i = 0; i < 12; i++) out = stepRig(s, input());
    expect(s.aiming).toBe(1);
    expect(out.offset.distance_to(new Vec3(0, -0.25, 0.3))).toBeLessThan(1e-9);
    s.aimGoal = false;
    for (let i = 0; i < 13; i++) out = stepRig(s, input());
    expect(s.aiming).toBe(0);
  });

  it('solves the aim pose that puts the sight on the view axis at eye relief', () => {
    const sight = new Vec3(-0.018, 0.28, 0.035);
    const aim = solveAim(sight, 0.17);
    expect(aim.__add__(sight).distance_to(new Vec3(0, 0, 0.17))).toBeLessThan(1e-12);
  });

  it('bobs only while moving on the ground, once per stride, less when crouched or aiming', () => {
    const still = freshRig();
    for (let i = 0; i < 60; i++) stepRig(still, input());
    expect(stepRig(still, input()).offset.x).toBeCloseTo(0.14, 9);
    const size = (over: Partial<RigInput['body']>, aim = false): number => {
      const s = freshRig();
      s.aimGoal = aim;
      let most = 0;
      for (let i = 0; i < 240; i++) {
        const out = stepRig(s, input({ body: { speed: 4, grounded: true, running: false, stance: 'stand', landing: null, ...over } }));
        if (i > 120) most = Math.max(most, Math.abs(out.offset.x - (aim ? 0 : 0.14)));
      }
      return most;
    };
    const walking = size({});
    expect(walking).toBeGreaterThan(0.008);
    expect(size({ stance: 'crouch' })).toBeLessThan(walking * 0.7);
    expect(size({}, true)).toBeLessThan(walking * 0.3);
    expect(size({ grounded: false })).toBeLessThan(1e-4);
    // One cycle per STRIDE meters: the phase advances 2π·speed/STRIDE per second.
    const s = freshRig();
    stepRig(s, input({ body: { speed: 4, grounded: true, running: false, stance: 'stand', landing: null }, dt: 0.25 }));
    expect(s.phase).toBeCloseTo((2 * Math.PI * 4 * 0.25 / STRIDE) % (2 * Math.PI), 9);
  });

  it('blends to the sprint pose while running on the ground (not while aiming)', () => {
    const s = freshRig();
    let out = stepRig(s, input());
    for (let i = 0; i < 120; i++) out = stepRig(s, input({ body: { speed: 0, grounded: true, running: true, stance: 'stand', landing: null } }));
    expect(s.sprint).toBe(1);
    expect(out.turn.distance_to(new Vec3(-8, -28, 14))).toBeLessThan(1e-6);
    s.aimGoal = true;
    for (let i = 0; i < 120; i++) stepRig(s, input({ body: { speed: 0, grounded: true, running: true, stance: 'stand', landing: null } }));
    expect(s.sprint).toBe(0);
  });

  it('lags behind the view turning and springs back when it stops', () => {
    const s = freshRig();
    stepRig(s, input());
    let out = stepRig(s, input());
    // Turning right at 180°/s: the item trails left (negative yaw), within the cap.
    for (let i = 1; i <= 20; i++) out = stepRig(s, input({ view: { yaw: i * 3, pitch: 0 } }));
    expect(out.turn.y).toBeLessThan(-0.5);
    expect(out.turn.y).toBeGreaterThan(-5.5);
    for (let i = 0; i < 120; i++) out = stepRig(s, input({ view: { yaw: 60, pitch: 0 } }));
    expect(Math.abs(out.turn.y)).toBeLessThan(0.01);
    // Across the ±180 seam it is the short way round.
    const seam = freshRig();
    stepRig(seam, input({ view: { yaw: 179, pitch: 0 } }));
    out = stepRig(seam, input({ view: { yaw: -179, pitch: 0 } }));
    expect(out.turn.y).toBeLessThan(0);
  });

  it('recoil kicks back and up, rises the muzzle, follows the pattern, then settles', () => {
    const s = freshRig();
    stepRig(s, input());
    fireRig(s, RECOIL, 1);
    let lowest = 1;
    let rise = 0;
    for (let i = 0; i < 10; i++) {
      const out = stepRig(s, input());
      lowest = Math.min(lowest, out.offset.z);
      rise = Math.max(rise, out.turn.x);
    }
    expect(0.4 - lowest).toBeGreaterThan(0.012);
    // Pitch is positive up: the muzzle rises.
    expect(rise).toBeGreaterThan(2);
    for (let i = 0; i < 120; i++) stepRig(s, input());
    expect(stepRig(s, input()).offset.distance_to(new Vec3(0.14, -0.3, 0.4))).toBeLessThan(1e-4);
    // The pattern: first shots strongest, the last repeats; it restarts after `reset`.
    const kickOf = (shots: number, gap: number): number => {
      const r = freshRig();
      for (let i = 0; i < shots; i++) {
        fireRig(r, RECOIL, 1);
        for (let t = 0; t < gap; t++) stepRig(r, input());
      }
      return r.back.v;
    };
    const one = freshRig();
    fireRig(one, RECOIL, 1);
    const two = freshRig();
    fireRig(two, RECOIL, 1);
    fireRig(two, RECOIL, 1);
    expect(two.back.v - one.back.v).toBeCloseTo(-0.02 * 1.3 * 9 * 2 * Math.PI, 9);
    expect(one.shot).toBe(1);
    expect(kickOf(1, 0)).toBeCloseTo(-0.02 * 1.45 * 9 * 2 * Math.PI, 9);
    const r = freshRig();
    fireRig(r, RECOIL, 1);
    for (let t = 0; t < 30; t++) stepRig(r, input());
    fireRig(r, RECOIL, 1);
    expect(r.shot).toBe(1);
    // Deterministic: the same shots, the same motion.
    const a = freshRig();
    const b = freshRig();
    for (const x of [a, b]) for (let i = 0; i < 5; i++) { fireRig(x, RECOIL, 1); stepRig(x, input()); stepRig(x, input()); }
    expect(a).toEqual(b);
  });

  it('dips on landing by fall speed', () => {
    const s = freshRig();
    stepRig(s, input({ body: { speed: 0, grounded: true, running: false, stance: 'stand', landing: 8 } }));
    let lowest = 0;
    for (let i = 0; i < 20; i++) lowest = Math.min(lowest, stepRig(s, input()).offset.y + 0.3);
    expect(lowest).toBeLessThan(-0.015);
  });

  it('adds the playing pose on top', () => {
    const s = freshRig();
    const out = stepRig(s, input({ pose: { def: BUILT_IN_POSES['reload']!, t: 0.5 } }));
    expect(out.turn.distance_to(new Vec3(-18, -18, 40))).toBeLessThan(1e-9);
  });
});

// ── In a 3D kernel ─────────────────────────────────────────────────────────────

/** A rifle model with the sockets the exporter writes from a code model's viewmodel block. */
const RIFLE = {
  format: 'parallax.model', version: 1,
  materials: { steel: { color: '#333333', metallic: 0.8, roughness: 0.4 } },
  parts: [{ name: 'receiver', shape: 'box', size: [0.06, 0.1, 0.6], material: 'steel' }],
  sockets: [
    { name: 'grip_r', position: [0.055, 0.135, -0.19] },
    { name: 'grip_l', position: [-0.067, 0.14, 0] },
    { name: 'sight', position: [-0.018, 0.28, -0.035], kind: 'sight' },
    { name: 'muzzle', position: [-0.018, 0.225, 0.735], kind: 'muzzle' },
  ],
};
const ARMS = {
  format: 'parallax.model', version: 1,
  materials: { skin: { color: '#c08060', metallic: 0, roughness: 0.8 } },
  skeleton: {
    bones: [
      { name: 'Spine', parent: null },
      { name: 'RightArm', parent: 0, position: [0.18, 0, 0] },
      { name: 'RightForeArm', parent: 1, position: [0, -0.05, 0.28] },
      { name: 'RightHand', parent: 2, position: [0, 0, 0.26] },
      { name: 'LeftArm', parent: 0, position: [-0.18, 0, 0] },
      { name: 'LeftForeArm', parent: 4, position: [0, -0.05, 0.28] },
      { name: 'LeftHand', parent: 5, position: [0, 0, 0.26] },
    ],
    inverse_bind: encodeBuffer('f32', [[0, 0, 0], [0.18, 0, 0], [0.18, -0.05, 0.28], [0.18, -0.05, 0.54], [-0.18, 0, 0], [-0.18, -0.05, 0.28], [-0.18, -0.05, 0.54]]
      .flatMap(([x, y, z]) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -x!, -y!, -z!, 1])),
  },
  parts: [{ name: 'shoulders', parent: 'Spine', shape: 'box', size: [0.4, 0.1, 0.1], material: 'skin' }],
};

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, typeof v === 'string' ? v : JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

interface Vm extends Fields {
  fire(options?: { strength?: number }): void;
  aim(on: boolean): void;
  play(pose: string, options?: { seconds?: number }): void;
  readonly held: unknown;
  readonly hands: unknown;
  readonly __view_layer__: { camera: EntityId; fov: number; near: number; body: EntityId | null; bodyOptions: Record<string, string> };
}

async function range(viewmodelData: Record<string, unknown> = {}, extraEntities: unknown[] = []) {
  const project = files({
    'prefabs/floor.prefab.json': { components: { collider: { shape: 'box', size: [60, 1, 60], offset: [0, -0.5, 0] } } },
    'prefabs/player.prefab.json': { components: { character: { acceleration: 1000 } } },
    'prefabs/eye.prefab.json': {
      components: { camera: { rig: 'fixed', fov: 75 } },
      children: [{ name: 'hands', components: { viewmodel: { item: 'rifle_view', arms: 'fp_arms', body: 'player', ...viewmodelData } } }],
    },
    'prefabs/rifle_view.prefab.json': { components: { model: { model: 'models/rifle' }, viewmodel_item: { hip: [0.14, -0.36, 0.4], eye_relief: 0.17 } } },
    'prefabs/fp_arms.prefab.json': { components: { model: { model: 'models/arms' }, animator: {} } },
    'prefabs/loose.prefab.json': { components: { viewmodel: {} } },
    'prefabs/soldier.prefab.json': { components: { character: {}, model: { model: 'models/arms' } } },
    'prefabs/crate.prefab.json': { components: { collider: { shape: 'box', size: [0.3, 0.3, 0.3] }, rigidbody: { kind: 'dynamic' } } },
    'scenes/main/scene.json': {
      entities: [{ prefab: 'floor' }, { prefab: 'player', id: 'player' }, { prefab: 'eye', id: 'eye', at: [0, 1.6, 0] }, ...extraEntities],
    },
    'assets/models/rifle.model.json': RIFLE,
    'assets/models/arms.model.json': ARMS,
  });
  const loaded = loadProject(project);
  expect(loaded.diagnostics).toEqual([]);
  const cues: Fields[] = [];
  const plugin = render3d({ surface: new RecordingSurface3d(), files: project });
  const vm = viewmodel();
  const kernel = new Kernel({
    project: loaded,
    game: { components: [], resources: [], events: [], behaviors: [], systems: [{ id: 'listen', scenes: [], handlers: [{ event: VIEWMODEL_CUE, method: 'cue' }], create: () => ({ cue: (_c: unknown, e: Fields) => cues.push(e) }) } as unknown as SystemDef] },
    plugins: [visuals({ dimension: '3d' }), physics3d({}), apiCharacters(), models({ files: project, binary: new MemoryBinaryFiles({}) }), plugin, vm], context: {}, fixedStep: DT,
  });
  plugin.engine.preload();
  await plugin.engine.whenLoaded();
  kernel.start('main');
  const find = (placed: string): EntityRecord => [...kernel.world.live()].find((r) => r.placedId === placed)!;
  const hands = (): EntityRecord => kernel.world.require(find('eye').children[0]!);
  return {
    kernel, vm, cues, find, hands,
    fields: (): Vm => hands().components.get('viewmodel') as Vm,
    step: (n = 1, each?: () => void) => { for (let i = 0; i < n; i++) { each?.(); kernel.step(DT); } },
  };
}

describe('the viewmodel plugin', () => {
  it('spawns its item and arms as children, plays "draw" for a new item, and rests at the item\'s hip', async () => {
    const r = await range();
    r.step(1);
    const v = r.fields();
    const item = r.kernel.world.require(v.held as EntityId);
    expect(item.parent).toBe(r.hands().id);
    expect(item.prefab).toBe('rifle_view');
    expect(r.kernel.world.require(v.hands as EntityId).prefab).toBe('fp_arms');
    expect(v['pose']).toBe('draw');
    // Drawn from below.
    expect(item.transform.position.y).toBeLessThan(-0.45);
    r.step(60);
    expect(v['pose']).toBeNull();
    expect(item.transform.position.distance_to(new Vec3(0.14, -0.36, 0.4))).toBeLessThan(0.01);
    // Swapping the item spawns the new one and draws again.
    v['item'] = 'fp_arms';
    r.step(1);
    expect(r.kernel.world.isAlive(item.id)).toBe(false);
    expect(r.kernel.world.require(v.held as EntityId).prefab).toBe('fp_arms');
    expect(v['pose']).toBe('draw');
  });

  it('aims the sight socket onto the view axis at eye relief', async () => {
    const r = await range();
    r.step(60);
    const v = r.fields();
    v.aim(true);
    r.step(30);
    expect(v['aiming']).toBe(1);
    const item = r.kernel.world.require(v.held as EntityId);
    const sight = r.kernel.service(MODEL_RIG_SERVICE).socket(item.id, 'sight', 'world')!.position;
    const eye = r.find('eye').transform;
    const local = eye.worldRotation().inverse().rotate(sight.__sub__(eye.worldPosition()));
    // Sway is small while aiming: within a few millimetres of the axis.
    expect(Math.hypot(local.x, local.y)).toBeLessThan(0.004);
    expect(local.z).toBeCloseTo(0.17, 2);
    expect(v.__view_layer__.fov).toBeCloseTo(40, 6);
    v.aim(false);
    r.step(30);
    expect(v.__view_layer__.fov).toBeCloseTo(54, 6);
  });

  it('puts each hand\'s IK goal on its grip socket every frame, following recoil', async () => {
    const r = await range();
    r.step(60);
    const v = r.fields();
    const item = r.kernel.world.require(v.held as EntityId);
    const rigs = r.kernel.service(MODEL_RIG_SERVICE);
    const playback = (): AnimatorPlayback => (r.kernel.world.require(v.hands as EntityId).components.get('animator') as Fields & { __playback__: AnimatorPlayback }).__playback__;
    const check = () => {
      const goals = Object.fromEntries(playback().ik.reach.map((g) => [g.limb, new Vec3(...g.point!)]));
      expect(goals['right_hand']!.distance_to(rigs.socket(item.id, 'grip_r', 'world')!.position)).toBeLessThan(1e-6);
      expect(goals['left_hand']!.distance_to(rigs.socket(item.id, 'grip_l', 'world')!.position)).toBeLessThan(1e-6);
      expect(r.vm.grips(r.hands().id).right!.distance_to(goals['right_hand']!)).toBeLessThan(1e-6);
      // render3d's two-bone IK puts the posed hand bones on them.
      const arms = r.kernel.world.require(v.hands as EntityId).id;
      expect(rigs.socket(arms, 'RightHand', 'world')!.position.distance_to(goals['right_hand']!)).toBeLessThan(1e-5);
      expect(rigs.socket(arms, 'LeftHand', 'world')!.position.distance_to(goals['left_hand']!)).toBeLessThan(1e-5);
    };
    check();
    v.fire();
    r.step(3);
    check();
    // A grip the item names as "" leaves that hand free.
    r.kernel.world.require(item.id).components.get('viewmodel_item')!['grips'] = ['grip_r', ''];
    r.step(1);
    expect(playback().ik.reach.map((g) => g.limb)).toEqual(['right_hand']);
  });

  it('is paced by the body: bob while it walks, the sprint pose while it runs', async () => {
    const r = await range();
    r.step(60);
    const v = r.fields();
    const item = (): Vec3 => r.kernel.world.require(v.held as EntityId).transform.position;
    const player = r.find('player').components.get('character') as Fields & { move(d: Vec3, o?: { run?: boolean }): void };
    let spread = 0;
    r.step(120, () => {
      player.move(new Vec3(1, 0, 0));
      spread = Math.max(spread, Math.abs(item().x - 0.14));
    });
    expect(spread).toBeGreaterThan(0.005);
    let turned = Quat.IDENTITY;
    r.step(60, () => {
      player.move(new Vec3(1, 0, 0), { run: true });
      turned = r.kernel.world.require(v.held as EntityId).transform.rotation;
    });
    expect(turned.to_euler().y).toBeLessThan(-20);
    expect(v.__view_layer__.body).toBe(r.find('player').id);
  });

  it('plays poses and emits their cues as ViewmodelCue; a holding pose stays', async () => {
    const r = await range({ poses: { wave: { seconds: 0.5, keys: [{ at: 0.5, offset: [0, 0.1, 0] }], cues: [{ at: 0.5, name: 'peak' }] } } });
    r.step(60);
    const v = r.fields();
    v.play('reload');
    r.step(110);
    expect(r.cues.map((c) => c['cue'])).toEqual(['mag_out', 'mag_in']);
    expect(r.cues.every((c) => c['pose'] === 'reload')).toBe(true);
    v.play('wave');
    r.step(40);
    expect(r.cues.some((c) => c['cue'] === 'peak')).toBe(true);
    v.play('holster');
    r.step(60);
    expect(v['pose']).toBe('holster');
    expect(() => v.play('relaod')).toThrow(/PP3870[\s\S]*"reload"/);
  });

  it('a snapshot restores the rig exactly', async () => {
    const r = await range();
    r.step(30);
    const v = r.fields();
    v.fire();
    v.aim(true);
    r.step(2);
    const snap = r.kernel.snapshot();
    r.step(20);
    const after = r.kernel.world.require(v.held as EntityId).transform.position;
    r.kernel.restore(snap);
    r.step(20);
    expect(r.kernel.world.require(r.fields().held as EntityId).transform.position.distance_to(after)).toBeLessThan(1e-12);
  });

  it('raises PP3871 for a viewmodel that isn\'t under a camera', async () => {
    const r = await range({}, [{ prefab: 'loose' }]);
    expect(() => r.step(1)).toThrow(/PP3871[\s\S]*under a camera/);
  });

  it('Character.hold() rides a Model socket (the api attaches it with attach()\'s checks), and drop() frees it', async () => {
    const r = await range({}, [{ prefab: 'soldier', id: 'soldier', at: [4, 0, 0] }, { prefab: 'crate', id: 'crate', at: [4, 0.15, 1] }]);
    r.step(5);
    const soldier = r.find('soldier');
    const crate = r.find('crate');
    const c = soldier.components.get('character') as Fields & { hold(i: EntityId, o?: { socket?: string }): boolean; drop(): unknown };
    expect(() => c.hold(crate.id, { socket: 'Rgiht' })).toThrow(/PP2122/);
    expect(c.hold(crate.id, { socket: 'RightHand' })).toBe(true);
    expect(crate.parent).toBe(soldier.id);
    expect(crate.components.get('socket')!['name']).toBe('RightHand');
    r.step(30);
    const hand = r.kernel.service(MODEL_RIG_SERVICE).socket(soldier.id, 'RightHand', 'world')!.position;
    expect(crate.transform.worldPosition().distance_to(hand)).toBeLessThan(1e-3);
    expect(c.drop()).toBe(crate.id);
    expect(crate.components.has('socket')).toBe(false);
    r.step(60);
    expect(crate.transform.worldPosition().y).toBeLessThan(0.2);
  });
});
