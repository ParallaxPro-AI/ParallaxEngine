/**
 * Automatic locomotion: which clip a character's base layer plays, chosen from the model's
 * own clip names, when its Animator has no authored graph (sdk/parallax/characters.pyi,
 * "Locomotion"). Pure: numbers in, a command out, a little state (the gait it is in) — the
 * motor's adapter (`locomotion_driver.ts`) plays the command through the Animator's `play`.
 *
 *   gaits     idle / walk / run / sprint by ground speed, each boundary with hysteresis so
 *             a character hovering on one doesn't strobe between two clips; the boundaries
 *             follow the character's own walk_speed and run_speed
 *   direction forward / back / left / right of the facing (strafing reads as strafing),
 *             with a margin before it changes axis
 *   turning   standing and turning fast plays a turn clip when the model has one
 *   air       jump going up, fall coming down; a landing one-shot after a hard enough fall
 *   others    swim, climb / vault, seated, free fall, glide, crouch and prone gaits
 *   rate      the clip's playback rate scaled so its stride matches the ground speed (the
 *             cure for foot sliding), clamped to a range that still reads as the clip
 *
 * Clips are resolved by ordered candidate names, matched rig-neutrally (`clipKey`: case,
 * spaces, "_", "-", "Armature|" and "mixamo" prefixes don't matter), exact first, then by
 * containment preferring the shortest name: "Walking" over "Walking Backwards". Each state
 * degrades toward clips every rigged character has (a back walk falls back to the walk,
 * a sprint to the run, a crouch walk to the walk), so a model with only an idle and a walk
 * still animates; one with the full Mixamo set gets strafes, turns and landings.
 */

export type Gait = 'idle' | 'walk' | 'run' | 'sprint';
export type Heading = 'fwd' | 'back' | 'left' | 'right';

/** Locomotion states (`Character.clips` keys). */
export const LOCOMOTION_STATES = [
  'idle', 'walk', 'run', 'sprint',
  'walk_back', 'run_back', 'walk_left', 'walk_right', 'run_left', 'run_right',
  'turn_left', 'turn_right', 'jump', 'fall', 'land', 'hard_land',
  'crouch_idle', 'crouch_walk', 'prone_idle', 'crawl', 'swim_idle', 'swim', 'climb', 'vault', 'sit', 'free_fall', 'glide',
] as const;
export type LocomotionState = (typeof LOCOMOTION_STATES)[number];

/**
 * Candidate clip names per state, most specific first; a state's chain ends in the states
 * it falls back to (`→ state`).
 */
const CHAINS: Readonly<Record<LocomotionState, readonly string[]>> = {
  idle: ['idle', 'breathing idle', 'standing idle', 'stand idle', 'idle loop', 'stand', 'rest', 'tpose'],
  walk: ['walking', 'walk', 'walk forward', 'walk cycle', 'walk loop', 'catwalk walk forward', 'jog', '→run'],
  run: ['running', 'run', 'run forward', 'jogging', 'jog', 'run cycle', 'run loop', '→walk'],
  sprint: ['sprint', 'sprinting', 'fast run', 'run fast', '→run'],
  walk_back: ['walking backwards', 'walking backward', 'walk backward', 'walk backwards', 'walk back', 'back walk', '→walk'],
  run_back: ['running backward', 'running backwards', 'run backward', 'run backwards', 'run back', '→walk_back'],
  walk_left: ['left strafe walking', 'left strafe walk', 'strafe left walk', 'walk strafe left', 'walk left', 'strafe left', 'left strafe', '→walk'],
  walk_right: ['right strafe walking', 'right strafe walk', 'strafe right walk', 'walk strafe right', 'walk right', 'strafe right', 'right strafe', '→walk'],
  run_left: ['strafe running left', 'left strafe running', 'run strafe left', 'run left', 'left strafe run', '→walk_left'],
  run_right: ['strafe running right', 'right strafe running', 'run strafe right', 'run right', 'right strafe run', '→walk_right'],
  turn_left: ['left turn', 'turn left', 'turning left', 'turn l', 'turn 90 left', '→idle'],
  turn_right: ['right turn', 'turn right', 'turning right', 'turn r', 'turn 90 right', '→idle'],
  jump: ['jumping up', 'jump up', 'jumping', 'jump', 'jump start', '→fall'],
  fall: ['falling idle', 'fall loop', 'falling', 'fall', 'jumping down', 'in air', 'airborne', 'jump loop', '→idle'],
  land: ['landing', 'land', 'jump land', 'soft landing'],
  hard_land: ['hard landing', 'heavy landing', 'falling to landing', '→land'],
  crouch_idle: ['crouch idle', 'crouching idle', 'crouched idle', 'crouch', 'crouching', '→idle'],
  crouch_walk: ['crouched walking', 'crouch walk', 'crouching walk', 'sneak walk', 'sneaking', 'sneak', '→walk'],
  prone_idle: ['prone idle', 'prone', 'lying', '→crouch_idle'],
  crawl: ['crawl', 'crawling', 'prone forward', 'prone crawl', '→crouch_walk'],
  swim_idle: ['treading water', 'swim idle', 'tread water', 'swimming idle', '→swim'],
  swim: ['swimming', 'swim', 'breaststroke', 'front crawl', '→idle'],
  climb: ['climbing', 'climb', 'climbing up wall', 'ledge climb', 'climb up', '→jump'],
  vault: ['vault', 'vaulting', 'jump over', 'parkour vault', '→jump'],
  sit: ['sitting idle', 'sitting', 'sit', 'seated', 'sit idle', 'driving', '→idle'],
  free_fall: ['skydiving', 'free fall', 'freefall', 'falling', '→fall'],
  glide: ['parachute', 'gliding', 'glide', 'hanging idle', 'hanging', '→fall'],
};

