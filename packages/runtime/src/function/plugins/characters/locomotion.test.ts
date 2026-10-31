/**
 * Automatic locomotion: clip names resolved rig-neutrally with fallbacks, gaits with
 * hysteresis, headings relative to the facing, turns and landings (pure), and a Character
 * driving an Animator without a graph headless on Rapier — stride-matched rates, strafes,
 * game code keeping the base layer, and the strafe/turn params for authored graphs.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { Vec3 } from '../../../core/index.js';
import type { EntityId, ProjectFiles } from '../../../core/index.js';
import { loadProject } from '../../../resource/index.js';
import { Kernel } from '../../kernel/index.js';
import type { Fields, KernelPlugin } from '../../kernel/index.js';
import { ANIMATION_CLIPS_SERVICE, MODEL_RIG_SERVICE } from '../../services/index.js';
import type { ClipInfo, RootSample } from '../../services/index.js';
import { initPhysics3d, physics3d } from '../physics3d/index.js';
import { MemoryBinaryFiles } from '../../../platform/headless/render3d.js';
import { models } from '../models/index.js';
import { standInCharacter } from '../models/testing.js';
import { visuals } from '../visuals/index.js';
import { characters } from './index.js';
import { characterProblems } from './rules.js';
import { clipKey, decompose, LocomotionSelector, resolveLocomotionClip, tuningFor } from './locomotion.js';
import type { LocomotionInput } from './locomotion.js';

const DT = 1 / 60;

beforeAll(async () => {
  await initPhysics3d();
});

const MIXAMO = [
  'Idle', 'Walking', 'Walking Backwards', 'Left Strafe Walking', 'Right Strafe Walking', 'Running', 'Running Backward',
  'Strafe Running Left', 'Strafe Running Right', 'Left Turn', 'Right Turn', 'Jumping', 'Falling Idle', 'Hard Landing', 'Crouched Walking',
];

describe('clip names', () => {
  it('match rig-neutrally, exact before containment, shortest first', () => {
    expect(clipKey('Armature|Walk_Cycle')).toBe('walkcycle');
    expect(clipKey('mixamo.com')).toBe('');
    expect(resolveLocomotionClip('walk', MIXAMO)).toBe('Walking');
    expect(resolveLocomotionClip('walk_back', MIXAMO)).toBe('Walking Backwards');
    expect(resolveLocomotionClip('walk_left', MIXAMO)).toBe('Left Strafe Walking');
    expect(resolveLocomotionClip('run_right', MIXAMO)).toBe('Strafe Running Right');
    expect(resolveLocomotionClip('fall', MIXAMO)).toBe('Falling Idle');
    expect(resolveLocomotionClip('hard_land', MIXAMO)).toBe('Hard Landing');
    expect(resolveLocomotionClip('turn_right', MIXAMO)).toBe('Right Turn');
    // Lowercase / exporter names.
    const plain = ['Armature|idle', 'Armature|walk', 'Armature|run', 'Armature|jump'];
    expect(resolveLocomotionClip('idle', plain)).toBe('Armature|idle');
    expect(resolveLocomotionClip('sprint', plain)).toBe('Armature|run');
    expect(resolveLocomotionClip('fall', plain)).toBe('Armature|idle');
  });

  it('fall back down each state chain, and take the character\'s own choice first', () => {
    const sparse = ['Idle', 'Walking'];
    expect(resolveLocomotionClip('run_left', sparse)).toBe('Walking');
    expect(resolveLocomotionClip('sprint', sparse)).toBe('Walking');
    expect(resolveLocomotionClip('crouch_walk', sparse)).toBe('Walking');
    expect(resolveLocomotionClip('turn_left', sparse)).toBe('Idle');
    expect(resolveLocomotionClip('swim', sparse)).toBe('Idle');
    expect(resolveLocomotionClip('walk', ['Walking Backwards', 'Left Strafe Walking'])).toBeNull();
    expect(resolveLocomotionClip('walk', sparse, { walk: 'assets/models/anims.glb#Walk' })).toBe('assets/models/anims.glb#Walk');
    // Authored library clip names.
    const library = ['stand_idle', 'stand_idle_left', 'walk_cycle', 'run_cycle', 'carry_walk', 'human_fall'];
    expect(resolveLocomotionClip('idle', library)).toBe('stand_idle');
    expect(resolveLocomotionClip('walk', library)).toBe('walk_cycle');
    expect(resolveLocomotionClip('run', library)).toBe('run_cycle');
    expect(resolveLocomotionClip('fall', library)).toBe('human_fall');
  });
});

describe('the selector', () => {
  const tuning = tuningFor(2, 6);
  const at = (vx: number, vz: number, extra: Partial<LocomotionInput> = {}): LocomotionInput => ({
    motion: 'ground', stance: 'stand', traversal: null, grounded: true, velocity: { x: vx, y: 0, z: vz }, yaw: 0, running: false, landed: null, dt: DT, ...extra,
  });

  it('picks gaits with hysteresis around the boundaries', () => {
    const s = new LocomotionSelector();
    expect(s.update(at(0, 0), tuning).state).toBe('idle');
    expect(s.update(at(0, 2), tuning).state).toBe('walk');
    // The walk/run boundary is midway (4 m/s); hovering just over it keeps walking.
    expect(s.update(at(0, 4.1), tuning).state).toBe('walk');
    expect(s.update(at(0, 4.6), tuning).state).toBe('run');
    expect(s.update(at(0, 3.9), tuning).state).toBe('run');
    expect(s.update(at(0, 3.2), tuning).state).toBe('walk');
    // Sprint past 1.2 × run_speed.
    expect(s.update(at(0, 6), tuning).state).toBe('run');
    expect(s.update(at(0, 8), tuning).state).toBe('sprint');
    // Holding run promotes a walk-speed character to the run gait early.
    const r = new LocomotionSelector();
    expect(r.update(at(0, 3.5, { running: true }), tuning).state).toBe('run');
  });

  it('heads relative to the facing (left-handed: right is +x facing +z), with a margin to change axis', () => {
    expect(decompose(1, 0, 0)).toEqual({ forward: 0, right: 1 });
    const d = decompose(0, 1, 90);
    expect(d.forward).toBeCloseTo(0, 6);
    expect(d.right).toBeCloseTo(-1, 6);
    const s = new LocomotionSelector();
    expect(s.update(at(2, 0), tuning).state).toBe('walk_right');
    expect(s.params.strafe_speed).toBeCloseTo(2, 6);
    expect(s.params.direction).toBeCloseTo(90, 6);
    expect(s.update(at(-2, 0), tuning).state).toBe('walk_left');
    // A near-diagonal stays on the strafe axis until forward clearly wins.
    expect(s.update(at(-1.4, 1.5), tuning).state).toBe('walk_left');
    expect(s.update(at(-1, 2), tuning).state).toBe('walk');
    expect(s.update(at(0, -2), tuning).state).toBe('walk_back');
    // Facing +x (yaw 90), moving +x is forward.
    expect(s.update(at(2, 0, { yaw: 90 }), tuning).state).toBe('walk');
  });

  it('turns on the spot, jumps, falls and lands', () => {
    const s = new LocomotionSelector();
    s.update(at(0, 0, { yaw: 0 }), tuning);
    let state = '';
    for (let i = 1; i <= 20; i++) state = s.update(at(0, 0, { yaw: i * 3 }), tuning).state; // 180 deg/s right
    expect(state).toBe('turn_right');
    expect(s.params.turn_rate).toBeGreaterThan(100);
    for (let i = 0; i < 30; i++) state = s.update(at(0, 0, { yaw: 60 }), tuning).state;
    expect(state).toBe('idle');
    expect(s.update(at(0, 0, { grounded: false, velocity: { x: 0, y: 4, z: 0 } }), tuning).state).toBe('jump');
    expect(s.update(at(0, 0, { grounded: false, velocity: { x: 0, y: -6, z: 0 } }), tuning).state).toBe('fall');
    const land = s.update(at(0, 0, { landed: 13 }), tuning);
    expect(land).toMatchObject({ state: 'hard_land', loop: false });
    for (let i = 0; i < 30; i++) state = s.update(at(0, 0), tuning).state;
    expect(state).toBe('idle');
    // A soft hop just resumes locomotion.
    expect(s.update(at(0, 0, { landed: 3 }), tuning).state).toBe('idle');
    expect(s.update(at(0, 0, { stance: 'crouch' }), tuning).state).toBe('crouch_idle');
    expect(s.update(at(0, 0, { motion: 'swim' }), tuning).state).toBe('swim_idle');
  });

  it('Character.clips must name locomotion states (PP3176)', () => {
    expect(characterProblems({ clips: { walk: 'Walk_Rifle' } })).toEqual([]);
    expect(characterProblems({ clips: { strut: 'Walk' } })[0]).toMatchObject({ code: 'PP3176', pointer: '/clips/strut' });
  });
});

// ── Headless: a Character drives an Animator with no graph ─────────────────────

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

/** A model with Mixamo's clip names: "Walking" travels 1.4 m/s, the rest play in place. */
function fakeModel(clips: readonly string[]): KernelPlugin {
  return {
    id: 'fake_model',
    install: (kernel) => {
      kernel.provide(MODEL_RIG_SERVICE, {
        rig: () => ({ path: 'assets/models/hero.glb', document: null, sockets: [], parts: [], materials: [], clips }),
        socket: () => null,
        authoredClips: () => [],
      });
      kernel.provide(ANIMATION_CLIPS_SERVICE, {
        clip: (_e: EntityId, _ref: string): ClipInfo => ({ duration: 1, loop: null, markers: [] }),
        root: (_e: EntityId, ref: string, time: number): RootSample => ({ x: 0, y: 1, z: ref === 'Walking' ? 1.4 * Math.min(time, 1) : 0, yaw: 0 }),
      });
    },
  };
}

