import { describe, expect, it } from 'vitest';
import { fail, ParallaxError, Quat, Vec3 } from '../../../core/index.js';
import type { EntityId, ProjectFiles } from '../../../core/index.js';
import { loadProject } from '../../../resource/index.js';
import { Kernel } from '../../kernel/index.js';
import type { EventDef, Fields, GameDefinition, KernelPlugin, SystemDef } from '../../kernel/index.js';
import { ANIMATION_CLIPS_SERVICE } from '../../services/index.js';
import type { ClipInfo, ClipMarker, RootSample } from '../../services/index.js';
import {
  ANIMATION_EVENT, blendWeights, CLIP_FINISHED, crossedMarkers, parseCondition, readAnimatorGraph, rootTravel, visuals,
} from './index.js';
import type { AnimatorPlayback } from './index.js';

const DT = 1 / 20;

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof ParallaxError) return e.diagnostic.code;
    throw e;
  }
  return 'no error';
}

// ── Pure parts ──────────────────────────────────────────────────────────────────

describe('animator graphs', () => {
  const ok = (data: Record<string, unknown>) => {
    const { graph, problems } = readAnimatorGraph(data);
    expect(problems).toEqual([]);
    return graph!;
  };
  const problems = (data: Record<string, unknown>) => readAnimatorGraph(data).problems.map((p) => [p.code, p.pointer]);

  it('no layers: one implicit, clip-driven base layer', () => {
    const graph = ok({ default_clip: 'idle' });
    expect(graph.layers.map((l) => [l.name, l.states.size])).toEqual([['base', 0]]);
    expect(graph.defaultClip).toBe('idle');
  });

  it('reads params, states, blends, transitions, masks, events and ik', () => {
    const graph = ok({
      params: { speed: 0, grounded: true, jump: 'trigger' },
      layers: [
        {
          name: 'base',
          states: {
            move: { blend: { param: 'speed', clips: [{ at: 6, clip: 'run' }, { at: 0, clip: 'idle' }, { at: 2, clip: 'walk' }] } },
            air: { clip: 'fall' },
          },
          transitions: [{ from: 'move', to: 'air', when: ['not grounded'], fade: 0.1 }, { from: '*', to: 'air', when: 'jump' }],
        },
        { name: 'upper', mask: ['Spine2'] },
      ],
      events: { walk: [{ time: 0.6, name: 'step' }, { time: 0.1, name: 'step' }] },
      ik: { feet: { speed_param: 'speed', grounded_param: 'grounded' }, look: {} },
    });
    const move = graph.layers[0]!.states.get('move')!;
    expect(move.motion.kind === 'blend' && move.motion.points.map((p) => p.clip)).toEqual(['idle', 'walk', 'run']);
    expect(graph.layers[0]!.entry).toBe('move');
    expect(graph.layers[0]!.transitions[1]).toMatchObject({ from: null, to: 'air', fade: 0.2, exit: null });
    expect(graph.layers[1]!.mask).toEqual(['Spine2']);
    expect(graph.events.get('walk')!.map((m) => m.time)).toEqual([0.1, 0.6]);
    expect(graph.ik.feet!.limbs).toEqual(['left_foot', 'right_foot']);
    expect(graph.ik.look!.bones).toEqual(['Head']);
  });

  it('reports every problem with its code and pointer', () => {
    expect(problems({
      params: { speed: 0, on: true },
      layers: [{
        name: 'base',
        states: { idle: { clip: 'idle' }, run: { clip: 'run', sped: 2 } },
        transitions: [
          { from: 'idle', to: 'rnu', when: ['speed > 1'] },
          { from: 'idle', to: 'run', when: ['sped > 1'] },
          { from: 'idle', to: 'run', when: ['on > 1'] },
          { from: 'idle', to: 'run' },
        ],
      }],
    })).toEqual([
      ['PP3760', '/layers/0/states/run/sped'],
      ['PP3762', '/layers/0/transitions/0/to'],
      ['PP3761', '/layers/0/transitions/1/when/0'],
      ['PP3763', '/layers/0/transitions/2/when/0'],
      ['PP3764', '/layers/0/transitions/3'],
    ]);
    expect(problems({ default_clip: 'idle', layers: [{ name: 'base', states: { a: { clip: 'a' } } }] })).toEqual([['PP3765', '/default_clip']]);
    expect(problems({ layers: [{ name: 'base', blend: 'additive' }] })).toEqual([['PP3765', '/layers/0/blend']]);
    expect(problems({ params: { x: 0 }, layers: [{ name: 'base', states: { m: { blend: { param: 'x', clips: [{ at: 0, clip: 'a' }] } } } }] }))
      .toEqual([['PP3766', '/layers/0/states/m/blend/clips']]);
    expect(problems({ ik: { feet: { limbs: ['left_fot'] } } })).toEqual([['PP3768', '/ik/feet/limbs/0']]);
  });

  it('parses conditions against param kinds', () => {
    const params = readAnimatorGraph({ params: { speed: 0, grounded: false, jump: 'trigger' } }).graph!.params;
    expect(parseCondition('speed >= 1.5', params)).toMatchObject({ param: 'speed', op: '>=', value: 1.5 });
    expect(parseCondition('not grounded', params)).toMatchObject({ param: 'grounded', op: '==', value: false });
    expect(parseCondition('grounded != true', params)).toMatchObject({ op: '==', value: false });
    expect(parseCondition('jump', params)).toMatchObject({ param: 'jump', value: true });
    expect(parseCondition('speed', params)).toMatchObject({ code: 'PP3763' });
    expect(parseCondition('jump == true', params)).toMatchObject({ code: 'PP3763' });
    expect(parseCondition('speeed > 1', params)).toMatchObject({ code: 'PP3761', fix: 'Did you mean "speed"?' });
  });

  it('blends 1D piecewise and 2D by gradient bands, exact at each clip', () => {
    const line = [{ at: [0], clip: 'idle', speed: 1 }, { at: [2], clip: 'walk', speed: 1 }, { at: [6], clip: 'run', speed: 1 }];
    expect(blendWeights(line, [-1])).toEqual([1, 0, 0]);
    expect(blendWeights(line, [1])).toEqual([0.5, 0.5, 0]);
    expect(blendWeights(line, [4])).toEqual([0, 0.5, 0.5]);
    expect(blendWeights(line, [9])).toEqual([0, 0, 1]);
    const plane = [
      { at: [0, 0], clip: 'idle', speed: 1 }, { at: [0, 1], clip: 'fwd', speed: 1 },
      { at: [1, 0], clip: 'right', speed: 1 }, { at: [-1, 0], clip: 'left', speed: 1 },
    ];
    for (const [i, p] of plane.entries()) {
      const w = blendWeights(plane, p.at);
      expect(w[i]).toBeCloseTo(1);
      expect(w.reduce((a, b) => a + b)).toBeCloseTo(1);
    }
    const between = blendWeights(plane, [0, 0.5]);
    expect(between[0]).toBeCloseTo(0.5);
    expect(between[1]).toBeCloseTo(0.5);
  });
});