/** Natural ground speed (m/s) of a gait's clips when the clip itself doesn't travel (in-place clips). */
export const REFERENCE_SPEED: Readonly<Partial<Record<LocomotionState, number>>> = {
  walk: 1.5, run: 3.8, sprint: 6, walk_back: 1.3, run_back: 3.2, walk_left: 1.4, walk_right: 1.4, run_left: 3.2, run_right: 3.2,
  crouch_walk: 1.1, crawl: 0.6, swim: 1.6,
};

export interface LocomotionTuning {
  /** Below this ground speed the character stands. */
  readonly idleSpeed: number;
  /** m/s band added around every boundary. */
  readonly hysteresis: number;
  /** Walk gives way to run here (default: midway between the character's walk and run speeds). */
  readonly runSpeed: number;
  /** Run gives way to sprint here (default: 1.2 × the character's run speed). */
  readonly sprintSpeed: number;
  /** deg/s of turning on the spot that plays a turn clip. */
  readonly turnRate: number;
  /** Clamp on the stride-matched playback rate. */
  readonly minRate: number;
  readonly maxRate: number;
  /** Downward m/s at landing above which a landing plays, and the hard one. */
  readonly landSpeed: number;
  readonly hardLandSpeed: number;
  /** Seconds the landing holds over standing still (moving cancels it). */
  readonly landTime: number;
}

/** The tuning for a character with these walk and run speeds. */
export function tuningFor(walkSpeed: number, runSpeed: number): LocomotionTuning {
  const walk = Math.max(0.5, walkSpeed);
  const run = Math.max(walk + 0.5, runSpeed);
  return {
    idleSpeed: Math.min(0.25, walk * 0.1), hysteresis: Math.min(0.4, (run - walk) * 0.15), runSpeed: (walk + run) / 2, sprintSpeed: run * 1.2,
    turnRate: 60, minRate: 0.6, maxRate: 1.8, landSpeed: 7, hardLandSpeed: 12, landTime: 0.4,
  };
}

export type LocomotionMotion = 'ground' | 'air' | 'swim' | 'traverse' | 'free_fall' | 'glide' | 'seated' | 'riding' | 'carried' | 'ragdoll';

/** One step of what the character is doing (world space; yaw in degrees about +y, the motor's). */
export interface LocomotionInput {
  readonly motion: LocomotionMotion;
  readonly stance: 'stand' | 'crouch' | 'prone';
  /** The traversal kind while traversing. */
  readonly traversal: 'vault' | 'climb' | null;
  readonly grounded: boolean;
  readonly velocity: { readonly x: number; readonly y: number; readonly z: number };
  /** Facing (degrees about +y; 0 faces +z). */
  readonly yaw: number;
  readonly running: boolean;
  /** Downward m/s of a landing this step, else null. */
  readonly landed: number | null;
  readonly dt: number;
}

/** What the base layer should play. */
export interface LocomotionCommand {
  readonly state: LocomotionState;
  readonly loop: boolean;
  /** Crossfade seconds when the clip changes. */
  readonly fade: number;
  /** Ground speed the clip's stride should match (m/s); null: play at its own rate. */
  readonly match: number | null;
}

/** The params the character sets for authored graphs (right positive; see characters.pyi). */
export interface LocomotionParams {
  /** m/s along the facing (back: negative). */
  readonly forward_speed: number;
  /** m/s across it (right: positive). */
  readonly strafe_speed: number;
  /** Degrees from the facing to the travel (0 ahead, 90 right, -90 left, ±180 back); 0 standing. */
  readonly direction: number;
  /** deg/s of turning (right: positive). */
  readonly turn_rate: number;
}

function wrap180(a: number): number {
  return ((((a + 180) % 360) + 360) % 360) - 180;
}