interface Playback { layers: { samples: { clip: string; time: number; weight: number }[] }[] }
interface Anim extends Fields {
  readonly clip: string | null;
  readonly __playback__: Playback;
  play(clip: string, kw?: object): void;
  play_once(clip: string, kw?: object): void;
  param(name: string): unknown;
}
interface Mover extends Fields { move(direction: Vec3, kw?: object): void; face(yaw: number): void }

function game(character: Record<string, unknown>, animator: Record<string, unknown>, clips: readonly string[] = MIXAMO) {
  const floor = { components: { collider: { shape: 'box', size: [80, 1, 80], offset: [0, -0.5, 0] } } };
  const hero = { components: { character: { acceleration: 1000, ...character }, model: { model: 'hero.glb' }, animator } };
  const project = loadProject(files({
    'prefabs/floor.prefab.json': floor, 'prefabs/hero.prefab.json': hero, 'assets/models/hero.glb': '',
    'scenes/main/scene.json': { entities: [{ prefab: 'floor' }, { prefab: 'hero', id: 'hero' }] },
  }));
  expect(project.diagnostics).toEqual([]);
  const kernel = new Kernel({
    project, game: { components: [], resources: [], events: [], behaviors: [], systems: [] },
    plugins: [visuals({ dimension: '3d' }), physics3d({ gravity: -9.8 }), characters(), fakeModel(clips)], context: {}, fixedStep: DT,
  });
  kernel.start('main');
  const record = [...kernel.world.live()].find((r) => r.placedId === 'hero')!;
  return {
    kernel,
    character: record.components.get('character') as Mover,
    animator: record.components.get('animator') as Anim,
    run: (frames: number, each?: () => void) => { for (let i = 0; i < frames; i++) { each?.(); kernel.step(DT); } },
  };
}

