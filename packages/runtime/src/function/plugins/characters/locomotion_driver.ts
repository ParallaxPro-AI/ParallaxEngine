/**
 * The motor's side of automatic locomotion (`locomotion.ts`): per character, a selector fed
 * from the step, its strafe/turn params for authored graphs, and — when the Animator has
 * no state machine on its base layer and `Character.locomotion` is "auto" — the clip it
 * picks played on that layer through the Animator's own `play` (stride-matched rate,
 * crossfades). Clip names come from the `model_rig` service (the model's clips, then the
 * project's authored clips); a clip's natural ground speed is measured from its root
 * bone's travel (the `animation_clips` service), else a gait's reference speed for clips
 * that walk in place.
 *
 * Game code keeps the base layer whenever it plays something else on it: while the base
 * layer shows a clip locomotion didn't choose (a `play_once` attack, a `play` dance),
 * locomotion waits; it takes over again when the layer is back on one of its clips (a
 * one-shot returns to the loop it interrupted) or shows nothing (`stop()`).
 */

import type { EntityId } from '../../../core/index.js';
import type { EntityRecord, Fields, Kernel } from '../../kernel/index.js';
import { ANIMATION_CLIPS_SERVICE, MODEL_RIG_SERVICE } from '../../services/index.js';
import { LocomotionSelector, REFERENCE_SPEED, resolveLocomotionClip, tuningFor } from './locomotion.js';
import type { LocomotionInput, LocomotionParams, LocomotionState } from './locomotion.js';

const MODEL = 'model';

interface Run {
  readonly selector: LocomotionSelector;
  /** Clips locomotion has played on the base layer. */
  readonly owned: Set<string>;
  played: string | null;
  landedFrame: number;
  /** clip → its root's ground speed at rate 1 (m/s), null: in place. */
  readonly natural: Map<string, number | null>;
}

interface PlayingAnimator extends Fields {
  play(clip: string, keywords: { fade: number; loop: boolean; speed: number }): void;
  readonly clip: unknown;
}

function stored(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  const toJSON = (value as { toJSON?: unknown }).toJSON;
  if (typeof toJSON === 'function') {
    const form = (toJSON as () => unknown).call(value);
    if (typeof form === 'string') return form;
  }
  const name = (value as { name?: unknown }).name;
  return typeof name === 'string' ? name : null;
}

/** Whether an Animator's data runs a state machine on its base layer (an authored graph). */
export function hasBaseGraph(animator: Fields): boolean {
  const layers = animator['layers'];
  if (!Array.isArray(layers) || layers.length === 0) return false;
  const states = (layers[0] as { states?: unknown } | null)?.states;
  return typeof states === 'object' && states !== null && Object.keys(states).length > 0;
}

export interface LocomotionStep {
  readonly input: LocomotionInput;
  readonly walkSpeed: number;
  readonly runSpeed: number;
  /** The frame a landing happened on (`CharacterState.landed`), with its downward speed. */
  readonly landed: { readonly speed: number; readonly frame: number } | null;
}

export class LocomotionDriver {
  readonly #kernel: Kernel;
  readonly #runs = new Map<EntityId, Run>();

  constructor(kernel: Kernel) {
    this.#kernel = kernel;
  }

  forget(entity: EntityId): void {
    this.#runs.delete(entity);
  }

  /** The state the entity's locomotion is in (tests, tools); undefined before its first step. */
  state(entity: EntityId): LocomotionState | undefined {
    return this.#runs.get(entity)?.selector.state;
  }

  #run(entity: EntityId): Run {
    let run = this.#runs.get(entity);
    if (run === undefined) {
      run = { selector: new LocomotionSelector(), owned: new Set(), played: null, landedFrame: -1, natural: new Map() };
      this.#runs.set(entity, run);
    }
    return run;
  }

  /**
   * One step: select, then (auto mode, no base graph) play. Returns the strafe/turn params
   * the motor sets on declared graph params.
   */
  step(record: EntityRecord, fields: Fields, animator: Fields, step: LocomotionStep): LocomotionParams {
    const run = this.#run(record.id);
    const landed = step.landed !== null && step.landed.frame !== run.landedFrame ? step.landed.speed : null;
    if (step.landed !== null) run.landedFrame = step.landed.frame;
    const command = run.selector.update({ ...step.input, landed }, tuningFor(step.walkSpeed, step.runSpeed));
    if (fields['locomotion'] !== 'auto' || hasBaseGraph(animator)) return run.selector.params;

    const player = animator as PlayingAnimator;
    // Game code owns the base layer while it shows a clip locomotion didn't play.
    const showing = stored(player.clip);
    if (showing !== null && !run.owned.has(showing) && !(run.played === null && showing === stored(animator['default_clip']))) {
      return run.selector.params;
    }
    const clip = this.#clip(record, fields, command.state);
    if (clip === null) return run.selector.params;
    let rate = 1;
    if (command.match !== null && animator['root_motion'] !== 'character') {
      const natural = this.#natural(record, run, clip) ?? REFERENCE_SPEED[command.state] ?? REFERENCE_SPEED.walk!;
      const t = tuningFor(step.walkSpeed, step.runSpeed);
      rate = Math.round(Math.min(t.maxRate, Math.max(t.minRate, command.match / natural)) * 50) / 50;
    }
    run.owned.add(clip);
    run.played = clip;
    player.play(clip, { fade: command.fade, loop: command.loop, speed: rate });
    return run.selector.params;
  }

  /** The clip for `state` on this entity's model: Character.clips, the model's clips, the project's authored clips. */
  #clip(record: EntityRecord, fields: Fields, state: LocomotionState): string | null {
    const chosen = fields['clips'] as Readonly<Record<string, string>>;
    const model = record.components.get(MODEL);
    const rigs = this.#kernel.tryService(MODEL_RIG_SERVICE);
    let own: readonly string[] = [];
    if (model !== undefined && rigs !== undefined) {
      const ref = stored(model['model']);
      const rig = ref === null ? null : rigs.rig(ref);
      if (rig === undefined) return null; // still loading
      own = rig?.clips ?? [];
    }
    const authored = rigs?.authoredClips?.() ?? [];
    // Authored clips are matched by their file names ("clips/walk_cycle" as "walk_cycle").
    const names = [...own, ...authored.map((ref) => ref.slice('clips/'.length))];
    const found = resolveLocomotionClip(state, names, chosen);
    if (found === null) return null;
    if (chosen[state] === found || own.includes(found)) return found;
    return authored.includes(`clips/${found}`) ? `clips/${found}` : found;
  }

  /** A clip's root travel per second at rate 1, in world meters (the entity's scale); null: it plays in place. */
  #natural(record: EntityRecord, run: Run, clip: string): number | null {
    if (run.natural.has(clip)) return run.natural.get(clip)!;
    const clips = this.#kernel.tryService(ANIMATION_CLIPS_SERVICE);
    if (clips === undefined) return null;
    const info = clips.clip(record.id, clip);
    if (info === undefined) return null; // loading: measure later
    let speed: number | null = null;
    if (info !== null && info.duration > 0) {
      const a = clips.root(record.id, clip, 0, null);
      const b = clips.root(record.id, clip, info.duration, null);
      if (a === undefined || b === undefined) return null;
      if (a !== null && b !== null) {
        const scale = Math.abs(record.transform.scale.x);
        const travel = (Math.hypot(b.x - a.x, b.z - a.z) * scale) / info.duration;
        speed = travel > 0.3 ? travel : null;
      }
    }
    run.natural.set(clip, speed);
    return speed;
  }
}