/**
 * Forward and right speeds of a world velocity for a character facing `yaw` (the engine is
 * left-handed: facing +z at yaw 0, its right is +x, and a positive yaw turns it right).
 */
export function decompose(vx: number, vz: number, yaw: number): { forward: number; right: number } {
  const r = (yaw * Math.PI) / 180;
  const fx = Math.sin(r);
  const fz = Math.cos(r);
  return { forward: vx * fx + vz * fz, right: vx * fz - vz * fx };
}

export class LocomotionSelector {
  #gait: Gait = 'idle';
  #heading: Heading = 'fwd';
  #turning: 'left' | 'right' | null = null;
  #lastYaw: number | null = null;
  #turnRate = 0;
  #land: { time: number; hard: boolean } | null = null;
  #state: LocomotionState = 'idle';
  #params: LocomotionParams = { forward_speed: 0, strafe_speed: 0, direction: 0, turn_rate: 0 };

  get state(): LocomotionState {
    return this.#state;
  }

  /** The strafe/turn params of the last update. */
  get params(): LocomotionParams {
    return this.#params;
  }

  update(input: LocomotionInput, tuning: LocomotionTuning): LocomotionCommand {
    const command = this.#pick(input, tuning);
    this.#state = command.state;
    return command;
  }

  #pick(input: LocomotionInput, t: LocomotionTuning): LocomotionCommand {
    const { velocity: v, dt } = input;
    const planar = Math.hypot(v.x, v.z);
    // Turning rate, smoothed over a few steps (the facing moves in turn_speed steps).
    if (this.#lastYaw !== null && dt > 0) {
      const rate = wrap180(input.yaw - this.#lastYaw) / dt;
      this.#turnRate += (rate - this.#turnRate) * Math.min(1, dt * 12);
    }
    this.#lastYaw = input.yaw;
    const { forward, right } = decompose(v.x, v.z, input.yaw);
    this.#params = {
      forward_speed: forward, strafe_speed: right, turn_rate: Math.abs(this.#turnRate) < 1e-3 ? 0 : this.#turnRate,
      direction: planar < t.idleSpeed ? 0 : (Math.atan2(right, forward) * 180) / Math.PI,
    };

    switch (input.motion) {
      case 'swim':
        this.#land = null;
        return this.#moving(planar > t.idleSpeed ? 'swim' : 'swim_idle', 0.3, planar > t.idleSpeed ? planar : null);
      case 'traverse':
        return { state: input.traversal === 'vault' ? 'vault' : 'climb', loop: false, fade: 0.1, match: null };
      case 'seated': case 'riding': case 'carried':
        this.#land = null;
        return { state: 'sit', loop: true, fade: 0.3, match: null };
      case 'free_fall':
        return { state: 'free_fall', loop: true, fade: 0.3, match: null };
      case 'glide':
        return { state: 'glide', loop: true, fade: 0.4, match: null };
      case 'ragdoll':
        return { state: this.#state, loop: true, fade: 0.2, match: null };
      default:
        break;
    }

    if (!input.grounded) {
      this.#land = null;
      this.#gait = 'idle';
      return v.y > 1 ? { state: 'jump', loop: false, fade: 0.1, match: null } : { state: 'fall', loop: true, fade: 0.15, match: null };
    }
    if (input.landed !== null && input.landed >= t.landSpeed) this.#land = { time: t.landTime, hard: input.landed >= t.hardLandSpeed };
    if (this.#land !== null) {
      this.#land.time -= dt;
      if (this.#land.time > 0 && planar < t.runSpeed) return { state: this.#land.hard ? 'hard_land' : 'land', loop: false, fade: 0.08, match: null };
      this.#land = null;
    }
    const fromAir = this.#state === 'jump' || this.#state === 'fall' || this.#state === 'land' || this.#state === 'hard_land';

    // Standing (hysteresis: a stopped character needs a little more to start moving).
    const start = t.idleSpeed + (this.#gait === 'idle' ? t.hysteresis * 0.5 : 0);
    if (planar < start) {
      this.#gait = 'idle';
      if (input.stance === 'crouch') return this.#moving('crouch_idle', 0.25, null);
      if (input.stance === 'prone') return this.#moving('prone_idle', 0.3, null);
      // Turning on the spot.
      const rate = this.#turnRate;
      const turning = this.#turning === null ? Math.abs(rate) > t.turnRate : Math.abs(rate) > t.turnRate * 0.5;
      this.#turning = turning ? (rate > 0 ? 'right' : 'left') : null;
      if (this.#turning !== null) return { state: this.#turning === 'right' ? 'turn_right' : 'turn_left', loop: true, fade: 0.15, match: null };
      return { state: 'idle', loop: true, fade: fromAir ? 0.12 : 0.22, match: null };
    }
    this.#turning = null;
    if (input.stance === 'crouch') {
      this.#gait = 'walk';
      return this.#moving('crouch_walk', 0.2, planar);
    }
    if (input.stance === 'prone') {
      this.#gait = 'walk';
      return this.#moving('crawl', 0.25, planar);
    }
    const was = this.#gait;
    this.#gait = this.#pickGait(planar, input.running, t);
    this.#heading = this.#pickHeading(forward, right);
    const fade = fromAir ? 0.12 : was === 'idle' ? 0.18 : 0.14;
    return this.#moving(gaitState(this.#gait, this.#heading), fade, planar);
  }

  #moving(state: LocomotionState, fade: number, match: number | null): LocomotionCommand {
    return { state, loop: true, fade, match };
  }

  #pickGait(planar: number, running: boolean, t: LocomotionTuning): Gait {
    const h = t.hysteresis;
    const g = this.#gait;
    const run = g === 'run' || g === 'sprint' ? t.runSpeed - h : t.runSpeed + (g === 'walk' ? h : 0);
    if (planar < run && !(running && planar >= t.runSpeed * 0.75)) return 'walk';
    const sprint = g === 'sprint' ? t.sprintSpeed - h : t.sprintSpeed + h;
    return planar >= sprint ? 'sprint' : 'run';
  }

  #pickHeading(forward: number, right: number): Heading {
    const af = Math.abs(forward);
    const ar = Math.abs(right);
    const onForward = this.#heading === 'fwd' || this.#heading === 'back';
    const margin = 1.15;
    const useForward = onForward ? af * margin >= ar : af >= ar * margin;
    if (useForward) return forward >= 0 ? 'fwd' : 'back';
    return right >= 0 ? 'right' : 'left';
  }
}

function gaitState(gait: Gait, heading: Heading): LocomotionState {
  if (gait === 'idle') return 'idle';
  if (heading === 'fwd') return gait;
  const base = gait === 'walk' ? 'walk' : 'run';
  return `${base}_${heading}` as LocomotionState;
}

/** A clip name as clips are matched: lowercase letters and digits, rig prefixes dropped. */
export function clipKey(name: string): string {
  let n = name.toLowerCase();
  const bar = n.lastIndexOf('|');
  if (bar >= 0) n = n.slice(bar + 1);
  n = n.replace(/^mixamo(\.com|rig)?[:_ ]?/, '').replace(/^(armature|anim|animation|clip)[ _.:-]+/, '');
  return n.replace(/[^a-z0-9]/g, '');
}

/**
 * The clip that plays `state`: the character's own choice for it (`chosen`, from
 * Character.clips), else the first candidate the model has, falling back down the state's
 * chain. Null: nothing fits.
 */
export function resolveLocomotionClip(state: LocomotionState, available: readonly string[], chosen: Readonly<Record<string, string>> = {}): string | null {
  const keys = available.map((name) => ({ name, key: clipKey(name) }));
  const seen = new Set<LocomotionState>();
  let at: LocomotionState | undefined = state;
  while (at !== undefined && !seen.has(at)) {
    seen.add(at);
    const own = chosen[at];
    if (own !== undefined && own !== '') return own;
    let next: LocomotionState | undefined;
    const names: string[] = [];
    for (const candidate of CHAINS[at]) {
      if (candidate.startsWith('→')) next = candidate.slice(1) as LocomotionState;
      else names.push(clipKey(candidate));
    }
    for (const want of names) {
      const exact = keys.find((k) => k.key === want);
      if (exact !== undefined) return exact.name;
    }
    const here = at;
    for (const want of names) {
      if (want.length < 3) continue;
      const containing = keys.filter((k) => k.key.includes(want) && !excluded(here, k.key));
      if (containing.length > 0) return containing.sort((a, b) => a.key.length - b.key.length || a.name.localeCompare(b.name))[0]!.name;
    }
    at = next;
  }
  return null;
}

/** Containment matches a state must not take ("walk" is not "walkbackwards" or "walkleft"). */
function excluded(state: LocomotionState, key: string): boolean {
  const directional = /back|left|right|strafe|turn/.test(key);
  const stanced = /crouch|prone|crawl|sneak|swim|sit|climb|jump|fall|land/.test(key);
  switch (state) {
    case 'idle': return directional || stanced || /walk|run/.test(key);
    case 'walk': case 'run': case 'sprint': return directional || stanced;
    case 'walk_back': case 'run_back': return /left|right|turn/.test(key) || stanced;
    case 'walk_left': case 'run_left': case 'turn_left': return /right|back/.test(key) || stanced;
    case 'walk_right': case 'run_right': case 'turn_right': return /left|back/.test(key) || stanced;
    case 'fall': return /land|free|sky/.test(key);
    case 'jump': return /land|down|over/.test(key);
    case 'land': return /hard/.test(key);
    default: return false;
  }
}