const timeOf = (anim: Anim, clip: string): number => anim.__playback__.layers[0]!.samples.find((s) => s.clip === clip)!.time;

describe('a Character with an Animator and no graph', () => {
  it('stands, walks with the stride matched to its speed, runs, and strafes when it doesn\'t face its travel', () => {
    const g = game({ walk_speed: 2, run_speed: 6 }, {});
    g.run(20);
    expect(g.animator.clip).toBe('Idle');
    g.run(30, () => g.character.move(new Vec3(0, 0, 1)));
    expect(g.animator.clip).toBe('Walking');
    // 2 m/s over a clip whose root travels 1.4 m/s: 1.42× (rounded to 0.02).
    const t0 = timeOf(g.animator, 'Walking');
    g.run(60, () => g.character.move(new Vec3(0, 0, 1)));
    expect(timeOf(g.animator, 'Walking') - t0).toBeCloseTo(1.42, 2);
    g.run(30, () => g.character.move(new Vec3(0, 0, 1), { run: true }));
    expect(g.animator.clip).toBe('Running');
    g.run(60);
    expect(g.animator.clip).toBe('Idle');

    const s = game({ walk_speed: 2, run_speed: 6, face_movement: false }, {});
    s.run(10);
    s.run(30, () => s.character.move(new Vec3(1, 0, 0)));
    expect(s.animator.clip).toBe('Right Strafe Walking');
    s.run(30, () => s.character.move(new Vec3(0, 0, -1)));
    expect(s.animator.clip).toBe('Walking Backwards');
  });

  it('leaves the base layer to game code while it plays its own clip, and takes it back after', () => {
    const g = game({ walk_speed: 2 }, {}, [...MIXAMO, 'Wave']);
    g.run(10);
    g.animator.play_once('Wave', { fade: 0 });
    g.run(20, () => g.character.move(new Vec3(0, 0, 1)));
    expect(g.animator.clip).toBe('Wave');
    g.run(60, () => g.character.move(new Vec3(0, 0, 1)));
    expect(g.animator.clip).toBe('Walking');
    g.animator.play('Wave', { fade: 0 });
    g.run(30, () => g.character.move(new Vec3(0, 0, 1)));
    expect(g.animator.clip).toBe('Wave');
  });

  it('a graph keeps its own clips but gets the strafe and turn params; "off" plays nothing', () => {
    const graph = {
      params: { speed: 0, forward_speed: 0, strafe_speed: 0, direction: 0, turn_rate: 0 },
      layers: [{ name: 'base', states: { move: { clip: 'Idle' } } }],
    };
    const g = game({ walk_speed: 2, face_movement: false }, graph);
    g.run(30, () => g.character.move(new Vec3(-1, 0, 0)));
    expect(g.animator.clip).toBe('Idle');
    expect(g.animator.param('strafe_speed')).toBeCloseTo(-2, 2);
    expect(g.animator.param('direction')).toBeCloseTo(-90, 1);
    const off = game({ locomotion: 'off' }, {});
    off.run(30, () => off.character.move(new Vec3(0, 0, 1)));
    expect(off.animator.clip).toBeNull();
  });
});

