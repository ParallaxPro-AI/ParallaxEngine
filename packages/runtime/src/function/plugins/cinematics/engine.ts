/**
 * The cinematic player: at most one cinematic runs at a time. It advances in the plugin's
 * `update` system (before the game's systems, by game time — a paused game pauses it), so
 * the frame's systems, the camera rigs (the 'ui' hook) and the renderers all see the
 * sampled values. A cinematic with a `time_scale` track runs on real time instead (it sets
 * the game's time scale; slow motion must not slow the shot down).
 *
 *   play     binds every name the tracks use (bind names first, then placed ids in the
 *            running scene; all must resolve, PP7212), captures each target's starting
 *            values, takes the camera (its rig is set to "fixed" while it plays), applies
 *            t = 0 and raises `cinematic_started` plus the triggers at 0.
 *   update   advances by dt: triggers with prev < t <= now fire once each, in time order
 *            (markers, animation clips, sounds, shakes, spawns, effects); every track
 *            samples at now (the camera last, framing this frame's poses); a waiting
 *            dialogue line holds playback at its time until `advance`; reaching
 *            `duration` ends it.
 *   skip     fires the markers not yet fired (`skipped=True`) and what makes the end state
 *            (each animation track's last clip, the last music change, despawns and kept
 *            spawns — not one-shot sounds, shakes or effects), applies every track's value
 *            at `duration` exactly, then ends.
 *   end      restores the tracks marked `restore`, puts the presentation back (grade off,
 *            the game's time scale, the camera's depth of field), removes what it spawned
 *            unless kept, hands the camera back (rig and fov; a "fixed" camera also gets its
 *            pose back) and raises `cinematic_ended`.
 *
 * Letterbox, subtitle and dialogue are presentation only: `presentation()` samples them for
 * the cinematic panel (the api's CinematicPanel) — nothing in the world changes.
 *
 * A scene load drops a running cinematic (its entities are gone): `cinematic_ended` with
 * `skipped=True`, nothing applied (the grade and time scale are put back). Then cinematics
 * listing the new scene in `scenes` play. Trigger volumes (`cinematic_trigger`) fire when an
 * entity with their `activator` tag comes within `radius`, while nothing plays;
 * `occupied`/`fired` live on the component.
 *
 * Snapshot: the running cinematic's id, time, bound entities, starting values, the
 * camera's handback state, the last seen positions of aim targets, the dialogue hold, what
 * it spawned and the real-time clock — a restore resumes on the same frame-exact path.
 */

import { Color, fail, Quat, Vec2, Vec3 } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import type { Json, JsonObject } from '../../../resource/index.js';
import { decode, encode } from '../../kernel/index.js';
import type { EntityRecord, EventDef, FieldSpec, Kernel } from '../../kernel/index.js';
import { ACTIONS_SERVICE, AUDIO_SERVICE, CAMERAS_SERVICE, ENVIRONMENT_SERVICE, TERRAIN_SERVICE } from '../../services/index.js';
import {
  CINEMATIC, dialogueAt, DUE, holdTimes, lerpColor, lerpNumber, lerpVec2, lerpVec3, parseCinematic, sample, slerp, subtitleAt,
  targetNames,
} from './timeline.js';
import type { Aim, AnimationKey, AudioKey, CameraKey, ChannelKey, Cinematic, FocusKey, ShakeKey, SpawnKey, Track, VfxKey } from './timeline.js';

export const CINEMATIC_TRIGGER = 'cinematic_trigger';
const CAMERA = 'camera';
/** The visuals plugin's depth-of-field component (a camera's), read and written by id. */
export const DEPTH_OF_FIELD = 'depth_of_field';
const ANIMATOR = 'animator';
const SPRITE = 'sprite';

export const CINEMATIC_EVENTS = {
  started: { id: 'cinematic_started' },
  ended: { id: 'cinematic_ended' },
  marker: { id: 'cinematic_marker' },
} as const satisfies Record<string, EventDef>;

/** Field kinds a property track can drive; the rest of a schema (entities, lists, refs) can't be keyed. */
export const ANIMATABLE_KINDS: ReadonlySet<string> = new Set(['number', 'int', 'bool', 'color', 'vec2', 'vec3', 'string', 'enum']);
const STEP_KINDS: ReadonlySet<string> = new Set(['bool', 'string', 'enum']);

/** A focus track's start when the camera has no DepthOfField: the old engine's defaults. */
/** Meters a cinematic camera is held above the terrain under it. */
export const CAMERA_GROUND_CLEARANCE = 1.5;
const FOCUS_RANGE = 4;
const FOCUS_BLUR = 6;

export interface VfxOptions {
  readonly color: Color | null;
  readonly scale: number;
  readonly direction: Vec3 | null;
}

/** What the api supplies: the game-facing content ref of a cinematic (event payloads, `current`) and the effects. */
export interface CinematicsHost {
  ref(kernel: Kernel, id: string): unknown;
  /** A one-shot effect (`ctx.vfx.play`); absent: a cinematic with a vfx track can't play (PP7220). */
  vfx?(kernel: Kernel, effect: string, at: Vec3, options: VfxOptions): void;
}

/** The cinematic panel's view of the running cinematic (`presentation()`). */
export interface Presentation {
  /** 0 (no bars) .. 1 (full cinematic bars). */
  readonly letterbox: number;
  readonly subtitle: string | null;
  readonly dialogue: {
    readonly text: string;
    readonly speaker: string | null;
    readonly portrait: string | null;
    /** Playback holds on this line until the player advances. */
    readonly awaiting: boolean;
  } | null;
  readonly skippable: boolean;
}

interface Pose {
  readonly position: Vec3;
  readonly rotation: Quat;
}

