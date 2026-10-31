/**
 * Animators in game time: every frame before the game's `update` (a plugin system) each
 * animator advances its layers — state machines take transitions on their params, blend
 * states weigh their clips, play()/play_once() crossfade, markers fire `AnimationEvent`,
 * finished one-shots fire `ClipFinished`, and the base layer's root motion moves the
 * entity. What to draw is `animator.__playback__` (an `AnimatorPlayback`): per layer, the
 * clips at their times and weights, masks, and the IK goals; render3d turns it into a
 * pose. Nothing here needs a GPU, so it is deterministic, snapshot-able and headless.
 *
 * Clip facts (lengths, authored markers, the root bone's track) come from the
 * `animation_clips` service (the models plugin). Crossfades are weight stacks: the newest entry of
 * a layer rises to 1 over its fade while the others shrink in proportion, so a transition
 * interrupting a transition never pops.
 */

import { closestMatch, fail, Quat, Vec3 } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import { componentEntity } from '../../kernel/index.js';
import type { EntityRecord, EventDef, Fields, Kernel } from '../../kernel/index.js';
import { modelScaleOf } from '../../../resource/index.js';
import { ANIMATION_CLIPS_SERVICE } from '../../services/index.js';
import type { AnimationClipSource, ClipInfo, ClipMarker, RootSample } from '../../services/index.js';
import { bind, bool, describe, finite, nonNegative, storedRef } from './args.js';
import { blendWeights, conditionHolds, limbOf, readAnimatorGraph } from './animation_graph.js';
import type { AnimatorGraph, LayerDef, StateDef } from './animation_graph.js';
import { crossedMarkers, rootTravel, TIME_EPSILON } from './animation_timeline.js';
import { ANIMATOR } from './animator.js';
import type { RootMotionMode } from './animator.js';

export const CLIP_FINISHED: EventDef = { id: 'clip_finished', target: 'entity' };
export const ANIMATION_EVENT: EventDef = { id: 'animation_event', target: 'entity' };

// ── What renderers read ───────────────────────────────────────────────────────

/** One clip at a time and weight. Times are unwrapped clip seconds (renderers wrap loops). */
export interface PlaybackSample {
  readonly clip: string;
  readonly time: number;
  readonly loop: boolean;
  readonly weight: number;
}

export interface PlaybackLayer {
  readonly name: string;
  /** The layer's own weight (0–1). */
  readonly weight: number;
  readonly additive: boolean;
  readonly mask: readonly string[] | null;
  /** Weights sum to at most 1: the rest of the layer is "nothing playing" (rest pose, or the layers below). */
  readonly samples: readonly PlaybackSample[];
}

/** An IK goal: a world point, or an entity's position each frame. */
export interface PlaybackGoal {
  readonly point: readonly [number, number, number] | null;
  readonly entity: EntityId | null;
  readonly weight: number;
  /** Reach goals: the end bone's world rotation (x, y, z, w), relative to the rig's bind pose as the model faces; null: none. */
  readonly rotation?: readonly [number, number, number, number] | null;
  /** Reach goals: take the goal entity's world rotation each frame. */
  readonly orient?: boolean;
}

/** A morph target override (`set_morph`): driven toward `value` by `weight`. */
export interface PlaybackMorph {
  readonly name: string;
  readonly value: number;
  readonly weight: number;
}

export interface PlaybackLimb {
  readonly bones: readonly [string, string, string];
  readonly pole: readonly [number, number, number];
}

export interface PlaybackIk {
  readonly reach: readonly (PlaybackLimb & PlaybackGoal & { readonly limb: string })[];
  readonly look: (PlaybackGoal & { readonly bones: readonly string[]; readonly maxAngle: number }) | null;
  readonly feet: {
    readonly limbs: readonly PlaybackLimb[];
    readonly maxDrop: number;
    readonly maxStep: number;
    readonly ground: readonly string[];
    /** Planting strength now (grounded, speed fade). */
    readonly weight: number;
  } | null;
}

/** `animator.__playback__`: everything a renderer needs to pose the model this frame. */
export interface AnimatorPlayback {
  /** Bottom to top; layers[0] is the base. */
  readonly layers: readonly PlaybackLayer[];
  /** Morph target overrides over the clips' weights, in the order they were set. */
  readonly morphs: readonly PlaybackMorph[];
  readonly rootMotion: RootMotionMode;
  readonly rootBone: string | null;
  readonly ik: PlaybackIk;
}

// ── Saved state (JSON) ────────────────────────────────────────────────────────

interface Entry {
  readonly kind: 'none' | 'clip' | 'state';
  /** Clip ref (clip), state name (state), '' (none). */
  readonly name: string;
  readonly loop: boolean;
  /** Clip entries' own rate (play(speed=); replaying the clip at another speed changes it in place). */
  speed: number;
  readonly once: boolean;
  /** Clip seconds; a blend state's normalized phase (cycles). */
  time: number;
  prev: number;
  weight: number;
  started: boolean;
}