describe('clip timelines', () => {
  const markers: ClipMarker[] = [{ time: 0, name: 'a' }, { time: 0.25, name: 'b' }, { time: 0.75, name: 'c' }];
  const names = (from: number, to: number, loop = true, fromStart = false): string[] =>
    crossedMarkers(markers, from, to, 1, loop, fromStart).map((m) => m.name);

  it('fires each marker once per crossing, (from, to], across any number of wraps', () => {
    expect(names(0, 0.25, true, true)).toEqual(['a', 'b']);
    expect(names(0.25, 0.5)).toEqual([]);
    expect(names(0.5, 1.0)).toEqual(['c', 'a']);
    expect(names(1.0, 1.25)).toEqual(['b']);
    expect(names(0.5, 3.3)).toEqual(['c', 'a', 'b', 'c', 'a', 'b', 'c', 'a', 'b']);
  });

  it('holds a one-shot at its end', () => {
    expect(names(0.5, 5, false)).toEqual(['c']);
    expect(names(1, 5, false)).toEqual([]);
  });

  it('carries the root across loop wraps', () => {
    const sample = (t: number): RootSample => ({ x: 0, y: 0, z: t * 2, yaw: t * 90 });
    expect(rootTravel(sample, 0.25, 0.75, 1, true)).toEqual({ x: 0, y: 0, z: 1, yaw: 45 });
    const wrapped = rootTravel(sample, 0.75, 2.25, 1, true);
    expect(wrapped.z).toBeCloseTo(3);
    expect(wrapped.yaw).toBeCloseTo(135);
    expect(rootTravel(sample, 0.5, 4, 1, false).z).toBeCloseTo(1);
  });
});