interface CameraHandback {
  readonly entity: EntityId;
  readonly rig: string;
  readonly fov: number;
  /** Local pose, put back when the rig was "fixed". */
  readonly local: Pose;
}

interface Focus {
  readonly distance: number;
  readonly range: number;
  readonly blur: number;
  /** The cinematic added the camera's DepthOfField (removed at the end). */
  readonly added: boolean;
}

type Bound =
  | { readonly type: 'camera'; readonly track: Track & { type: 'camera' }; readonly entity: EntityId; readonly start: Pose & { readonly fov: number } }
  | { readonly type: 'transform'; readonly track: Track & { type: 'transform' }; readonly entity: EntityId; readonly start: Pose & { readonly scale: Vec3 } }
  | { readonly type: 'visibility'; readonly track: Track & { type: 'visibility' }; readonly entity: EntityId; readonly start: boolean }
  | {
    readonly type: 'property'; readonly track: Track & { type: 'property' }; readonly entity: EntityId; readonly spec: FieldSpec;
    readonly keys: readonly ChannelKey<unknown>[]; readonly start: unknown;
  }
  | { readonly type: 'animation'; readonly track: Track & { type: 'animation' }; readonly entity: EntityId }
  | { readonly type: 'time_scale'; readonly track: Track & { type: 'time_scale' }; readonly start: number }
  | { readonly type: 'shake'; readonly track: Track & { type: 'shake' }; readonly camera: EntityId }
  | { readonly type: 'focus'; readonly track: Track & { type: 'focus' }; readonly camera: EntityId; readonly start: Focus }
  | { readonly type: 'event' | 'audio' | 'letterbox' | 'grade' | 'subtitle' | 'spawn' | 'vfx' | 'dialogue'; readonly track: Track };

interface Spawned {
  readonly entity: EntityId;
  readonly keep: boolean;
  readonly name: string | null;
}

interface Run {
  readonly cinematic: Cinematic;
  elapsed: number;
  readonly names: ReadonlyMap<string, EntityId>;
  readonly tracks: readonly Bound[];
  readonly camera: CameraHandback | null;
  /** Aim targets' last world positions, held if one is destroyed mid-cinematic. */
  readonly lastSeen: Map<string, Vec3>;
  /** Waiting dialogue lines' times; `nextHold` is the first not yet advanced past. */
  readonly holds: readonly number[];
  nextHold: number;
  awaiting: boolean;
  readonly spawned: Spawned[];
  /** 'real' with a time_scale track: the cinematic runs on real time. */
  readonly clock: 'game' | 'real';
  lastReal: number;
}

export interface SavedRun {
  readonly id: string;
  readonly elapsed: number;
  readonly names: ReadonlyArray<readonly [string, number]>;
  readonly starts: readonly Json[];
  readonly camera: { entity: number; rig: string; fov: number; position: number[]; rotation: number[] } | null;
  readonly lastSeen: ReadonlyArray<readonly [string, readonly number[]]>;
  readonly nextHold?: number;
  readonly awaiting?: boolean;
  readonly spawned?: ReadonlyArray<readonly [number, boolean, string | null]>;
  readonly lastReal?: number;
}

const v3 = (v: Vec3): number[] => [v.x, v.y, v.z];
const q4 = (q: Quat): number[] => [q.x, q.y, q.z, q.w];
const toV3 = (a: readonly number[]): Vec3 => new Vec3(a[0]!, a[1]!, a[2]!);
const toQ = (a: readonly number[]): Quat => new Quat(a[0]!, a[1]!, a[2]!, a[3]!);
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

function worldPose(record: EntityRecord): Pose {
  return { position: record.transform.worldPosition(), rotation: record.transform.worldRotation() };
}

function setWorldPose(record: EntityRecord, pose: Pose): void {
  const node = record.transform;
  node.setWorldPosition(pose.position);
  node.rotation = node.parent === null ? pose.rotation : node.parent.worldRotation().inverse().__mul__(pose.rotation);
}

function mixer(kind: string): (a: unknown, b: unknown, u: number) => unknown {
  switch (kind) {
    case 'number': return (a, b, u) => lerpNumber(a as number, b as number, u);
    case 'int': return (a, b, u) => Math.round(lerpNumber(a as number, b as number, u));
    case 'color': return (a, b, u) => lerpColor(a as Color, b as Color, u);
    case 'vec2': return (a, b, u) => lerpVec2(a as Vec2, b as Vec2, u);
    case 'vec3': return (a, b, u) => lerpVec3(a as Vec3, b as Vec3, u);
    default: return (a) => a;
  }
}

/** One trigger key due in a window, with the track it came from. */
type Due =
  | { readonly t: number; readonly order: number; readonly kind: 'event'; readonly name: string }
  | { readonly t: number; readonly order: number; readonly kind: 'animation'; readonly entity: EntityId; readonly key: AnimationKey }
  | { readonly t: number; readonly order: number; readonly kind: 'audio'; readonly key: AudioKey }
  | { readonly t: number; readonly order: number; readonly kind: 'shake'; readonly camera: EntityId; readonly key: ShakeKey }
  | { readonly t: number; readonly order: number; readonly kind: 'spawn'; readonly key: SpawnKey }
  | { readonly t: number; readonly order: number; readonly kind: 'vfx'; readonly key: VfxKey };

export class CinematicsEngine {
  readonly kernel: Kernel;
  readonly #host: CinematicsHost;
  readonly #skipAction: unknown;
  readonly #advanceAction: unknown;
  readonly #cinematics = new Map<string, Cinematic>();
  #run: Run | null = null;

