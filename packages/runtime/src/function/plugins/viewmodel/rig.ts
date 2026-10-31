/**
 * The viewmodel rig: one frame of the procedural layers, as pure math over a JSON state (no
 * entities, no services), so every layer is testable on its own and the whole is
 * deterministic and snapshot-able. Output is the held item's camera-space pose and the arms'
 * offset; the plugin writes them to the entities.
 *
 *   base    hip pose → aim pose (eased over aim_time), → sprint pose while running
 *   bob     a figure-eight paced by ground speed: sideways at the stride rate, a dip at
 *           every footfall; damped by stance and aiming, faded out in the air
 *   sway    smooth noise on position and turn (much less while aiming)
 *   lag     the item trails the view's turning (springs on yaw and pitch rate)
 *   recoil  springs kicked by fire(): back, up, muzzle rise, a fixed sideways pattern, roll
 *   land    a dip kicked by a landing, by fall speed
 *   pose    a keyframed move on top (poses.ts)
 *
 * Turns are degrees (pitch, yaw, roll): pitch + up (muzzle rises), yaw + right, roll — the
 * engine's pitch convention. The plugin negates pitch when it builds the Euler rotation
 * (`Quat.from_euler` tips forward down for + x).
 */

import { Vec3 } from '../../../core/index.js';
import { samplePose } from './poses.js';
import type { ViewPose } from './poses.js';
import { ease, fbm, kick, patternValue, spring, stepSpring, wrap180 } from './springs.js';
import type { SpringState } from './springs.js';

/** Ground speed (m/s) at which the bob has its authored size. */
export const BOB_REFERENCE_SPEED = 4;
/** Meters of travel per bob cycle (two footfalls). */
export const STRIDE = 1.8;
export const BOB_SIDE = 0.012;
export const BOB_DIP = 0.008;
export const BOB_ROLL = 1.2;
export const SWAY_OFFSET = 0.003;
export const SWAY_TURN = 0.5;
export const SWAY_RATE = 0.35;
/** Degrees of lag per degree-per-second of view turning, and its cap. */
export const LAG_GAIN = 0.012;
export const LAG_MAX = 5;
export const LAG_FREQUENCY = 6;
export const LAG_DAMPING = 0.5;
/** Meters of sideways drift per degree of yaw lag. */
export const LAG_SHIFT = 0.002;
export const LAND_GAIN = 0.004;
export const LAND_MAX = 0.05;
export const LAND_FREQUENCY = 7;
export const LAND_DAMPING = 0.45;
export const SPRINT_RATE = 10;
const RECOIL_SEED = 0x51ed;

export interface RecoilSpec {
  readonly kick_back: number;
  readonly kick_up: number;
  readonly pitch: number;
  readonly yaw: number;
  readonly roll: number;
  readonly frequency: number;
  readonly damping: number;
  readonly pattern: readonly number[];
  readonly reset: number;
}

export interface RigState {
  time: number;
  aiming: number;
  aimGoal: boolean;
  sprint: number;
  phase: number;
  amp: number;
  lagYaw: SpringState;
  lagPitch: SpringState;
  back: SpringState;
  up: SpringState;
  rise: SpringState;
  side: SpringState;
  roll: SpringState;
  land: SpringState;
  view: { yaw: number; pitch: number } | null;
  shot: number;
  lastShot: number;
}

export function freshRig(): RigState {
  return {
    time: 0, aiming: 0, aimGoal: false, sprint: 0, phase: 0, amp: 0, lagYaw: spring(), lagPitch: spring(), back: spring(), up: spring(),
    rise: spring(), side: spring(), roll: spring(), land: spring(), view: null, shot: 0, lastShot: -Infinity,
  };
}

export interface BodyMotion {
  /** Horizontal m/s. */
  readonly speed: number;
  readonly grounded: boolean;
  readonly running: boolean;
  readonly stance: 'stand' | 'crouch' | 'prone';
  /** Downward m/s of a landing that happened since the last frame, else null. */
  readonly landing: number | null;
}