// ── In a kernel ─────────────────────────────────────────────────────────────────

const LENGTHS: Record<string, number> = { idle: 1, walk: 1, run: 0.5, fall: 1, land: 0.4, wave: 2, attack: 0.5, breathe: 2, stride: 1 };
const MARKERS: Record<string, ClipMarker[]> = { 'clips/stomp': [{ time: 0.2, name: 'impact' }] };

/** Clip facts as render3d gives them; "stride" walks 1.5 m along z per second, turning 10° per second. */
const CLIPS: KernelPlugin = {
  id: 'clips',
  install: (kernel) => kernel.provide(ANIMATION_CLIPS_SERVICE, {
    clip: (_entity: EntityId, ref: string): ClipInfo | null => {
      if (ref === 'clips/stomp') return { duration: 0.6, loop: false, markers: MARKERS[ref]! };
      const d = LENGTHS[ref];
      if (d === undefined) fail('PP3805', `no clip ${ref}`);
      return { duration: d, loop: null, markers: [] };
    },
    root: (_entity: EntityId, ref: string, time: number): RootSample | null =>
      (ref === 'stride' ? { x: 0, y: 1, z: 1.5 * Math.min(time, 1), yaw: 10 * Math.min(time, 1) } : null),
  }),
};

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

interface AnimatorApi extends Fields {
  readonly __playback__: AnimatorPlayback;
  readonly clip: unknown;
  readonly state: string | null;
  play(...a: unknown[]): void;
  play_once(...a: unknown[]): void;
  stop(...a: unknown[]): void;
  set_param(...a: unknown[]): void;
  trigger(...a: unknown[]): void;
  param(...a: unknown[]): unknown;
  has_param(...a: unknown[]): boolean;
  state_of(...a: unknown[]): string | null;
  set_layer_weight(...a: unknown[]): void;
  reach(...a: unknown[]): void;
  look_at(...a: unknown[]): void;
  take_root_motion(...a: unknown[]): { offset: Vec3; turn: number };
}

function world(animator: Record<string, unknown>, options: { clips?: boolean } = {}) {
  const heard: { event: string; payload: Fields; at: number }[] = [];
  let kernel: Kernel;
  const listen = (event: EventDef): SystemDef => ({
    id: `hear_${event.id}`, scenes: [], handlers: [{ event, method: 'on' }],
    create: () => ({ on: (_ctx: unknown, e: Fields) => { heard.push({ event: event.id, payload: e, at: Math.round(kernel.time.now * 1000) / 1000 }); } }),
  });
  const project = loadProject(files({
    'prefabs/hero.prefab.json': { components: { animator } },
    'scenes/main/scene.json': { entities: [{ id: 'hero', prefab: 'hero' }] },
  }));
  expect(project.diagnostics).toEqual([]);
  const def: GameDefinition = {
    components: [], resources: [], events: [], behaviors: [], systems: [listen(ANIMATION_EVENT), listen(CLIP_FINISHED)],
  };
  kernel = new Kernel({
    project, game: def, plugins: [visuals({ dimension: '3d' }), ...(options.clips === false ? [] : [CLIPS])], context: {}, fixedStep: DT,
  });
  kernel.start('main');
  const id = [...kernel.world.live()].find((r) => r.placedId === 'hero')!.id;
  return {
    kernel,
    heard,
    id,
    animator: () => kernel.world.require(id).components.get('animator') as unknown as AnimatorApi,
    steps: (n: number) => { for (let i = 0; i < n; i++) kernel.step(DT); },
  };
}

