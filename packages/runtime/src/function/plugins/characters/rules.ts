/**
 * Rules between a Character's fields that a field schema can't state (sdk/parallax/characters.pyi):
 * the stance heights chain down to the capsule's diameter, swimming depths are ordered, the
 * parachute's sinks sit under free fall's speeds. Pure over plain values — the runtime raises
 * the first problem when the entity arrives, `parallax check` reports them all, from this code.
 */

export interface CharacterProblem {
  readonly code: `PP${number}`;
  /** JSON pointer below the character component ("/stances/crouch_height"). */
  readonly pointer: string;
  readonly message: string;
  readonly fix: string;
}

import { LOCOMOTION_STATES } from './locomotion.js';

type Obj = Readonly<Record<string, unknown>>;

/** A Character's eye height without `eye_height`: this fraction of its height. */
export const EYE_FRACTION = 0.9;

/** The standing eye height a Character's fields give. */
export function eyeHeight(fields: Obj): number {
  const height = num(fields, 'height', 1.8);
  return num(fields, 'eye_height', EYE_FRACTION * height);
}

function num(o: Obj, key: string, fallback: number): number {
  const v = o[key];
  return typeof v === 'number' ? v : fallback;
}

function rec(o: Obj, key: string): Obj | null {
  const v = o[key];
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Obj : null;
}

/**
 * Problems of one character's fields: authored JSON (missing keys take the SDK defaults) or
 * runtime fields (records as plain objects). Values outside a field's own min/max are the
 * schema's business, not this.
 */
export function characterProblems(fields: Obj): CharacterProblem[] {
  const out: CharacterProblem[] = [];
  const height = num(fields, 'height', 1.8);
  const radius = num(fields, 'radius', 0.35);
  const eye = num(fields, 'eye_height', EYE_FRACTION * height);
  if (eye > height) {
    out.push({ code: 'PP3199', pointer: '/eye_height', message: `eye_height ${eye} is above the character's height ${height}`, fix: 'Put the eyes inside the body (about 0.9 × height).' });
  }
  const stances = rec(fields, 'stances');
  if (stances !== null) {
    const crouch = num(stances, 'crouch_height', 1.2);
    const proneOn = stances['prone'] === true;
    const prone = num(stances, 'prone_height', 0.8);
    const chain = `height ${height} ≥ crouch_height ${crouch}${proneOn ? ` ≥ prone_height ${prone}` : ''} ≥ 2 × radius ${2 * radius}`;
    const lowest = proneOn ? prone : crouch;
    if (crouch > height) {
      out.push({ code: 'PP3177', pointer: '/stances/crouch_height', message: `crouch_height ${crouch} is taller than standing (${height}); the chain is ${chain}`, fix: 'Lower crouch_height below height.' });
    } else if (proneOn && prone > crouch) {
      out.push({ code: 'PP3177', pointer: '/stances/prone_height', message: `prone_height ${prone} is taller than crouching (${crouch}); the chain is ${chain}`, fix: 'Lower prone_height below crouch_height.' });
    } else if (lowest < 2 * radius) {
      out.push({
        code: 'PP3177', pointer: proneOn ? '/stances/prone_height' : '/stances/crouch_height',
        message: `${proneOn ? 'prone' : 'crouch'}_height ${lowest} is shorter than the capsule's diameter ${2 * radius}; the chain is ${chain}`,
        fix: `Raise it to at least ${2 * radius}, or make radius smaller.`,
      });
    }
  }
  const swim = rec(fields, 'swim');
  if (swim !== null) {
    const enter = num(swim, 'enter_depth', 1.35);
    const exit = num(swim, 'exit_depth', 0.9);
    const float = num(swim, 'float_depth', 1.25);
    if (exit >= enter) {
      out.push({ code: 'PP3178', pointer: '/swim/exit_depth', message: `swim.exit_depth ${exit} must be shallower than enter_depth ${enter}`, fix: 'Leave a gap so it doesn\'t flicker between walking and swimming (e.g. 0.9 and 1.35).' });
    }
    if (float <= exit) {
      out.push({ code: 'PP3178', pointer: '/swim/float_depth', message: `swim.float_depth ${float} is at or above exit_depth ${exit}: a floating swimmer would stop swimming`, fix: 'Float deeper than exit_depth.' });
    }
    if (float > height) {
      out.push({ code: 'PP3178', pointer: '/swim/float_depth', message: `swim.float_depth ${float} puts the surface above the head (height ${height})`, fix: 'Float with the head out: float_depth below eye_height.' });
    }
  }
  const sky = rec(fields, 'skydive');
  const chute = rec(fields, 'parachute');
  if (sky !== null) {
    const terminal = num(sky, 'terminal', 38);
    const dive = num(sky, 'dive_terminal', 58);
    if (dive < terminal) {
      out.push({ code: 'PP3179', pointer: '/skydive/dive_terminal', message: `skydive.dive_terminal ${dive} is slower than terminal ${terminal}`, fix: 'Diving falls at least as fast as falling.' });
    }
    if (chute !== null) {
      const sink = num(chute, 'sink', 4.2);
      const flare = num(chute, 'flare_sink', 1.8);
      const diveSink = num(chute, 'dive_sink', 10);
      if (!(flare <= sink && sink <= diveSink && diveSink < terminal)) {
        out.push({
          code: 'PP3179', pointer: '/parachute/sink',
          message: `parachute sinks must be ordered flare_sink ${flare} ≤ sink ${sink} ≤ dive_sink ${diveSink} < skydive.terminal ${terminal}`,
          fix: 'A canopy falls slower than free fall; flaring slows it and diving speeds it.',
        });
      }
    }
  } else if (chute !== null) {
    out.push({ code: 'PP3179', pointer: '/parachute', message: 'parachute is set without skydive: a parachute opens in free fall', fix: 'Add "skydive": {} as well.' });
  }
  const clips = rec(fields, 'clips');
  for (const [state, clip] of Object.entries(clips ?? {})) {
    if (!(LOCOMOTION_STATES as readonly string[]).includes(state)) {
      out.push({ code: 'PP3176', pointer: `/clips/${state}`, message: `clips names "${state}", which is no locomotion state`, fix: `Locomotion states: ${LOCOMOTION_STATES.join(', ')}.` });
    } else if (typeof clip !== 'string' || clip === '') {
      out.push({ code: 'PP3176', pointer: `/clips/${state}`, message: `clips["${state}"] must be a clip name`, fix: 'Name a clip of the model ("Walking"), another model\'s ("assets/models/anims.glb#Walking") or an authored one ("clips/walk_cycle").' });
    }
  }
  const traversal = rec(fields, 'traversal');
  if (traversal !== null) {
    const vault = num(traversal, 'vault_height', 1.1);
    const climb = num(traversal, 'climb_height', 2.4);
    const step = num(fields, 'step_height', 0.3);
    if (climb <= step) {
      out.push({ code: 'PP3180', pointer: '/traversal/climb_height', message: `traversal.climb_height ${climb} is within step_height ${step}: such ledges are simply stepped up`, fix: 'Climb higher than step_height.' });
    }
    if (vault > climb) {
      out.push({ code: 'PP3180', pointer: '/traversal/vault_height', message: `traversal.vault_height ${vault} is above climb_height ${climb}`, fix: 'Vault at most as high as it climbs.' });
    }
  }
  return out;
}