export interface RigInput {
  readonly dt: number;
  readonly body: BodyMotion;
  /** The camera's world heading and pitch now (degrees; pitch + up). */
  readonly view: { readonly yaw: number; readonly pitch: number };
  readonly hip: Vec3;
  readonly hipTurn: Vec3;
  readonly aim: Vec3;
  readonly aimTime: number;
  /** The item's multiplier on sway and bob (heavy items move less). */
  readonly itemSway: number;
  /** The viewmodel's own sway and bob multipliers. */
  readonly sway: number;
  readonly bob: number;
  readonly lag: number;
  readonly recoil: RecoilSpec;
  readonly sprintOffset: Vec3;
  readonly sprintTurn: Vec3;
  readonly pose: { readonly def: ViewPose; readonly t: number } | null;
}

export interface RigPose {
  readonly offset: Vec3;
  readonly turn: Vec3;
  /** The part of the motion the arms (the shoulders) follow: bob, sway and landing, not recoil or lag. */
  readonly arms: Vec3;
}

/** A shot: kick the recoil springs by the item's spec and the shot's place in its pattern. */
export function fireRig(state: RigState, recoil: RecoilSpec, strength: number): void {
  if (state.time - state.lastShot > recoil.reset) state.shot = 0;
  const pattern = recoil.pattern.length === 0 ? [1] : recoil.pattern;
  const m = pattern[Math.min(state.shot, pattern.length - 1)]! * strength;
  // A velocity kick of size·ω: the spec's numbers set the kick's scale (with the default
  // damping the visible peak is about half of it, then the ring).
  const w = recoil.frequency * Math.PI * 2;
  const aimed = 1 - 0.5 * state.aiming;
  kick(state.back, -recoil.kick_back * m * w * aimed);
  kick(state.up, recoil.kick_up * m * w * aimed);
  kick(state.rise, recoil.pitch * m * w * aimed);
  kick(state.side, recoil.yaw * patternValue(state.shot, RECOIL_SEED) * m * w * aimed);
  kick(state.roll, recoil.roll * patternValue(state.shot + 1000, RECOIL_SEED) * m * w);
  state.shot++;
  state.lastShot = state.time;
}

