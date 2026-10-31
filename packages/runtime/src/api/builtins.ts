/**
 * Declarations the SDK itself provides: the `Timer` record and the `Settings` resource.
 */

import { fail } from '../core/index.js';
import { declareBuiltIns, resource } from './declarations.js';
import { bindArgs, kw } from './kwargs.js';
import { PyDict } from './pyrt/collections.js';
import { field, RECORD, recordEquality, rt } from './types.js';

const DUE_TOLERANCE = 1e-9;

/** A saveable countdown for `state()` fields and resources. */
export class Timer {
  static readonly __annotations__ = { duration: () => rt.float, remaining: () => rt.float, repeat: () => rt.bool };
  declare duration: number;
  declare remaining: number;
  declare repeat: boolean;

  /**
   * `Timer(duration, *, start_done, repeat=False)`. `start_done` is required: whether the
   * timer starts ready (a cooldown) or must elapse first (a delay) is never implicit.
   * `Timer.cooldown(d)` / `Timer.delay(d)` are the usual spellings.
   */
  constructor(...args: unknown[]) {
    const a = bindArgs('Timer', args, { positional: ['duration'], keyword: ['repeat', 'start_done'], required: ['duration'] }).args;
    const duration = a['duration'];
    if (typeof duration !== 'number' || !(duration >= 0)) fail('PP3017', `Timer duration must be a number >= 0, got ${String(duration)}`);
    const startDone = a['start_done'];
    if (typeof startDone !== 'boolean') {
      fail('PP3017', `Timer(${String(duration)}) must say whether it starts done`, {
        fix: 'Use Timer.cooldown(d) for a timer that is ready at once, or Timer.delay(d) for one that must elapse first.',
      });
    }
    this.duration = duration;
    this.repeat = a['repeat'] === true;
    this.remaining = startDone ? 0 : duration;
  }

  /** `Timer.cooldown(duration)`: starts done, so the first `tick` that matters is after a `restart()`. */
  static cooldown(...args: unknown[]): Timer {
    const a = bindArgs('Timer.cooldown', args, { positional: ['duration'], required: ['duration'] }).args;
    return new Timer(a['duration'], kw({ start_done: true }));
  }

  /** `Timer.delay(duration, *, repeat=False)`: starts full; `tick` fires once `duration` has elapsed. */
  static delay(...args: unknown[]): Timer {
    const a = bindArgs('Timer.delay', args, { positional: ['duration'], keyword: ['repeat'], required: ['duration'] }).args;
    return new Timer(a['duration'], kw({ start_done: false, repeat: a['repeat'] === true }));
  }

  /**
   * Advance by dt. True exactly once when it reaches zero (once per period if
   * `repeat`); a done, non-repeating timer stays False until restarted.
   */
  tick(dt: number): boolean {
    if (this.remaining <= 0 && !this.repeat) return false;
    this.remaining -= dt;
    // Game time is a sum of float frame times: 30 frames of 1/60 must reach a 0.5 s timer.
    if (this.remaining > DUE_TOLERANCE) return false;
    if (this.repeat && this.duration > 0) {
      while (this.remaining <= DUE_TOLERANCE) this.remaining += this.duration;
    } else {
      this.remaining = 0;
    }
    return true;
  }

  restart(duration: number | null = null): void {
    if (duration !== null) this.duration = duration;
    this.remaining = this.duration;
  }

  get done(): boolean { return this.remaining <= 0; }

  /** 0 → 1. */
  get progress(): number { return this.duration > 0 ? 1 - this.remaining / this.duration : 1; }
}
Object.defineProperty(Timer, RECORD, { value: true });
recordEquality(Timer);

class SettingsFields {
  static readonly __annotations__ = {
    master_volume: () => rt.float,
    music_volume: () => rt.float,
    sfx_volume: () => rt.float,
    quality: () => rt.literal('low', 'medium', 'high'),
    language: () => rt.str,
    mouse_sensitivity: () => rt.float,
    stick_sensitivity: () => rt.float,
    invert_look: () => rt.bool,
    controls: () => rt.dict(rt.str, rt.str),
    reduced_motion: () => rt.bool,
    high_contrast: () => rt.bool,
    text_scale: () => rt.float,
    colorblind: () => rt.literal('none', 'protanopia', 'deuteranopia', 'tritanopia'),
  };
  static readonly master_volume = field(1, kw({ min: 0, max: 1 }));
  static readonly music_volume = field(1, kw({ min: 0, max: 1 }));
  static readonly sfx_volume = field(1, kw({ min: 0, max: 1 }));
  static readonly quality = field('high');
  static readonly language = field('en');
  static readonly mouse_sensitivity = field(1, kw({ min: 0 }));
  static readonly stick_sensitivity = field(1, kw({ min: 0 }));
  static readonly invert_look = field(false);
  /**
   * The player's control remaps: slot → key code or gamepad button name (see
   * `function/plugins/input/remap.ts`). Written by the SettingsPanel; empty = as declared.
   */
  static readonly controls = field(new PyDict());
  /** Accessibility: no camera shake, softer flashes, no pulsing HUD. */
  static readonly reduced_motion = field(false);
  /** Accessibility: solid backgrounds and outlines on HUD widgets. */
  static readonly high_contrast = field(false);
  /** Accessibility: HUD text size multiplier. */
  static readonly text_scale = field(1, kw({ min: 0.75, max: 2 }));
  /** Accessibility: colour-vision mode (HUD palette; renderers' colour filter). */
  static readonly colorblind = field('none');
}

/** Built-in, keep="profile". Edited through SettingsPanel; readable by games. */
export const Settings = declareBuiltIns(() => resource('settings', kw({ keep: 'profile' }))(SettingsFields));