  constructor(kernel: Kernel, host: CinematicsHost, skipAction: unknown, advanceAction?: unknown) {
    this.kernel = kernel;
    this.#host = host;
    this.#skipAction = skipAction;
    this.#advanceAction = advanceAction;
    const byScene = new Map<string, string>();
    for (const entry of kernel.project.content.get(CINEMATIC)?.values() ?? []) {
      const { cinematic, diagnostics } = parseCinematic(entry.id, entry.values, entry.path);
      if (cinematic === undefined) {
        const d = diagnostics[0]!;
        fail(d.code, d.message, { ...(d.path !== undefined && { path: d.path }), ...(d.pointer !== undefined && { pointer: d.pointer }), ...(d.fix !== undefined && { fix: d.fix }) });
      }
      for (const scene of cinematic.scenes) {
        const other = byScene.get(scene);
        if (other !== undefined) {
          fail('PP7217', `Cinematics "${other}" and "${entry.id}" both play when scene "${scene}" loads`, {
            path: entry.path, fix: 'One cinematic plays at a time: list the scene in one of them and chain the other from its end (a CinematicEnded handler).',
          });
        }
        byScene.set(scene, entry.id);
      }
      this.#cinematics.set(entry.id, cinematic);
    }
  }

  get playing(): boolean {
    return this.#run !== null;
  }

  /** The running cinematic's id, or null. */
  get current(): string | null {
    return this.#run?.cinematic.id ?? null;
  }

  /** Seconds into the running cinematic (0 when none plays). */
  get time(): number {
    return this.#run?.elapsed ?? 0;
  }

  /** Playback is held on a dialogue line until `advance()`. */
  get awaiting(): boolean {
    return this.#run?.awaiting ?? false;
  }

  cinematic(id: string): Cinematic {
    const c = this.#cinematics.get(id);
    if (c === undefined) {
      fail('PP7211', `No cinematic "${id}"`, { fix: `Add content/cinematic/${id}.json. Known: ${[...this.#cinematics.keys()].join(', ') || '(none)'}.` });
    }
    return c;
  }

  // ── Commands ───────────────────────────────────────────────────────────────