export function stepRig(state: RigState, input: RigInput): RigPose {
  const dt = input.dt;
  state.time += dt;

  // Base: hip → aim, and the sprint pose.
  const aimRate = input.aimTime <= 0 ? Infinity : dt / input.aimTime;
  state.aiming = state.aimGoal ? Math.min(1, state.aiming + aimRate) : Math.max(0, state.aiming - aimRate);
  const a = state.aiming * state.aiming * (3 - 2 * state.aiming);
  const body = input.body;
  const sprintGoal = body.running && body.grounded && !state.aimGoal ? 1 : 0;
  state.sprint = ease(state.sprint, sprintGoal, SPRINT_RATE, dt);
  if (Math.abs(state.sprint - sprintGoal) < 1e-4) state.sprint = sprintGoal;
  let offset = input.hip.__add__(input.aim.__sub__(input.hip).__mul__(a)).__add__(input.sprintOffset.__mul__(state.sprint));
  let turn = input.hipTurn.__mul__(1 - a).__add__(input.sprintTurn.__mul__(state.sprint));

  // Bob: phase paced by ground speed; size eases toward the speed's.
  const stanceScale = body.stance === 'crouch' ? 0.6 : body.stance === 'prone' ? 0.3 : 1;
  const ampGoal = body.grounded ? Math.min(body.speed / BOB_REFERENCE_SPEED, 1.6) * stanceScale * input.bob * input.itemSway * (1 - 0.85 * a) : 0;
  state.amp = ease(state.amp, ampGoal, 8, dt);
  if (body.grounded) state.phase = (state.phase + (2 * Math.PI * body.speed * dt) / STRIDE) % (2 * Math.PI);
  const side = Math.sin(state.phase);
  const dip = (1 - Math.cos(2 * state.phase)) / 2;
  const bob = new Vec3(side * BOB_SIDE * state.amp, -dip * BOB_DIP * state.amp, 0);
  const bobTurn = new Vec3(0, 0, side * BOB_ROLL * state.amp);

  // Sway: slow noise.
  const swayScale = input.sway * input.itemSway * (1 - 0.75 * a);
  const t = state.time * SWAY_RATE;
  const sway = new Vec3(fbm(t, 1), fbm(t, 2), 0).__mul__(SWAY_OFFSET * swayScale);
  const swayTurn = new Vec3(fbm(t, 3), fbm(t, 4), fbm(t, 5) * 0.5).__mul__(SWAY_TURN * swayScale);

  // Lag: the view's turning rate drives where the item trails to.
  let yawRate = 0;
  let pitchRate = 0;
  if (state.view !== null && dt > 0) {
    yawRate = wrap180(input.view.yaw - state.view.yaw) / dt;
    pitchRate = (input.view.pitch - state.view.pitch) / dt;
  }
  state.view = { yaw: input.view.yaw, pitch: input.view.pitch };
  const lagScale = input.lag * (1 - 0.6 * a);
  const clamp = (v: number): number => Math.max(-LAG_MAX, Math.min(LAG_MAX, v));
  const lagYaw = stepSpring(state.lagYaw, clamp(-yawRate * LAG_GAIN) * lagScale, LAG_FREQUENCY, LAG_DAMPING, dt);
  const lagPitch = stepSpring(state.lagPitch, clamp(-pitchRate * LAG_GAIN) * lagScale, LAG_FREQUENCY, LAG_DAMPING, dt);
  // Pitching up trails the item down (negative lagPitch), shifting it down too.
  const lag = new Vec3(lagYaw * LAG_SHIFT, lagPitch * LAG_SHIFT, 0);
  const lagTurn = new Vec3(lagPitch, lagYaw, -lagYaw * 0.5);

  // Recoil.
  const r = input.recoil;
  const recoil = new Vec3(0, stepSpring(state.up, 0, r.frequency, r.damping, dt), stepSpring(state.back, 0, r.frequency, r.damping, dt));
  const recoilTurn = new Vec3(
    stepSpring(state.rise, 0, r.frequency, r.damping, dt),
    stepSpring(state.side, 0, r.frequency, r.damping, dt),
    stepSpring(state.roll, 0, r.frequency, r.damping, dt),
  );

  // Landing.
  if (body.landing !== null) kick(state.land, -Math.min(body.landing * LAND_GAIN, LAND_MAX) * LAND_FREQUENCY * Math.PI * 2);
  const land = new Vec3(0, stepSpring(state.land, 0, LAND_FREQUENCY, LAND_DAMPING, dt), 0);

  // Pose.
  let poseOffset = Vec3.ZERO;
  let poseTurn = Vec3.ZERO;
  if (input.pose !== null) {
    const sampled = samplePose(input.pose.def, input.pose.t);
    poseOffset = sampled.offset;
    poseTurn = sampled.turn;
  }

  offset = offset.__add__(bob).__add__(sway).__add__(lag).__add__(recoil).__add__(land).__add__(poseOffset);
  turn = turn.__add__(bobTurn).__add__(swayTurn).__add__(lagTurn).__add__(recoilTurn).__add__(poseTurn);
  return { offset, turn, arms: bob.__add__(sway).__add__(land) };
}

/** The aim pose that puts a sight (in the item's frame) on the view axis `eyeRelief` ahead of the eye. */
export function solveAim(sight: Vec3, eyeRelief: number): Vec3 {
  return new Vec3(-sight.x, -sight.y, eyeRelief - sight.z);
}

// ── Saved form ───────────────────────────────────────────────────────────────

export function saveRig(state: RigState): unknown {
  return { ...structuredClone({ ...state, lastShot: Number.isFinite(state.lastShot) ? state.lastShot : null }) };
}

export function loadRig(saved: unknown): RigState {
  const s = structuredClone(saved) as RigState & { lastShot: number | null };
  return { ...s, lastShot: s.lastShot === null ? -Infinity : s.lastShot };
}
