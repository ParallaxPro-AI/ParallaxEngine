/**
 * The combat director: pacing for spawned enemies. It runs three phases in a loop —
 *
 *   build   spawning is allowed; intensity rises from what the game reports
 *           (`director.report(x)`: the player hurt, a close call, an enemy in sight);
 *           reaching `peak_intensity` starts the peak
 *   peak    spawning stays allowed for `peak_seconds`, then the relax starts
 *   relax   no spawning for at least `relax_seconds` and until intensity has fallen to
 *           `relax_below`; then building again
 *
 * Intensity (0..1) decays by `decay` per second all the time. Spawning spends budget:
 * `budget_per_minute` tokens accrue while not relaxing (capped at `budget_cap`), each
 * spawn costs `cost`, and at most `max_alive` director-spawned entities live at once.
 * `can_spawn(cost)` answers; `spawned(entity, cost)` records one. Phase changes emit
 * `DirectorPhase`. Plain state, advanced by the fixed step: deterministic and snapshotted.
 */

import { fail } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import type { Json, JsonObject } from '../../../resource/index.js';

export interface DirectorSettings {
  readonly budgetPerMinute: number;
  readonly budgetCap: number;
  readonly maxAlive: number;
  readonly peakIntensity: number;
  readonly peakSeconds: number;
  readonly relaxSeconds: number;
  readonly relaxBelow: number;
  readonly decay: number;
}

export const DIRECTOR_DEFAULTS: DirectorSettings = {
  budgetPerMinute: 20, budgetCap: 20, maxAlive: 12, peakIntensity: 0.8, peakSeconds: 10, relaxSeconds: 15, relaxBelow: 0.3, decay: 0.03,
};

/** Python keyword → setting. */
export const DIRECTOR_KEYS: Readonly<Record<string, keyof DirectorSettings>> = {
  budget_per_minute: 'budgetPerMinute', budget_cap: 'budgetCap', max_alive: 'maxAlive', peak_intensity: 'peakIntensity',
  peak_seconds: 'peakSeconds', relax_seconds: 'relaxSeconds', relax_below: 'relaxBelow', decay: 'decay',
};

export type Phase = 'build' | 'peak' | 'relax';

export function directorSettings(given: Readonly<Record<string, unknown>>, base: DirectorSettings = DIRECTOR_DEFAULTS): DirectorSettings {
  const out: Record<string, number> = { ...base };
  for (const [key, value] of Object.entries(given)) {
    const name = DIRECTOR_KEYS[key];
    if (name === undefined) fail('PP3280', `director has no setting "${key}"`, { fix: `Settings: ${Object.keys(DIRECTOR_KEYS).join(', ')}.` });
    const unit = name === 'peakIntensity' || name === 'relaxBelow';
    if (!(typeof value === 'number' && Number.isFinite(value) && value >= 0 && (!unit || value <= 1)) || (name === 'maxAlive' && !Number.isInteger(value))) {
      fail('PP3280', `director ${key} must be ${unit ? 'a number in [0, 1]' : name === 'maxAlive' ? 'a whole number of at least 0' : 'a number of at least 0'}, got ${String(value)}`);
    }
    out[name] = value;
  }
  return out as unknown as DirectorSettings;
}

export class Director {
  settings: DirectorSettings;
  phase: Phase = 'build';
  intensity = 0;
  budget: number;
  /** Seconds in the current phase. */
  elapsed = 0;
  readonly alive = new Set<EntityId>();

  constructor(settings: DirectorSettings) {
    this.settings = settings;
    this.budget = settings.budgetCap;
  }

  report(amount: number): void {
    if (!(typeof amount === 'number' && Number.isFinite(amount))) fail('PP3280', `director.report() takes a number, got ${String(amount)}`);
    this.intensity = Math.min(1, Math.max(0, this.intensity + amount));
  }

  canSpawn(cost: number): boolean {
    return this.phase !== 'relax' && this.budget >= cost && this.alive.size < this.settings.maxAlive;
  }

  spawned(id: EntityId, cost: number): void {
    this.budget = Math.max(0, this.budget - cost);
    this.alive.add(id);
  }

  /** Advance; returns the new phase when it changed. */
  step(dt: number): Phase | null {
    const s = this.settings;
    this.intensity = Math.max(0, this.intensity - s.decay * dt);
    this.elapsed += dt;
    if (this.phase !== 'relax') this.budget = Math.min(s.budgetCap, this.budget + (s.budgetPerMinute / 60) * dt);
    const next: Phase | null =
      this.phase === 'build' ? (this.intensity >= s.peakIntensity ? 'peak' : null)
        : this.phase === 'peak' ? (this.elapsed >= s.peakSeconds ? 'relax' : null)
          : this.elapsed >= s.relaxSeconds && this.intensity <= s.relaxBelow ? 'build' : null;
    if (next === null) return null;
    this.phase = next;
    this.elapsed = 0;
    return next;
  }

  snapshot(): Json {
    return { phase: this.phase, intensity: this.intensity, budget: this.budget, elapsed: this.elapsed, alive: [...this.alive] };
  }

  restore(json: Json, alive: (id: EntityId) => boolean): void {
    const o = json as JsonObject;
    this.phase = o['phase'] as Phase;
    this.intensity = o['intensity'] as number;
    this.budget = o['budget'] as number;
    this.elapsed = o['elapsed'] as number;
    this.alive.clear();
    for (const id of o['alive'] as EntityId[]) if (alive(id)) this.alive.add(id);
  }
}