  play(id: string, bindings: ReadonlyMap<string, EntityId>): void {
    const c = this.cinematic(id);
    if (this.#run !== null) {
      fail('PP7210', `play("${id}") while cinematic "${this.#run.cinematic.id}" is playing`, {
        fix: 'Check ctx.cinematics.playing, chain from CinematicEnded, or skip() the running one first.',
      });
    }
    for (const name of bindings.keys()) {
      if (!c.bind.includes(name)) {
        fail('PP7213', `play("${id}", bind=...) gives "${name}", which the cinematic doesn't bind`, {
          fix: c.bind.length > 0 ? `It binds: ${c.bind.join(', ')}.` : `Declare it: "bind": ["${name}"] in content/cinematic/${id}.json.`,
        });
      }
    }
    for (const name of c.bind) {
      if (!bindings.has(name)) fail('PP7213', `play("${id}") needs bind={"${name}": entity}`, { fix: `The cinematic binds: ${c.bind.join(', ')}.` });
      if (!this.kernel.world.isAlive(bindings.get(name)!)) fail('PP7213', `play("${id}"): bind "${name}" is a destroyed entity`);
    }
    const names = new Map(bindings);
    for (const { name } of targetNames(c)) {
      if (names.has(name)) continue;
      const found = this.#placed(name);
      if (found === undefined) {
        fail('PP7212', `Cinematic "${id}" targets "${name}": no bind name and no placed entity "${name}" in this scene`, {
          fix: 'Give it in play(bind={...}) (and "bind" in the cinematic), or place an entity with that id in the scene.',
        });
      }
      names.set(name, found);
    }
    this.#checkPlayable(c);
    const cameraTrack = c.tracks.find((t) => t.type === 'camera');
    let camera: CameraHandback | null = null;
    let cameraEntity: EntityId | undefined;
    if (cameraTrack !== undefined) {
      cameraEntity = this.#directed(c, cameraTrack.camera, names, undefined);
      const record = this.kernel.world.get(cameraEntity)!;
      const fields = record.components.get(CAMERA)!;
      camera = {
        entity: record.id, rig: fields['rig'] as string, fov: fields['fov'] as number,
        local: { position: record.transform.position, rotation: record.transform.rotation },
      };
    }
    const tracks = c.tracks.map((track) => this.#bind(c, track, names, cameraEntity, undefined));
    this.#run = {
      cinematic: c, elapsed: 0, names, tracks, camera, lastSeen: new Map(), holds: holdTimes(c), nextHold: 0, awaiting: false,
      spawned: [], clock: c.tracks.some((t) => t.type === 'time_scale') ? 'real' : 'game', lastReal: this.kernel.time.realNow,
    };
    const run = this.#run;
    if (camera !== null) this.kernel.world.get(camera.entity)!.components.get(CAMERA)!['rig'] = 'fixed';
    this.kernel.emit(CINEMATIC_EVENTS.started, { cinematic: this.#host.ref(this.kernel, id) });
    this.#fire(-Infinity, 0, false);
    if (run.holds[0] !== undefined && run.holds[0] <= DUE) run.awaiting = true;
    this.#apply(0);
  }

  /** End the running cinematic at its end state. False when none plays. */
  skip(): boolean {
    const run = this.#run;
    if (run === null) return false;
    run.awaiting = false;
    run.nextHold = run.holds.length;
    this.#fire(run.elapsed, Infinity, true);
    run.elapsed = run.cinematic.duration;
    this.#apply(run.cinematic.duration);
    this.#end(true);
    return true;
  }

  /** Go past the dialogue line playback is held on. False when nothing waits. */
  advance(): boolean {
    const run = this.#run;
    if (run === null || !run.awaiting) return false;
    run.awaiting = false;
    run.nextHold++;
    return true;
  }

  /** The letterbox, subtitle and dialogue line now, for the cinematic panel; null when none plays. */
  presentation(): Presentation | null {
    const run = this.#run;
    if (run === null) return null;
    let letterbox = 0;
    let subtitle: string | null = null;
    let dialogue: Presentation['dialogue'] = null;
    for (const { track } of run.tracks) {
      if (track.type === 'letterbox') letterbox = clamp01(sample(track.keys, 0, run.elapsed, lerpNumber));
      else if (track.type === 'subtitle') subtitle = subtitleAt(track.keys, run.elapsed);
      else if (track.type === 'dialogue') {
        const line = dialogueAt(track.keys, run.elapsed);
        if (line !== null) dialogue = { text: line.text, speaker: line.speaker, portrait: line.portrait, awaiting: run.awaiting };
      }
    }
    return { letterbox, subtitle, dialogue, skippable: run.cinematic.skippable };
  }

  // ── The frame ──────────────────────────────────────────────────────────────

  update(dt: number): void {
    const run = this.#run;
    if (run !== null) {
      const pressed = (action: unknown): boolean => action !== undefined && this.kernel.service(ACTIONS_SERVICE).pressed(action, 0, null);
      if (run.cinematic.skippable && pressed(this.#skipAction)) {
        this.skip();
      } else {
        if (run.awaiting && pressed(this.#advanceAction)) this.advance();
        const step = this.#clock(run, dt);
        if (run.awaiting) {
          // Held on a line: the shot keeps following what moves.
          this.#apply(run.elapsed);
        } else {
          const from = run.elapsed;
          let to = Math.min(run.cinematic.duration, from + step);
          const hold = run.holds[run.nextHold];
          const held = hold !== undefined && hold <= to + DUE;
          if (held) to = Math.max(from, hold);
          this.#fire(from, to, false);
          run.elapsed = to;
          if (held) run.awaiting = true;
          this.#apply(to);
          if (!run.awaiting && to >= run.cinematic.duration - DUE) this.#end(false);
        }
      }
    }
    this.#triggers();
  }

  /** Seconds the cinematic advances this frame: game time, or real time while it owns the time scale. */
  #clock(run: Run, dt: number): number {
    if (run.clock === 'game') return dt;
    const time = this.kernel.time;
    // dt is real time × the scale the track set last frame; at a freeze (scale 0) count real seconds.
    const real = time.scale > 1e-6 ? dt / time.scale : Math.min(0.25, Math.max(0, time.realNow - run.lastReal));
    run.lastReal = time.realNow;
    return real;
  }

  /** The scene's entities are gone: drop the running cinematic without applying anything. */
  sceneLoading(): void {
    const run = this.#run;
    if (run === null) return;
    this.#run = null;
    this.#resetGlobals(run);
    this.kernel.emit(CINEMATIC_EVENTS.ended, { cinematic: this.#host.ref(this.kernel, run.cinematic.id), skipped: true });
  }

  sceneLoaded(scene: string): void {
    for (const c of this.#cinematics.values()) {
      if (!c.scenes.includes(scene)) continue;
      if (c.bind.length > 0) {
        fail('PP7213', `Cinematic "${c.id}" plays when scene "${scene}" loads but binds ${c.bind.join(', ')}`, {
          fix: 'A scene-load cinematic has no one to bind: target placed ids, or play it from code with bind=.',
        });
      }
      this.play(c.id, new Map());
    }
  }

  #triggers(): void {
    const world = this.kernel.world;
    const triggers = world.query([CINEMATIC_TRIGGER]);
    if (triggers.length === 0) return;
    for (const row of triggers) {
      const id = row[0];
      const fields = row[1]!;
      const tag = tagOf(fields['activator']);
      const at = world.get(id)!.transform.worldPosition();
      const radius = fields['radius'] as number;
      let inside: EntityId | undefined;
      for (const record of world.live()) {
        if (record.id === id || !record.tags.has(tag)) continue;
        if (record.transform.worldPosition().distance_to(at) <= radius) { inside = record.id; break; }
      }
      const wasOccupied = fields['occupied'] === true;
      fields['occupied'] = inside !== undefined;
      if (inside === undefined || wasOccupied || this.#run !== null) continue;
      if (fields['once'] === true && fields['fired'] === true) continue;
      const cinematic = refId(fields['cinematic']);
      const c = this.cinematic(cinematic);
      const extra = c.bind.filter((n) => n !== 'activator');
      if (extra.length > 0) {
        fail('PP7213', `A cinematic_trigger plays "${cinematic}", which binds ${extra.join(', ')}`, {
          fix: 'A trigger binds only "activator" (the entity that walked in); target placed ids for the rest.',
        });
      }
      fields['fired'] = true;
      this.play(cinematic, c.bind.includes('activator') ? new Map([['activator', inside]]) : new Map());
    }
  }

  // ── Tracks ─────────────────────────────────────────────────────────────────

  #placed(name: string): EntityId | undefined {
    for (const record of this.kernel.world.live()) if (record.placedId === name) return record.id;
    return undefined;
  }

  /** What a cinematic needs from the game besides its targets, checked before anything starts. */
  #checkPlayable(c: Cinematic): void {
    for (const track of c.tracks) {
      if (track.type === 'spawn') {
        for (const k of track.keys) {
          if (k.kind === 'spawn' && !this.kernel.project.prefabs.has(k.prefab)) {
            fail('PP7219', `Cinematic "${c.id}" spawns "${k.prefab}", which is no prefab`, { fix: `Add prefabs/${k.prefab}.prefab.json, or fix the name.` });
          }
        }
      } else if (track.type === 'vfx' && this.#host.vfx === undefined) {
        fail('PP7220', `Cinematic "${c.id}" plays effects, but this game draws none`, { fix: 'Effects come from the renderers (createRuntime includes them).' });
      } else if (track.type === 'focus' && this.kernel.registry.components.get(DEPTH_OF_FIELD) === undefined) {
        fail('PP7221', `Cinematic "${c.id}" pulls focus, but this game has no depth_of_field component`, { fix: 'Depth of field is the visuals plugin\'s (createRuntime includes it).' });
      }
    }
  }

  /**
   * The camera a track directs: its `camera` name, else the camera track's, else the one
   * seat 0 is looking through, else the world's first. PP7215 when it has no Camera.
   */
  #directed(c: Cinematic, name: string | null, names: ReadonlyMap<string, EntityId>, cameraTrackEntity: EntityId | undefined): EntityId {
    const entity = name !== null
      ? names.get(name)
      : cameraTrackEntity ?? this.kernel.tryService(CAMERAS_SERVICE)?.active(0) ?? this.kernel.world.query([CAMERA])[0]?.[0];
    const record = entity === undefined ? undefined : this.kernel.world.get(entity);
    if (record === undefined || !record.components.has(CAMERA)) {
      fail('PP7215', `Cinematic "${c.id}" directs a camera, but ${name === null ? 'the world has no camera' : `"${name}" has no Camera`}`, {
        fix: 'Place a camera entity (or name one with "camera" in the track).',
      });
    }
    return record.id;
  }

  /** Bind a track to its entity, capturing (or, from a snapshot, decoding) its starting values. */
  #bind(c: Cinematic, track: Track, names: ReadonlyMap<string, EntityId>, camera: EntityId | undefined, saved: Json | undefined): Bound {
    const world = this.kernel.world;
    const s = saved as JsonObject | undefined;
    switch (track.type) {
      case 'camera': {
        const entity = camera!;
        const record = world.get(entity)!;
        const pose = s === undefined ? worldPose(record) : { position: toV3(s['position'] as number[]), rotation: toQ(s['rotation'] as number[]) };
        const fov = s === undefined ? record.components.get(CAMERA)!['fov'] as number : s['fov'] as number;
        return { type: 'camera', track, entity, start: { ...pose, fov } };
      }
      case 'transform': {
        const entity = names.get(track.target)!;
        const t = world.get(entity)?.transform;
        const start = s === undefined
          ? { position: t!.position, rotation: t!.rotation, scale: t!.scale }
          : { position: toV3(s['position'] as number[]), rotation: toQ(s['rotation'] as number[]), scale: toV3(s['scale'] as number[]) };
        return { type: 'transform', track, entity, start };
      }
      case 'visibility': {
        const entity = names.get(track.target)!;
        return { type: 'visibility', track, entity, start: s === undefined ? world.get(entity)?.visible ?? true : (saved as boolean) };
      }
      case 'property': {
        const entity = names.get(track.target)!;
        const where = `cinematic "${c.id}" property "${track.component}.${track.field}"`;
        const def = this.kernel.registry.components.get(track.component);
        if (def === undefined) fail('PP7214', `${where}: there is no component "${track.component}"`);
        const spec = def.schema[track.field];
        if (spec === undefined) {
          fail('PP7214', `${where}: "${track.component}" has no field "${track.field}"`, { fix: `Fields: ${Object.keys(def.schema).join(', ')}.` });
        }
        if (!ANIMATABLE_KINDS.has(spec.type.kind)) {
          fail('PP7214', `${where}: a ${spec.type.kind} field can't be keyed`, { fix: 'Key number, int, bool, color, vec2, vec3, text or choice fields.' });
        }
        const fields = world.get(entity)?.components.get(track.component);
        if (s === undefined && fields === undefined) {
          fail('PP7214', `${where}: "${track.target}" has no ${track.component} component`, { fix: `Add "${track.component}" to it, or key another entity.` });
        }
        const keys = track.keys.map((k, i) => ({ t: k.t, ease: k.ease, cut: k.cut, value: decode(spec.type, k.value, `${where} key ${i}`) }));
        const start = saved === undefined ? fields![track.field] : decode(spec.type, saved, `${where} (saved start)`);
        return { type: 'property', track, entity, spec, keys, start };
      }
      case 'animation': {
        const entity = names.get(track.target)!;
        const components = world.get(entity)?.components;
        if (s === undefined && components?.has(ANIMATOR) !== true && components?.has(SPRITE) !== true) {
          fail('PP7218', `Cinematic "${c.id}" plays clips on "${track.target}", which has no Animator (3D) or Sprite (2D)`, {
            fix: `Give "${track.target}" an animator (a Model with clips) or a sprite with "animations", or key another entity.`,
          });
        }
        return { type: 'animation', track, entity };
      }
      case 'time_scale':
        return { type: 'time_scale', track, start: s === undefined ? this.kernel.time.scale : (saved as number) };
      case 'shake':
        return { type: 'shake', track, camera: s === undefined ? this.#directed(c, track.camera, names, camera) : s['camera'] as EntityId };
      case 'focus': {
        if (s !== undefined) {
          return {
            type: 'focus', track, camera: s['camera'] as EntityId,
            start: { distance: s['distance'] as number, range: s['range'] as number, blur: s['blur'] as number, added: s['added'] === true },
          };
        }
        const entity = this.#directed(c, track.camera, names, camera);
        const dof = world.get(entity)!.components.get(DEPTH_OF_FIELD);
        if (dof !== undefined) {
          return {
            type: 'focus', track, camera: entity,
            start: { distance: dof['focus_distance'] as number, range: dof['focus_range'] as number, blur: dof['max_blur'] as number, added: false },
          };
        }
        const distance = track.keys.find((k) => k.distance !== undefined)?.distance ?? 10;
        const start = { distance, range: FOCUS_RANGE, blur: FOCUS_BLUR, added: true };
        this.kernel.addComponent(entity, DEPTH_OF_FIELD, { focus_distance: distance, focus_range: FOCUS_RANGE, max_blur: FOCUS_BLUR });
        return { type: 'focus', track, camera: entity, start };
      }
      default:
        return { type: track.type, track };
    }
  }

  /** Trigger keys with from < t <= to, in time order (then authored order). A skip keeps what makes the end state. */
  #fire(from: number, to: number, skipped: boolean): void {
    const run = this.#run!;
    const due: Due[] = [];
    let order = 0;
    const inWindow = (t: number): boolean => t > from + DUE && t <= to + DUE;
    for (const bound of run.tracks) {
      const track = bound.track;
      switch (track.type) {
        case 'event':
          for (const k of track.keys) { if (inWindow(k.t)) due.push({ t: k.t, order, kind: 'event', name: k.name }); order++; }
          break;
        case 'animation': {
          const keys = track.keys.filter((k) => inWindow(k.t));
          const entity = (bound as { entity: EntityId }).entity;
          for (const k of skipped ? keys.slice(-1) : keys) due.push({ t: k.t, order: order++, kind: 'animation', entity, key: k });
          break;
        }
        case 'audio': {
          const keys = track.keys.filter((k) => inWindow(k.t));
          const music = keys.filter((k) => k.kind === 'music');
          for (const k of skipped ? music.slice(-1) : keys) due.push({ t: k.t, order: order++, kind: 'audio', key: k });
          break;
        }
        case 'shake':
          if (skipped) break;
          for (const k of track.keys) if (inWindow(k.t)) due.push({ t: k.t, order: order++, kind: 'shake', camera: (bound as { camera: EntityId }).camera, key: k });
          break;
        case 'spawn':
          for (const k of track.keys) {
            if (inWindow(k.t) && (!skipped || k.kind === 'despawn' || k.keep)) due.push({ t: k.t, order: order++, kind: 'spawn', key: k });
          }
          break;
        case 'vfx':
          if (skipped) break;
          for (const k of track.keys) if (inWindow(k.t)) due.push({ t: k.t, order: order++, kind: 'vfx', key: k });
          break;
        default:
          break;
      }
    }
    if (due.length === 0) return;
    due.sort((a, b) => a.t - b.t || a.order - b.order);
    const ref = this.#host.ref(this.kernel, run.cinematic.id);
    for (const d of due) {
      switch (d.kind) {
        case 'event': this.kernel.emit(CINEMATIC_EVENTS.marker, { cinematic: ref, name: d.name, time: d.t, skipped }); break;
        case 'animation': this.#animate(d.entity, d.key); break;
        case 'audio': this.#sound(d.key); break;
        case 'shake': {
          const camera = this.kernel.world.get(d.camera)?.components.get(CAMERA) as { shake?: (...a: unknown[]) => void } | undefined;
          camera?.shake?.(d.key.intensity, d.key.seconds);
          break;
        }
        case 'spawn': this.#spawn(run, d.key); break;
        case 'vfx':
          this.#host.vfx!(this.kernel, d.key.effect, this.#aim(d.key.at), { color: d.key.color, scale: d.key.scale, direction: d.key.direction });
          break;
      }
    }
  }

  #animate(entity: EntityId, k: AnimationKey): void {
    const components = this.kernel.world.get(entity)?.components;
    if (components === undefined) return;
    type Player = { play?: (...a: unknown[]) => void; play_once?: (...a: unknown[]) => void };
    const animator = components.get(ANIMATOR) as Player | undefined;
    if (animator !== undefined) {
      const options = { speed: k.speed, ...(k.fade !== undefined && { fade: k.fade }) };
      if (k.loop) animator.play?.(k.clip, { ...options, loop: true });
      else animator.play_once?.(k.clip, options);
      return;
    }
    (components.get(SPRITE) as Player | undefined)?.play?.(k.clip, { restart: true });
  }

  #sound(k: AudioKey): void {
    const audio = this.kernel.service(AUDIO_SERVICE);
    if (k.kind === 'music') {
      audio.music?.(k.music, k.fade);
      return;
    }
    audio.play({ sound: k.sound, at: k.at === null ? null : this.#aim(k.at), volume: k.volume, pitch: k.pitch, duck: k.duck });
  }

  #spawn(run: Run, k: SpawnKey): void {
    const kernel = this.kernel;
    if (k.kind === 'despawn') {
      const own = [...run.spawned].reverse().find((s) => s.name === k.despawn && kernel.world.isAlive(s.entity));
      const entity = own?.entity ?? run.names.get(k.despawn);
      if (entity !== undefined && kernel.world.isAlive(entity)) kernel.destroy(entity);
      return;
    }
    const record = kernel.spawn(k.prefab, {
      ...(k.position !== null && { at: v3(k.position) }),
      ...(k.rotation !== null && { rotation: v3(k.rotation) }),
    }, k.name !== null ? { name: k.name } : {});
    run.spawned.push({ entity: record.id, keep: k.keep, name: k.name });
  }

  /**
   * A camera key under the terrain shows the world from below: backfaces culled, nothing but
   * fog and the undersides of props. Hold the camera CAMERA_GROUND_CLEARANCE above the ground
   * (outside holes: a shot down a tunnel mouth stays where it was put).
   */
  #aboveGround(position: Vec3): Vec3 {
    const field = this.kernel.tryService(TERRAIN_SERVICE)?.current() ?? null;
    if (field === null || !field.contains(position.x, position.z) || field.holeAt(position.x, position.z)) return position;
    const floor = field.heightAt(position.x, position.z) + CAMERA_GROUND_CLEARANCE;
    if (position.y >= floor) return position;
    return new Vec3(position.x, floor, position.z);
  }