interface LayerRun {
  entries: Entry[];
  /** Seconds the newest entry takes to reach full weight. */
  fade: number;
  /** A state machine layer's current state. */
  state: string | null;
  /** The looping clip a play_once on a clip-driven layer returns to (null: nothing). */
  resume: { readonly clip: string; readonly speed: number } | null;
  /** The fade back after a play_once. */
  backFade: number;
  weight: number;
  weightTarget: number;
  /** Per second; 0: the weight is at its target. */
  weightRate: number;
}

interface Goal {
  point: [number, number, number] | null;
  entity: number | null;
  weight: number;
  rotation?: [number, number, number, number] | null;
  orient?: boolean;
}

/** A morph override in game time: its weight eases to `target` (1 while set, 0 once released) at `rate` per second. */
interface MorphRun {
  value: number;
  weight: number;
  target: number;
  rate: number;
}

interface AnimatorRun {
  params: Record<string, number | boolean>;
  layers: LayerRun[];
  /** World-space root travel collected for take_root_motion() ("character" mode). */
  taken: { x: number; y: number; z: number; yaw: number };
  reach: Record<string, Goal>;
  look: Goal | null;
  /** Morph target overrides by target name (`set_morph`). */
  morphs?: Record<string, MorphRun>;
}

export interface SavedAnimator { readonly id: number; readonly run: AnimatorRun }

export interface AnimatorOptions {
  /** A clip's stored ref → what game code sees (`ClipRef`). */
  readonly presentClip?: (clip: string) => unknown;
  /** Root motion as game code sees it (`RootMotion`). */
  readonly presentRootMotion?: (offset: Vec3, turn: number) => unknown;
}

const MAX_ENTRIES = 8;
const NONE: Omit<Entry, 'weight'> = { kind: 'none', name: '', loop: true, speed: 1, once: false, time: 0, prev: 0, started: true };

function entry(kind: Entry['kind'], name: string, options: { loop?: boolean; speed?: number; once?: boolean } = {}): Entry {
  return {
    kind, name, loop: options.loop ?? true, speed: options.speed ?? 1, once: options.once ?? false, time: 0, prev: 0, weight: 1,
    started: false,
  };
}

function freshRun(graph: AnimatorGraph): AnimatorRun {
  const params: Record<string, number | boolean> = {};
  for (const p of graph.params.values()) params[p.name] = p.initial;
  const layers = graph.layers.map((def, i): LayerRun => {
    let first: Entry = { ...NONE, weight: 1 };
    if (def.entry !== null) first = entry('state', def.entry, { loop: def.states.get(def.entry)!.loop });
    else if (i === 0 && graph.defaultClip !== null) first = entry('clip', graph.defaultClip);
    return {
      entries: [first], fade: 0, state: def.entry, resume: null, backFade: 0, weight: def.weight, weightTarget: def.weight, weightRate: 0,
    };
  });
  return { params, layers, taken: { x: 0, y: 0, z: 0, yaw: 0 }, reach: {}, look: null, morphs: {} };
}

/** One clip's step this frame. */
interface Step {
  readonly clip: string;
  readonly prev: number;
  readonly time: number;
  readonly loop: boolean;
  readonly weight: number;
  readonly duration: number;
  readonly fromStart: boolean;
  readonly markers: readonly ClipMarker[];
}

function nameOf(record: EntityRecord): string {
  return `"${record.placedId ?? record.prefab ?? record.id}"`;
}

function graphKey(fields: Fields): string {
  return JSON.stringify([fields['default_clip'] ?? null, fields['params'], fields['layers'], fields['events'], fields['ik']]);
}

export class Animators {
  readonly #kernelOf: () => Kernel;
  readonly #options: AnimatorOptions;
  readonly #runs = new Map<EntityId, AnimatorRun>();
  readonly #graphs = new Map<EntityId, AnimatorGraph>();
  /** Compiled graphs by their data: a crowd sharing a prefab shares one. */
  readonly #compiled = new Map<string, AnimatorGraph>();

  constructor(kernel: () => Kernel, options: AnimatorOptions) {
    this.#kernelOf = kernel;
    this.#options = options;
  }