describe('on a real glTF', () => {
  it('reads the clip names from the model file and matches in-place clips to the gait\'s stride', async () => {
    const floor = { components: { collider: { shape: 'box', size: [80, 1, 80], offset: [0, -0.5, 0] } } };
    const hero = { components: { character: { acceleration: 1000, walk_speed: 2.4 }, model: { model: 'models/hero' }, animator: {} } };
    const project = files({
      'prefabs/floor.prefab.json': floor, 'prefabs/hero.prefab.json': hero, 'assets/models/hero.glb': '',
      'scenes/main/scene.json': { entities: [{ prefab: 'floor' }, { prefab: 'hero', id: 'hero' }] },
    });
    const loaded = loadProject(project);
    const plugin = models({ files: project, binary: new MemoryBinaryFiles(new Map([['assets/models/hero.glb', standInCharacter(['Armature|Idle', 'Armature|Walk', 'Armature|Run'])]])) });
    const kernel = new Kernel({
      project: loaded, game: { components: [], resources: [], events: [], behaviors: [], systems: [] },
      plugins: [visuals({ dimension: '3d' }), physics3d({ gravity: -9.8 }), characters(), plugin], context: {}, fixedStep: DT,
    });
    plugin.source.preload();
    await plugin.source.whenLoaded();
    kernel.start('main');
    const record = [...kernel.world.live()].find((r) => r.placedId === 'hero')!;
    const animator = record.components.get('animator') as Anim;
    const character = record.components.get('character') as Mover;
    for (let i = 0; i < 20; i++) kernel.step(DT);
    expect(animator.clip).toBe('Armature|Idle');
    for (let i = 0; i < 30; i++) { character.move(new Vec3(0, 0, 1)); kernel.step(DT); }
    expect(animator.clip).toBe('Armature|Walk');
    // In place: the walk's typical 1.5 m/s stride, so 2.4 m/s plays it at 1.6×.
    const t0 = timeOf(animator, 'Armature|Walk');
    for (let i = 0; i < 60; i++) { character.move(new Vec3(0, 0, 1)); kernel.step(DT); }
    expect(timeOf(animator, 'Armature|Walk') - t0).toBeCloseTo(1.6, 2);
  });
});