const LOCOMOTION = {
  params: { speed: 0, grounded: true, jump: 'trigger' },
  layers: [
    {
      name: 'base',
      states: {
        move: { blend: { param: 'speed', clips: [{ at: 0, clip: 'idle' }, { at: 2, clip: 'walk' }, { at: 6, clip: 'run' }] } },
        air: { clip: 'fall' },
        land: { clip: 'land', loop: false },
      },
      transitions: [
        { from: '*', to: 'air', when: ['jump'], fade: 0.1 },
        { from: 'move', to: 'air', when: ['not grounded'], fade: 0.1 },
        { from: 'air', to: 'land', when: ['grounded'], fade: 0 },
        { from: 'land', to: 'move', exit: 1, fade: 0.2 },
      ],
    },
    { name: 'upper', mask: ['Spine2'] },
    { name: 'breath', blend: 'additive', weight: 0.5, states: { b: { clip: 'breathe' } } },
  ],
  events: { walk: [{ time: 0.5, name: 'footstep' }], run: [{ time: 0.25, name: 'footstep' }] },
};

describe('animators in a kernel', () => {
  it('a state machine takes transitions on its params', () => {
    const w = world(LOCOMOTION);
    const a = w.animator();
    expect(a.state).toBe('move');
    a.set_param('grounded', false);
    w.steps(1);
    expect(a.state).toBe('air');
    w.steps(5);
    a.set_param('grounded', true);
    w.steps(1);
    expect(a.state).toBe('land');
    // land is 0.4 s and waits for its end (exit 1): 8 steps of 0.05.
    w.steps(7);
    expect(a.state).toBe('land');
    w.steps(1);
    expect(a.state).toBe('move');
  });

  it('has_param says what the graph declares, optionally of one kind', () => {
    const a = world(LOCOMOTION).animator();
    expect(a.has_param('jump')).toBe(true);
    expect(a.has_param('jump', 'trigger')).toBe(true);
    expect(a.has_param('grounded', 'trigger')).toBe(false);
    expect(a.has_param('grounded', 'bool')).toBe(true);
    expect(a.has_param('flinch')).toBe(false);
    expect(() => a.has_param('jump', 'flag')).toThrow(/PP3769/);
  });

  it('a trigger fires one transition and is used up; unread, it lapses after one update', () => {
    const w = world(LOCOMOTION);
    const a = w.animator();
    a.trigger('jump');
    w.steps(1);
    expect(a.state).toBe('air');
    expect(a.param('jump')).toBe(false);
    // In "air" no transition reads jump, so the trigger lapses: it can't fire later.
    a.set_param('grounded', true);
    a.trigger('jump');
    w.steps(1);
    expect(a.state).toBe('land');
    expect(a.param('jump')).toBe(false);
  });

  it('set_param drives the blend: weights follow the param, walk and run share one phase', () => {
    const w = world(LOCOMOTION);
    const a = w.animator();
    a.set_param('speed', 4);
    w.steps(1);
    const samples = a.__playback__.layers[0]!.samples;
    expect(samples.map((s) => [s.clip, s.weight])).toEqual([['walk', 0.5], ['run', 0.5]]);
    // One cycle = 0.5·1 s + 0.5·0.5 s = 0.75 s; after 0.05 s both are 1/15 of the way through.
    expect(samples[0]!.time / LENGTHS['walk']!).toBeCloseTo(0.05 / 0.75);
    expect(samples[1]!.time / LENGTHS['run']!).toBeCloseTo(0.05 / 0.75);
  });

  it('crossfades as a weight stack: an interrupting transition keeps every weight continuous', () => {
    const w = world({
      params: { mode: 0 },
      layers: [{
        name: 'base',
        states: { a: { clip: 'idle' }, b: { clip: 'walk' }, c: { clip: 'run' } },
        transitions: [{ from: 'a', to: 'b', when: ['mode == 1'], fade: 0.5 }, { from: 'b', to: 'c', when: ['mode == 2'], fade: 0.5 }],
      }],
    });
    const a = w.animator();
    a.set_param('mode', 1);
    w.steps(1);
    w.steps(5);
    const before = a.__playback__.layers[0]!.samples.map((s) => [s.clip, s.weight]);
    expect(before[0]![0]).toBe('idle');
    expect(before[1]![1]).toBeCloseTo(0.5);
    a.set_param('mode', 2);
    w.steps(2);
    const after = a.__playback__.layers[0]!.samples;
    expect(after.map((s) => s.clip)).toEqual(['idle', 'walk', 'run']);
    expect(after.reduce((sum, s) => sum + s.weight, 0)).toBeCloseTo(1);
    w.steps(10);
    expect(a.__playback__.layers[0]!.samples.map((s) => [s.clip, s.weight])).toEqual([['run', 1]]);
  });

  it('fires markers at exact clip times, from the heaviest clip only', () => {
    const w = world(LOCOMOTION);
    const a = w.animator();
    a.set_param('speed', 2);
    w.steps(30);
    const steps = w.heard.filter((h) => h.event === 'animation_event');
    // walk (1 s) marks 0.5: crossed at 0.5, 1.5, 2.5 s of play (the first step plays 0–0.05).
    expect(steps.map((h) => [h.at, h.payload['name'], h.payload['clip'], h.payload['time']])).toEqual([
      [0.5, 'footstep', 'walk', 0.5], [1.5, 'footstep', 'walk', 0.5],
    ]);
    expect(steps[0]!.payload['entity']).toBe(w.id);
  });

  it('authored clip markers fire too, and play_once emits ClipFinished then resumes the loop', () => {
    const w = world({ default_clip: 'idle' });
    const a = w.animator();
    a.play('walk', { fade: 0 });
    a.play_once('clips/stomp');
    expect(a.clip).toBe('clips/stomp');
    w.steps(4);
    expect(w.heard.map((h) => [h.event, h.at])).toEqual([['animation_event', 0.2]]);
    w.steps(8);
    expect(w.heard.map((h) => [h.event, h.at])).toEqual([['animation_event', 0.2], ['clip_finished', 0.6]]);
    expect(w.heard[1]!.payload['clip']).toBe('clips/stomp');
    expect(a.clip).toBe('walk');
  });

  it('action layers: play_once over the base, then fade back to nothing', () => {
    const w = world(LOCOMOTION);
    const a = w.animator();
    expect(a.__playback__.layers[1]!.samples).toEqual([]);
    a.play_once('wave', { layer: 'upper', fade: 0.2 });
    w.steps(2);
    const upper = a.__playback__.layers[1]!;
    expect(upper.mask).toEqual(['Spine2']);
    expect(upper.samples.map((s) => s.clip)).toEqual(['wave']);
    expect(upper.samples[0]!.weight).toBeCloseTo(0.5);
    w.steps(38);
    expect(w.heard.some((h) => h.event === 'clip_finished')).toBe(true);
    w.steps(4);
    expect(a.__playback__.layers[1]!.samples).toEqual([]);
    expect(a.state_of('upper')).toBeNull();
  });

  it('layer weights fade; additive layers carry their weight', () => {
    const w = world(LOCOMOTION);
    const a = w.animator();
    expect(a.__playback__.layers[2]).toMatchObject({ additive: true, weight: 0.5 });
    a.set_layer_weight('breath', 1, { fade: 0.5 });
    w.steps(5);
    expect(a.__playback__.layers[2]!.weight).toBeCloseTo(0.75);
    w.steps(10);
    expect(a.__playback__.layers[2]!.weight).toBe(1);
    expect(code(() => a.set_layer_weight('breth', 1))).toBe('PP3771');
  });

  it('misuse is loud', () => {
    const w = world(LOCOMOTION);
    const a = w.animator();
    expect(code(() => a.play('run'))).toBe('PP3770');
    expect(code(() => a.set_param('sped', 1))).toBe('PP3761');
    expect(code(() => a.set_param('grounded', 1))).toBe('PP3769');
    expect(code(() => a.set_param('jump', true))).toBe('PP3769');
    expect(code(() => a.trigger('speed'))).toBe('PP3769');
    expect(code(() => a.reach('tail', new Vec3(0, 0, 0)))).toBe('PP3768');
    expect(code(() => world({ layers: [{ name: 'base', states: { a: { clip: 'idle', loop: 'yes' } } }] }))).toBe('PP3760');
    const bare = world({}, { clips: false });
    expect(code(() => bare.animator().play('walk'))).toBe('PP9005');
  });

  it('root motion moves the entity along its own facing, turning it', () => {
    const w = world({ default_clip: 'stride', root_motion: 'transform' });
    const t = w.kernel.world.require(w.id).transform;
    t.rotation = Quat.from_euler(new Vec3(0, 90, 0));
    w.steps(10);
    // 0.5 s of a 1.5 m/s stride, facing +x: 0.75 m along x; 10°/s of turn: 5°.
    expect(t.position.x).toBeCloseTo(0.75, 1);
    expect(t.position.z).toBeCloseTo(0, 1);
    expect(t.position.y).toBe(0);
    expect(t.rotation.to_euler().y).toBeCloseTo(95, 3);
    // Across the loop seam it keeps walking.
    w.steps(20);
    expect(t.position.x).toBeGreaterThan(2.2);
  });

  it('"character" root motion is collected for take_root_motion()', () => {
    const w = world({ default_clip: 'stride', root_motion: 'character' });
    w.steps(4);
    const taken = w.animator().take_root_motion();
    expect(taken.offset.z).toBeCloseTo(0.3);
    expect(taken.turn).toBeCloseTo(2);
    expect(w.animator().take_root_motion().offset.z).toBe(0);
    expect(w.kernel.world.require(w.id).transform.position.z).toBe(0);
  });

  it('IK goals and foot planting reach the renderer', () => {
    const w = world({ ...LOCOMOTION, ik: { feet: { speed_param: 'speed', grounded_param: 'grounded', fade: [1, 3] } } });
    const a = w.animator();
    a.reach('right_hand', new Vec3(1, 2, 3), { weight: 0.5 });
    a.look_at(new Vec3(0, 2, 5));
    a.set_param('speed', 2);
    const ik = a.__playback__.ik;
    expect(ik.reach).toEqual([{ limb: 'right_hand', bones: ['RightArm', 'RightForeArm', 'RightHand'], pole: [0, 0, -1], point: [1, 2, 3], entity: null, weight: 0.5 }]);
    expect(ik.look).toMatchObject({ bones: ['Head'], point: [0, 2, 5], weight: 1 });
    expect(ik.feet).toMatchObject({ weight: 0.5, maxDrop: 0.4 });
    a.set_param('grounded', false);
    expect(a.__playback__.ik.feet!.weight).toBe(0);
    a.reach('right_hand', null);
    expect(a.__playback__.ik.reach).toEqual([]);
  });

  it('snapshot and restore mid-blend replay exactly', () => {
    const w = world(LOCOMOTION);
    const a = w.animator();
    a.set_param('speed', 3);
    w.steps(7);
    a.set_param('grounded', false);
    a.play_once('wave', { layer: 'upper' });
    w.steps(1);
    const snap = w.kernel.snapshot();
    const heardAt = w.heard.length;
    const run = (): unknown => {
      w.steps(13);
      return [w.animator().__playback__, w.heard.slice(heardAt).map((h) => [h.event, h.at, h.payload['name']])];
    };
    const first = run();
    w.kernel.restore(snap);
    w.heard.splice(heardAt);
    expect(run()).toEqual(first);
  });
});