  #kernel(): Kernel {
    return this.#kernelOf();
  }

  #clips(): AnimationClipSource {
    return this.#kernel().service(ANIMATION_CLIPS_SERVICE);
  }

  /** The entity's graph, read (and checked: the first problem is raised) when it arrives. */
  #compile(record: EntityRecord, fields: Fields): AnimatorGraph {
    const key = graphKey(fields);
    const known = this.#compiled.get(key);
    if (known !== undefined) return known;
    const { graph, problems } = readAnimatorGraph({ ...fields });
    if (graph === undefined) {
      const p = problems[0]!;
      const more = problems.length > 1 ? ` (and ${problems.length - 1} more problem${problems.length > 2 ? 's' : ''}; \`parallax check\` lists them)` : '';
      fail(p.code, `The animator of ${nameOf(record)}: ${p.message} (at animator${p.pointer})${more}`, p.fix !== undefined ? { fix: p.fix } : {});
    }
    this.#compiled.set(key, graph);
    return graph;
  }

  added(records: readonly EntityRecord[]): void {
    for (const record of records) {
      const fields = record.components.get(ANIMATOR);
      if (fields === undefined || this.#runs.has(record.id)) continue;
      const graph = this.#compile(record, fields);
      this.#graphs.set(record.id, graph);
      this.#runs.set(record.id, freshRun(graph));
    }
  }

  removed(records: readonly EntityRecord[]): void {
    for (const record of records) {
      this.#runs.delete(record.id);
      this.#graphs.delete(record.id);
    }
  }

  changed(record: EntityRecord): void {
    if (!record.components.has(ANIMATOR)) this.removed([record]);
    else this.added([record]);
  }

  clear(): void {
    this.#runs.clear();
    this.#graphs.clear();
  }

  // ── Clip facts ──────────────────────────────────────────────────────────────

  #info(id: EntityId, clip: string): ClipInfo | null {
    const info = this.#clips().clip(id, clip);
    if (info === undefined) {
      const record = this.#kernel().world.peek(id);
      fail('PP3772', `The animator of ${record === undefined ? 'an entity' : nameOf(record)} needs the clip "${clip}" before its model has loaded`, {
        fix: 'Boot awaits render3d\'s whenLoaded() before starting; a model only code spawns must be preloaded (it is, when a prefab names it).',
      });
    }
    return info;
  }

  #duration(id: EntityId, clip: string): number {
    return this.#info(id, clip)?.duration ?? 0;
  }

  #markers(id: EntityId, graph: AnimatorGraph, clip: string): readonly ClipMarker[] {
    const own = this.#info(id, clip)?.markers ?? [];
    const extra = graph.events.get(clip) ?? [];
    if (extra.length === 0) return own;
    if (own.length === 0) return extra;
    return [...own, ...extra].sort((a, b) => a.time - b.time);
  }

  /** A blend state's weights now and its cycle length (the weighted durations, each at its speed). */
  #blend(id: EntityId, run: AnimatorRun, state: StateDef): { weights: number[]; durations: number[]; cycle: number } {
    if (state.motion.kind !== 'blend') return { weights: [1], durations: [this.#duration(id, state.motion.clip)], cycle: 0 };
    const points = state.motion.points;
    const weights = blendWeights(points, state.motion.params.map((p) => run.params[p] as number));
    const durations = points.map((p) => this.#duration(id, p.clip));
    let cycle = 0;
    points.forEach((p, i) => { if (p.speed > 0) cycle += weights[i]! * durations[i]! / p.speed; });
    return { weights, durations, cycle };
  }

  /** Normalized time of an entry (cycles; loops keep counting). One with no frames is done. */
  #normalized(id: EntityId, run: AnimatorRun, layer: LayerDef, e: Entry, time: number): number {
    if (e.kind === 'none') return 1;
    const state = e.kind === 'state' ? layer.states.get(e.name)! : null;
    if (state !== null && state.motion.kind === 'blend') return this.#blend(id, run, state).cycle > 0 ? time : 1;
    const clip = state === null ? e.name : (state.motion as { clip: string }).clip;
    const d = this.#duration(id, clip);
    return d > 0 ? time / d : 1;
  }

  // ── Stepping ────────────────────────────────────────────────────────────────

  /** Advance one entry by `dt` scaled seconds; returns its clips' steps. */
  #advance(id: EntityId, graph: AnimatorGraph, layer: LayerDef, run: AnimatorRun, e: Entry, dt: number): Step[] {
    if (e.kind === 'none') return [];
    const fromStart = !e.started;
    e.started = true;
    e.prev = e.time;
    if (e.kind === 'clip') {
      const d = this.#duration(id, e.name);
      e.time += dt * e.speed;
      if (!e.loop) e.time = Math.min(e.time, d);
      return [{ clip: e.name, prev: e.prev, time: e.time, loop: e.loop, weight: e.weight, duration: d, fromStart, markers: this.#markers(id, graph, e.name) }];
    }
    const state = layer.states.get(e.name)!;
    const rate = dt * state.speed * (state.speedParam === null ? 1 : Math.max(0, run.params[state.speedParam] as number));
    if (state.motion.kind === 'clip') {
      const clip = state.motion.clip;
      const d = this.#duration(id, clip);
      e.time += rate;
      if (!state.loop) e.time = Math.min(e.time, d);
      return [{ clip, prev: e.prev, time: e.time, loop: state.loop, weight: e.weight, duration: d, fromStart, markers: this.#markers(id, graph, clip) }];
    }
    // A blend shares one phase, so feet stay in step as walk blends into run.
    const { weights, durations, cycle } = this.#blend(id, run, state);
    if (cycle > 0) e.time += rate / cycle;
    if (!state.loop) e.time = Math.min(e.time, 1);
    return state.motion.points.flatMap((p, i) => (weights[i]! <= 0 ? [] : [{
      clip: p.clip, prev: e.prev * durations[i]!, time: e.time * durations[i]!, loop: state.loop, weight: e.weight * weights[i]!,
      duration: durations[i]!, fromStart, markers: this.#markers(id, graph, p.clip),
    }]));
  }

  /** The newest entry rises toward 1 over the layer's fade; the others share what is left. */
  #fade(lr: LayerRun, dt: number): void {
    const target = lr.entries[lr.entries.length - 1]!;
    target.weight = lr.fade <= 0 ? 1 : Math.min(1, target.weight + dt / lr.fade);
    const others = lr.entries.slice(0, -1);
    const rest = others.reduce((sum, e) => sum + e.weight, 0);
    if (rest > 0) for (const e of others) e.weight *= (1 - target.weight) / rest;
    lr.entries = [...others.filter((e) => e.weight > 1e-4), target];
    if (lr.entries.length === 1) target.weight = 1;
  }

  #push(lr: LayerRun, next: Entry, fade: number): void {
    next.weight = fade > 0 ? 0 : 1;
    lr.entries = fade > 0 ? [...lr.entries, next] : [next];
    lr.fade = fade;
    while (lr.entries.length > MAX_ENTRIES) {
      const dropped = lr.entries.shift()!;
      lr.entries[0]!.weight += dropped.weight;
    }
  }

  advance(dt: number): void {
    const kernel = this.#kernel();
    for (const [id, run] of this.#runs) {
      const record = kernel.world.get(id);
      const fields = record?.components.get(ANIMATOR);
      if (record === undefined || fields === undefined) continue;
      const graph = this.#graphs.get(id)!;
      const scaled = dt * (fields['speed'] as number);
      let baseSteps: Step[] = [];
      graph.layers.forEach((layer, i) => {
        const lr = run.layers[i]!;
        if (lr.weightRate > 0) {
          const delta = lr.weightRate * dt;
          lr.weight = Math.abs(lr.weightTarget - lr.weight) <= delta ? lr.weightTarget : lr.weight + Math.sign(lr.weightTarget - lr.weight) * delta;
          if (lr.weight === lr.weightTarget) lr.weightRate = 0;
        }
        const steps = lr.entries.flatMap((e) => this.#advance(id, graph, layer, run, e, scaled));
        if (i === 0) baseSteps = steps;
        this.#fire(id, lr, steps);
        this.#fade(lr, dt);
        this.#finishOnce(id, run, layer, lr);
        this.#transition(id, run, layer, lr);
      });
      for (const p of graph.params.values()) if (p.kind === 'trigger') run.params[p.name] = false;
      for (const [name, m] of Object.entries(run.morphs ?? {})) {
        if (m.weight !== m.target) {
          const delta = m.rate * dt;
          m.weight = m.rate <= 0 || Math.abs(m.target - m.weight) <= delta ? m.target : m.weight + Math.sign(m.target - m.weight) * delta;
        }
        if (m.target === 0 && m.weight === 0) delete run.morphs![name];
      }
      const mode = fields['root_motion'] as RootMotionMode;
      if (mode !== 'off') this.#rootMotion(record, run, fields, mode, baseSteps);
    }
  }

  /** Markers of the layer's dominant clip (the heaviest) that this step crossed. */
  #fire(id: EntityId, lr: LayerRun, steps: readonly Step[]): void {
    if (lr.weight <= 0 || steps.length === 0) return;
    let top = steps[0]!;
    for (const s of steps) if (s.weight > top.weight) top = s;
    const crossed = crossedMarkers(top.markers, top.prev, top.time, top.duration, top.loop, top.fromStart);
    if (crossed.length === 0) return;
    const kernel = this.#kernel();
    const entity = kernel.handles.wrap(id);
    for (const m of crossed) kernel.emit(ANIMATION_EVENT, { entity, name: m.name, clip: this.#present(top.clip), time: m.time });
  }

  #finishOnce(id: EntityId, run: AnimatorRun, layer: LayerDef, lr: LayerRun): void {
    const target = lr.entries[lr.entries.length - 1]!;
    if (!target.once || this.#normalized(id, run, layer, target, target.time) + TIME_EPSILON < 1) return;
    if (layer.states.size > 0) this.#push(lr, entry('state', lr.state!, { loop: layer.states.get(lr.state!)!.loop }), lr.backFade);
    else if (lr.resume !== null) this.#push(lr, entry('clip', lr.resume.clip, { speed: lr.resume.speed }), lr.backFade);
    else this.#push(lr, { ...NONE, weight: 0 }, lr.backFade);
    lr.resume = null;
    this.#kernel().emit(CLIP_FINISHED, { entity: this.#kernel().handles.wrap(id), clip: this.#present(target.name) });
  }

  #transition(id: EntityId, run: AnimatorRun, layer: LayerDef, lr: LayerRun): void {
    const target = lr.entries[lr.entries.length - 1]!;
    if (layer.states.size === 0 || target.once || target.kind !== 'state') return;
    const current = lr.state!;
    for (const t of layer.transitions) {
      if (t.from !== null ? t.from !== current : t.to === current) continue;
      if (!t.when.every((c) => conditionHolds(c, run.params[c.param]!))) continue;
      if (t.exit !== null && !this.#exitReached(id, run, layer, target, t.exit)) continue;
      // A trigger is used up by the transition it fires.
      for (const c of t.when) if (this.#isTrigger(id, c.param)) run.params[c.param] = false;
      lr.state = t.to;
      this.#push(lr, entry('state', t.to, { loop: layer.states.get(t.to)!.loop }), t.fade);
      return;
    }
  }

  #isTrigger(id: EntityId, param: string): boolean {
    return this.#graphs.get(id)!.params.get(param)?.kind === 'trigger';
  }

  /** A one-shot reached `exit` of its length; a loop passed `exit` of a cycle this step (or sits past it). */
  #exitReached(id: EntityId, run: AnimatorRun, layer: LayerDef, e: Entry, exit: number): boolean {
    const now = this.#normalized(id, run, layer, e, e.time) + TIME_EPSILON;
    const state = layer.states.get(e.name)!;
    if (!state.loop) return Math.min(now, 1) >= exit;
    const before = this.#normalized(id, run, layer, e, e.prev) + TIME_EPSILON;
    if (Math.floor(now - exit) > Math.floor(before - exit)) return true;
    return exit < 1 && now - Math.floor(now) >= exit;
  }

  #rootMotion(record: EntityRecord, run: AnimatorRun, fields: Fields, mode: RootMotionMode, steps: readonly Step[]): void {
    const clips = this.#clips();
    const bone = fields['root_bone'] as string | null;
    let x = 0;
    let z = 0;
    let yaw = 0;
    for (const s of steps) {
      if (s.weight <= 0) continue;
      let missing = false;
      const sample = (time: number): RootSample => {
        const at = clips.root(record.id, s.clip, time, bone);
        if (at === undefined) this.#info(record.id, s.clip);
        if (at === null || at === undefined) {
          missing = true;
          return { x: 0, y: 0, z: 0, yaw: 0 };
        }
        return at;
      };
      const travel = rootTravel(sample, s.prev, s.time, s.duration, s.loop);
      if (missing) continue;
      x += travel.x * s.weight;
      z += travel.z * s.weight;
      yaw += travel.yaw * s.weight;
    }
    if (x === 0 && z === 0 && yaw === 0) return;
    const t = record.transform;
    const scale = t.worldScale();
    // A Model drawn at `scale` travels that much farther (the clip is in the model's own meters).
    const model = record.components.get('model');
    const k = model === undefined ? 1 : modelScaleOf(model, `${record.placedId ?? record.prefab ?? record.id} model`);
    // Horizontal travel and heading: the root bone keeps its own height (bob, crouch) in the pose.
    const world = t.worldRotation().rotate(new Vec3(x * scale.x * k, 0, z * scale.z * k));
    if (mode === 'transform') {
      t.setWorldPosition(t.worldPosition().__add__(world));
      if (yaw !== 0) t.rotation = t.rotation.__mul__(Quat.from_euler(new Vec3(0, yaw, 0)));
    } else {
      run.taken.x += world.x;
      run.taken.y += world.y;
      run.taken.z += world.z;
      run.taken.yaw += yaw;
    }
  }

  // ── Game-facing ─────────────────────────────────────────────────────────────

  #present(clip: string): unknown {
    return this.#options.presentClip?.(clip) ?? clip;
  }

  #run(fields: Fields): { id: EntityId; run: AnimatorRun; graph: AnimatorGraph } {
    const id = componentEntity(fields);
    const run = this.#runs.get(id);
    if (run === undefined) fail('PP3733', 'This animator is not in the world', { fix: 'Use animators of live entities.' });
    return { id, run, graph: this.#graphs.get(id)! };
  }

  #layer(graph: AnimatorGraph, name: unknown, where: string): number {
    const index = graph.layers.findIndex((l) => l.name === name);
    if (index >= 0) return index;
    const known = graph.layers.map((l) => l.name);
    const guess = typeof name === 'string' ? closestMatch(name, known) : undefined;
    return fail('PP3771', `${where}: this animator has no layer ${describe(name)}`, {
      fix: guess !== undefined ? `Did you mean "${guess}"?` : `Its layers: ${known.join(', ')}.`,
    });
  }

  #param(graph: AnimatorGraph, name: unknown, where: string): string {
    if (typeof name === 'string' && graph.params.has(name)) return name;
    const known = [...graph.params.keys()];
    const guess = typeof name === 'string' ? closestMatch(name, known) : undefined;
    return fail('PP3761', `${where}: this animator declares no param ${describe(name)}`, {
      fix: guess !== undefined ? `Did you mean "${guess}"?`
        : `Declare it in the prefab's animator: "params": {${JSON.stringify(typeof name === 'string' ? name : 'name')}: 0}.`,
    });
  }

  #goal(target: unknown, weight: unknown, where: string): Goal | null {
    if (target === null || target === undefined) return null;
    const w = finite(weight ?? 1, `${where} weight`);
    if (w < 0 || w > 1) fail('PP3700', `${where} weight is ${w}; it must be from 0 to 1`);
    if (target instanceof Vec3) return { point: [target.x, target.y, target.z], entity: null, weight: w };
    const kernel = this.#kernel();
    const id = kernel.handles.unwrap(target);
    if (id === undefined || kernel.world.get(id) === undefined) {
      fail('PP3700', `${where} target must be a Vec3, a live Entity or None, got ${describe(target)}`);
    }
    return { point: null, entity: id, weight: w };
  }

  /** The clip a layer's newest entry shows (a blend: its heaviest clip). */
  #shown(id: EntityId, run: AnimatorRun, layer: LayerDef, lr: LayerRun): string | null {
    const e = lr.entries[lr.entries.length - 1]!;
    if (e.kind === 'none') return null;
    if (e.kind === 'clip') return e.name;
    const state = layer.states.get(e.name)!;
    if (state.motion.kind === 'clip') return state.motion.clip;
    const { weights } = this.#blend(id, run, state);
    let best = 0;
    weights.forEach((w, i) => { if (w > weights[best]!) best = i; });
    return state.motion.points[best]!.clip;
  }

  #playback(id: EntityId, run: AnimatorRun, graph: AnimatorGraph, fields: Fields): AnimatorPlayback {
    const layers = graph.layers.map((layer, i): PlaybackLayer => {
      const lr = run.layers[i]!;
      const samples: PlaybackSample[] = [];
      for (const e of lr.entries) {
        if (e.kind === 'none' || e.weight <= 0) continue;
        if (e.kind === 'clip') {
          samples.push({ clip: e.name, time: e.time, loop: e.loop, weight: e.weight });
          continue;
        }
        const state = layer.states.get(e.name)!;
        if (state.motion.kind === 'clip') {
          samples.push({ clip: state.motion.clip, time: e.time, loop: state.loop, weight: e.weight });
          continue;
        }
        const { weights, durations } = this.#blend(id, run, state);
        state.motion.points.forEach((p, k) => {
          if (weights[k]! > 0) samples.push({ clip: p.clip, time: e.time * durations[k]!, loop: state.loop, weight: e.weight * weights[k]! });
        });
      }
      return { name: layer.name, weight: lr.weight, additive: layer.additive, mask: layer.mask, samples };
    });
    const reach = Object.entries(run.reach).map(([limb, goal]) => {
      const def = limbOf(graph, limb)!;
      return {
        limb, bones: def.bones, pole: def.pole, point: goal.point, entity: goal.entity as EntityId | null, weight: goal.weight,
        ...(goal.rotation !== undefined && goal.rotation !== null && { rotation: goal.rotation }),
        ...(goal.orient === true && { orient: true }),
      };
    });
    const lookDef = graph.ik.look ?? { bones: ['Head'], maxAngle: 70 };
    const look = run.look === null ? null
      : { bones: lookDef.bones, maxAngle: lookDef.maxAngle, point: run.look.point, entity: run.look.entity as EntityId | null, weight: run.look.weight };
    const feetDef = graph.ik.feet;
    let feet: PlaybackIk['feet'] = null;
    if (feetDef !== null) {
      let weight = 1;
      if (feetDef.groundedParam !== null && run.params[feetDef.groundedParam] !== true) weight = 0;
      if (feetDef.speedParam !== null) {
        const speed = run.params[feetDef.speedParam] as number;
        const [full, off] = feetDef.fade;
        weight *= speed <= full ? 1 : speed >= off ? 0 : (off - speed) / (off - full);
      }
      feet = {
        limbs: feetDef.limbs.map((name) => { const l = limbOf(graph, name)!; return { bones: l.bones, pole: l.pole }; }),
        maxDrop: feetDef.maxDrop, maxStep: feetDef.maxStep, ground: feetDef.ground, weight,
      };
    }
    const morphs = Object.entries(run.morphs ?? {}).map(([name, m]) => ({ name, value: m.value, weight: m.weight }));
    return {
      layers, morphs, rootMotion: fields['root_motion'] as RootMotionMode, rootBone: fields['root_bone'] as string | null,
      ik: { reach, look, feet },
    };
  }

  methods(): object {
    const animators = this;
    return {
      get __playback__(): AnimatorPlayback {
        const fields = this as unknown as Fields;
        const { id, run, graph } = animators.#run(fields);
        return animators.#playback(id, run, graph, fields);
      },
      get clip(): unknown {
        const { id, run, graph } = animators.#run(this as unknown as Fields);
        const clip = animators.#shown(id, run, graph.layers[0]!, run.layers[0]!);
        return clip === null ? null : animators.#present(clip);
      },
      get state(): string | null {
        return animators.#run(this as unknown as Fields).run.layers[0]!.state;
      },
      state_of(this: Fields, ...args: unknown[]): string | null {
        const a = bind('state_of', args, ['layer'], [], ['layer']);
        const { run, graph } = animators.#run(this);
        return run.layers[animators.#layer(graph, a['layer'], 'state_of()')]!.state;
      },
      play(this: Fields, ...args: unknown[]): void {
        const a = bind('play', args, ['clip'], ['fade', 'loop', 'speed', 'layer'], ['clip']);
        const clip = storedRef(a['clip'], 'play clip');
        const fade = nonNegative(a['fade'] ?? 0.2, 'play fade');
        const loop = bool(a['loop'] ?? true, 'play loop');
        const speed = nonNegative(a['speed'] ?? 1, 'play speed');
        const { id, run, graph } = animators.#run(this);
        const index = animators.#layer(graph, a['layer'] ?? graph.layers[0]!.name, 'play()');
        const layer = graph.layers[index]!;
        if (layer.states.size > 0) {
          fail('PP3770', `play(): the layer "${layer.name}" runs a state machine`, {
            fix: 'Drive it with set_param()/trigger(), interrupt it with play_once(), or play loops on a layer without states.',
          });
        }
        animators.#info(id, clip);
        const lr = run.layers[index]!;
        const target = lr.entries[lr.entries.length - 1]!;
        // Playing the current clip is a no-op (while no play_once interrupts it); at another
        // speed it changes the rate in place, keeping its phase (stride-matched locomotion).
        if (!target.once && target.kind === 'clip' && target.name === clip && target.loop === loop) {
          target.speed = speed;
          return;
        }
        lr.resume = null;
        animators.#push(lr, entry('clip', clip, { loop, speed }), fade);
      },
      play_once(this: Fields, ...args: unknown[]): void {
        const a = bind('play_once', args, ['clip'], ['fade', 'speed', 'layer'], ['clip']);
        const clip = storedRef(a['clip'], 'play_once clip');
        const fade = nonNegative(a['fade'] ?? 0.1, 'play_once fade');
        const speed = nonNegative(a['speed'] ?? 1, 'play_once speed');
        const { id, run, graph } = animators.#run(this);
        const index = animators.#layer(graph, a['layer'] ?? graph.layers[0]!.name, 'play_once()');
        animators.#info(id, clip);
        const lr = run.layers[index]!;
        const target = lr.entries[lr.entries.length - 1]!;
        if (graph.layers[index]!.states.size === 0 && !target.once) {
          lr.resume = target.kind === 'clip' && target.loop ? { clip: target.name, speed: target.speed } : null;
        }
        lr.backFade = fade;
        animators.#push(lr, entry('clip', clip, { loop: false, speed, once: true }), fade);
      },
      stop(this: Fields, ...args: unknown[]): void {
        const a = bind('stop', args, [], ['layer', 'fade']);
        const fade = nonNegative(a['fade'] ?? 0.2, 'stop fade');
        const { run, graph } = animators.#run(this);
        const index = animators.#layer(graph, a['layer'] ?? graph.layers[0]!.name, 'stop()');
        if (graph.layers[index]!.states.size > 0) {
          fail('PP3770', `stop(): the layer "${graph.layers[index]!.name}" runs a state machine`, { fix: 'Fade it out with set_layer_weight(layer, 0, fade=...).' });
        }
        const lr = run.layers[index]!;
        lr.resume = null;
        if (lr.entries[lr.entries.length - 1]!.kind !== 'none') animators.#push(lr, { ...NONE, weight: 0 }, fade);
      },
      set_param(this: Fields, ...args: unknown[]): void {
        const a = bind('set_param', args, ['name', 'value'], [], ['name', 'value']);
        const { run, graph } = animators.#run(this);
        const name = animators.#param(graph, a['name'], 'set_param()');
        const def = graph.params.get(name)!;
        const value = a['value'];
        if (def.kind === 'trigger') fail('PP3769', `set_param("${name}"): "${name}" is a trigger`, { fix: `Call trigger("${name}").` });
        if (def.kind === 'bool') {
          if (typeof value !== 'boolean') fail('PP3769', `set_param("${name}") takes True or False, got ${describe(value)}`);
          run.params[name] = value;
          return;
        }
        if (typeof value === 'boolean') fail('PP3769', `set_param("${name}") takes a number, got ${describe(value)}`);
        run.params[name] = finite(value, `set_param("${name}") value`);
      },
      trigger(this: Fields, ...args: unknown[]): void {
        const a = bind('trigger', args, ['name'], [], ['name']);
        const { run, graph } = animators.#run(this);
        const name = animators.#param(graph, a['name'], 'trigger()');
        if (graph.params.get(name)!.kind !== 'trigger') {
          fail('PP3769', `trigger("${name}"): "${name}" is a ${graph.params.get(name)!.kind} param`, { fix: `Declare it "${name}": "trigger", or call set_param().` });
        }
        run.params[name] = true;
      },
      has_param(this: Fields, ...args: unknown[]): boolean {
        const a = bind('has_param', args, ['name', 'kind'], [], ['name']);
        const kind = a['kind'] ?? null;
        if (kind !== null && kind !== 'number' && kind !== 'bool' && kind !== 'trigger') {
          fail('PP3769', `has_param() kind must be "number", "bool", "trigger" or None, got ${describe(kind)}`);
        }
        if (typeof a['name'] !== 'string') fail('PP3769', `has_param() name must be a string, got ${describe(a['name'])}`);
        const def = animators.#run(this).graph.params.get(a['name']);
        return def !== undefined && (kind === null || def.kind === kind);
      },
      param(this: Fields, ...args: unknown[]): number | boolean {
        const a = bind('param', args, ['name'], [], ['name']);
        const { run, graph } = animators.#run(this);
        return run.params[animators.#param(graph, a['name'], 'param()')]!;
      },
      set_layer_weight(this: Fields, ...args: unknown[]): void {
        const a = bind('set_layer_weight', args, ['layer', 'weight'], ['fade'], ['layer', 'weight']);
        const { run, graph } = animators.#run(this);
        const lr = run.layers[animators.#layer(graph, a['layer'], 'set_layer_weight()')]!;
        const weight = finite(a['weight'], 'set_layer_weight weight');
        if (weight < 0 || weight > 1) fail('PP3700', `set_layer_weight weight is ${weight}; it must be from 0 to 1`);
        const fade = nonNegative(a['fade'] ?? 0, 'set_layer_weight fade');
        lr.weightTarget = weight;
        if (fade === 0 || weight === lr.weight) {
          lr.weight = weight;
          lr.weightRate = 0;
        } else {
          lr.weightRate = Math.abs(weight - lr.weight) / fade;
        }
      },
      set_morph(this: Fields, ...args: unknown[]): void {
        const a = bind('set_morph', args, ['target', 'value'], ['fade'], ['target']);
        const name = a['target'];
        if (typeof name !== 'string' || name === '') fail('PP3700', `set_morph(): the target must be a morph target name, got ${describe(name)}`);
        const fade = nonNegative(a['fade'] ?? 0, 'set_morph fade');
        const { run } = animators.#run(this);
        const morphs = (run.morphs ??= {});
        const value = a['value'];
        const known = morphs[name];
        if (value === null || value === undefined) {
          // Released: back to what the clips give, over the fade.
          if (known === undefined) return;
          known.target = 0;
          known.rate = fade > 0 ? known.weight / fade : 0;
          if (fade === 0) delete morphs[name];
          return;
        }
        const v = finite(value, 'set_morph value');
        const weight = known?.weight ?? (fade > 0 ? 0 : 1);
        morphs[name] = { value: v, weight, target: 1, rate: fade > 0 ? (1 - weight) / fade : 0 };
        if (fade === 0) morphs[name]!.weight = 1;
      },
      reach(this: Fields, ...args: unknown[]): void {
        const a = bind('reach', args, ['limb', 'target'], ['weight', 'rotation'], ['limb']);
        const { run, graph } = animators.#run(this);
        const limb = a['limb'];
        if (typeof limb !== 'string' || limbOf(graph, limb) === undefined) {
          const known = [...new Set([...graph.ik.limbs.keys(), 'left_hand', 'right_hand', 'left_foot', 'right_foot'])];
          const guess = typeof limb === 'string' ? closestMatch(limb, known) : undefined;
          fail('PP3768', `reach(): there is no limb ${describe(limb)}`, { fix: guess !== undefined ? `Did you mean "${guess}"?` : `Limbs: ${known.join(', ')}.` });
        }
        const goal = animators.#goal(a['target'], a['weight'], 'reach()');
        const rotation = a['rotation'];
        if (goal !== null && rotation !== undefined && rotation !== null && rotation !== false) {
          if (rotation instanceof Quat) goal.rotation = [rotation.x, rotation.y, rotation.z, rotation.w];
          else if (rotation === true && goal.entity !== null) goal.orient = true;
          else fail('PP3700', `reach() rotation must be a Quat, True (the target entity's rotation) or None, got ${describe(rotation)}`);
        }
        if (goal === null) delete run.reach[limb];
        else run.reach[limb] = goal;
      },
      look_at(this: Fields, ...args: unknown[]): void {
        const a = bind('look_at', args, ['target'], ['weight'], []);
        animators.#run(this).run.look = animators.#goal(a['target'], a['weight'], 'look_at()');
      },
      take_root_motion(this: Fields, ...args: unknown[]): unknown {
        bind('take_root_motion', args, []);
        const { run } = animators.#run(this);
        const offset = new Vec3(run.taken.x, run.taken.y, run.taken.z);
        const turn = run.taken.yaw;
        run.taken = { x: 0, y: 0, z: 0, yaw: 0 };
        return animators.#options.presentRootMotion?.(offset, turn) ?? { offset, turn };
      },
    };
  }

  snapshot(): SavedAnimator[] {
    return [...this.#runs].map(([id, run]) => ({ id, run: structuredClone(run) }));
  }

  restore(saved: readonly SavedAnimator[]): void {
    this.clear();
    this.added([...this.#kernel().world.live()]);
    for (const s of saved) {
      if (this.#runs.has(s.id as EntityId)) this.#runs.set(s.id as EntityId, structuredClone(s.run));
    }
  }
}