  /** Where a name is now (aim targets, relative_to), held at its last place once it is destroyed. */
  #position(name: string): Vec3 {
    const run = this.#run!;
    const record = this.kernel.world.get(run.names.get(name)!);
    if (record === undefined) return run.lastSeen.get(name) ?? Vec3.ZERO;
    const p = record.transform.worldPosition();
    run.lastSeen.set(name, p);
    return p;
  }

  #aim(aim: Aim): Vec3 {
    return 'point' in aim ? aim.point : this.#position(aim.target);
  }

  #orientation(k: CameraKey, position: Vec3): Quat | undefined {
    if (k.rotation !== undefined) return Quat.from_euler(k.rotation);
    if (k.lookAt === undefined) return undefined;
    const forward = this.#aim(k.lookAt).__sub__(position);
    return forward.length() < 1e-9 ? undefined : Quat.look_rotation(forward);
  }

  #apply(time: number): void {
    const run = this.#run!;
    const world = this.kernel.world;
    // The camera last, so it frames this frame's poses of what it follows and looks at.
    const ordered = [...run.tracks.filter((b) => b.type !== 'camera'), ...run.tracks.filter((b) => b.type === 'camera')];
    for (const bound of ordered) {
      switch (bound.type) {
        case 'grade': {
          const track = bound.track as Track & { type: 'grade' };
          this.kernel.service(ENVIRONMENT_SERVICE).grade?.(track.post, clamp01(sample(track.keys, 0, time, lerpNumber)));
          continue;
        }
        case 'time_scale':
          this.kernel.time.scale = Math.max(0, sample(bound.track.keys, bound.start, time, lerpNumber));
          continue;
        case 'focus': {
          const dof = world.get(bound.camera)?.components.get(DEPTH_OF_FIELD);
          if (dof === undefined) continue;
          const keys = bound.track.keys;
          const channel = (pick: (k: FocusKey) => number | undefined): ChannelKey<number>[] =>
            keys.flatMap((k) => { const v = pick(k); return v === undefined ? [] : [{ t: k.t, ease: k.ease, cut: k.cut, value: v }]; });
          dof['focus_distance'] = sample(channel((k) => k.distance), bound.start.distance, time, lerpNumber);
          dof['focus_range'] = sample(channel((k) => k.range), bound.start.range, time, lerpNumber);
          dof['max_blur'] = sample(channel((k) => k.blur), bound.start.blur, time, lerpNumber);
          continue;
        }
        case 'camera':
        case 'transform':
        case 'visibility':
        case 'property':
          break;
        default:
          continue; // Triggers and presentation: nothing in the world to sample.
      }
      const record = world.get(bound.entity);
      if (record === undefined) continue; // Destroyed mid-cinematic: nothing left to animate.
      switch (bound.type) {
        case 'camera': {
          const keys = bound.track.keys;
          const positions = keys.flatMap((k) => (k.position === undefined ? [] : [{
            t: k.t, ease: k.ease, cut: k.cut, value: k.relativeTo === undefined ? k.position : this.#position(k.relativeTo).__add__(k.position),
          }]));
          const position = this.#aboveGround(sample(positions, bound.start.position, time, lerpVec3));
          // An orientation key looks from where the camera is at that key (its own position, else the sampled one).
          const rotations = keys.flatMap((k) => {
            const from = k.position === undefined ? position : k.relativeTo === undefined ? k.position : this.#position(k.relativeTo).__add__(k.position);
            const q = this.#orientation(k, from);
            return q === undefined ? [] : [{ t: k.t, ease: k.ease, cut: k.cut, value: q }];
          });
          const rotation = sample(rotations, bound.start.rotation, time, slerp);
          const fovs = keys.flatMap((k) => (k.fov === undefined ? [] : [{ t: k.t, ease: k.ease, cut: k.cut, value: k.fov }]));
          setWorldPose(record, { position, rotation });
          const fields = record.components.get(CAMERA);
          if (fields !== undefined) fields['fov'] = sample(fovs, bound.start.fov, time, lerpNumber);
          break;
        }
        case 'transform': {
          const keys = bound.track.keys;
          const channel = <T>(pick: (k: (typeof keys)[number]) => T | undefined): ChannelKey<T>[] =>
            keys.flatMap((k) => { const v = pick(k); return v === undefined ? [] : [{ t: k.t, ease: k.ease, cut: k.cut, value: v }]; });
          const node = record.transform;
          if (keys.some((k) => k.position !== undefined)) node.position = sample(channel((k) => k.position), bound.start.position, time, lerpVec3);
          if (keys.some((k) => k.rotation !== undefined)) {
            node.rotation = sample(channel((k) => (k.rotation === undefined ? undefined : Quat.from_euler(k.rotation))), bound.start.rotation, time, slerp);
          }
          if (keys.some((k) => k.scale !== undefined)) node.scale = sample(channel((k) => k.scale), bound.start.scale, time, lerpVec3);
          break;
        }
        case 'visibility':
          record.visible = sample(bound.track.keys.map((k) => ({ t: k.t, ease: 'linear', cut: true, value: k.visible })), bound.start, time, (a) => a, true);
          break;
        case 'property': {
          const fields = record.components.get(bound.track.component);
          if (fields === undefined) break;
          const kind = bound.spec.type.kind;
          fields[bound.track.field] = sample(bound.keys, bound.start, time, mixer(kind), STEP_KINDS.has(kind));
          break;
        }
      }
    }
  }

  /** The grade and the time scale: global, so put back even when the scene (and every entity) is gone. */
  #resetGlobals(run: Run): void {
    for (const bound of run.tracks) {
      if (bound.type === 'grade') this.kernel.service(ENVIRONMENT_SERVICE).grade?.(null, 0);
      else if (bound.type === 'time_scale') this.kernel.time.scale = bound.start;
    }
  }

  #end(skipped: boolean): void {
    const run = this.#run!;
    const world = this.kernel.world;
    for (const bound of run.tracks) {
      if (bound.type === 'focus') {
        if (!world.isAlive(bound.camera)) continue;
        const dof = world.get(bound.camera)!.components.get(DEPTH_OF_FIELD);
        if (bound.start.added) {
          if (dof !== undefined) this.kernel.removeComponent(bound.camera, DEPTH_OF_FIELD);
        } else if (dof !== undefined) {
          dof['focus_distance'] = bound.start.distance;
          dof['focus_range'] = bound.start.range;
          dof['max_blur'] = bound.start.blur;
        }
        continue;
      }
      if (bound.type !== 'transform' && bound.type !== 'visibility' && bound.type !== 'property') continue;
      if (!bound.track.restore) continue;
      const record = world.get(bound.entity);
      if (record === undefined) continue;
      if (bound.type === 'transform') {
        record.transform.position = bound.start.position;
        record.transform.rotation = bound.start.rotation;
        record.transform.scale = bound.start.scale;
      } else if (bound.type === 'visibility') {
        record.visible = bound.start;
      } else {
        const fields = record.components.get(bound.track.component);
        if (fields !== undefined) fields[bound.track.field] = bound.start;
      }
    }
    this.#resetGlobals(run);
    for (const s of run.spawned) if (!s.keep && world.isAlive(s.entity)) this.kernel.destroy(s.entity);
    const cam = run.camera;
    const record = cam === null ? undefined : world.get(cam.entity);
    const fields = record?.components.get(CAMERA);
    if (cam !== null && record !== undefined && fields !== undefined) {
      fields['rig'] = cam.rig;
      fields['fov'] = cam.fov;
      if (cam.rig === 'fixed') {
        record.transform.position = cam.local.position;
        record.transform.rotation = cam.local.rotation;
      }
    }
    this.#run = null;
    this.kernel.emit(CINEMATIC_EVENTS.ended, { cinematic: this.#host.ref(this.kernel, run.cinematic.id), skipped });
  }

  // ── Snapshots ──────────────────────────────────────────────────────────────

  snapshot(): { run: SavedRun | null } {
    const run = this.#run;
    if (run === null) return { run: null };
    const starts = run.tracks.map((b): Json => {
      switch (b.type) {
        case 'camera': return { position: v3(b.start.position), rotation: q4(b.start.rotation), fov: b.start.fov };
        case 'transform': return { position: v3(b.start.position), rotation: q4(b.start.rotation), scale: v3(b.start.scale) };
        case 'visibility': return b.start;
        case 'property': return encode(b.spec.type, b.start, `cinematic "${run.cinematic.id}" start`);
        case 'time_scale': return b.start;
        case 'shake': return { camera: b.camera as number };
        case 'focus': return { camera: b.camera as number, ...b.start };
        default: return null;
      }
    });
    return {
      run: {
        id: run.cinematic.id,
        elapsed: run.elapsed,
        names: [...run.names].map(([n, id]) => [n, id as number] as const),
        starts,
        camera: run.camera === null ? null : {
          entity: run.camera.entity as number, rig: run.camera.rig, fov: run.camera.fov,
          position: v3(run.camera.local.position), rotation: q4(run.camera.local.rotation),
        },
        lastSeen: [...run.lastSeen].map(([n, p]) => [n, v3(p)] as const),
        nextHold: run.nextHold,
        awaiting: run.awaiting,
        spawned: run.spawned.map((s) => [s.entity as number, s.keep, s.name] as const),
        lastReal: run.lastReal,
      },
    };
  }

  restore(saved: { run: SavedRun | null }): void {
    // The grade lives outside the snapshot (the environment's); a restored run sets it again on its next frame.
    if (this.#run?.tracks.some((b) => b.type === 'grade') === true) this.kernel.service(ENVIRONMENT_SERVICE).grade?.(null, 0);
    this.#run = null;
    const s = saved.run;
    if (s === null) return;
    const c = this.cinematic(s.id);
    const names = new Map(s.names.map(([n, id]) => [n, id as EntityId]));
    const cameraEntity = s.camera === null ? undefined : s.camera.entity as EntityId;
    const tracks = c.tracks.map((track, i) => this.#bind(c, track, names, cameraEntity, s.starts[i] ?? null));
    this.#run = {
      cinematic: c, elapsed: s.elapsed, names, tracks,
      camera: s.camera === null ? null : {
        entity: s.camera.entity as EntityId, rig: s.camera.rig, fov: s.camera.fov,
        local: { position: toV3(s.camera.position), rotation: toQ(s.camera.rotation) },
      },
      lastSeen: new Map(s.lastSeen.map(([n, p]) => [n, toV3(p)])),
      holds: holdTimes(c),
      nextHold: s.nextHold ?? 0,
      awaiting: s.awaiting ?? false,
      spawned: (s.spawned ?? []).map(([entity, keep, name]) => ({ entity: entity as EntityId, keep, name })),
      clock: c.tracks.some((t) => t.type === 'time_scale') ? 'real' : 'game',
      lastReal: s.lastReal ?? this.kernel.time.realNow,
    };
  }
}

/** A Tag field's id (data stores the string; game code may store the Tag object). */
function tagOf(value: unknown): string {
  if (typeof value === 'string') return value;
  const id = (value as { __tag_id__?: unknown } | null)?.__tag_id__;
  if (typeof id === 'string') return id;
  return fail('PP7216', 'cinematic_trigger.activator must be a tag', { fix: 'Give the trigger "activator": "<tag>" (e.g. "player").' });
}

/** A content ref field's id (data stores the id; game code may store the ContentRef). */
function refId(value: unknown): string {
  if (typeof value === 'string') return value;
  const id = (value as { id?: unknown } | null)?.id;
  if (typeof id === 'string') return id;
  return fail('PP7216', 'cinematic_trigger.cinematic must name a cinematic', { fix: 'Give the trigger "cinematic": "<id>" (content/cinematic/<id>.json).' });
}
