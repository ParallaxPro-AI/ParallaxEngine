/**
 * wind — the scene's wind field (sdk/parallax/wind.pyi), provided as the `wind` service
 * (function/services/wind.ts) for foliage and grass sway, streaks and debris (render3d),
 * weather, and gameplay through `ctx.wind`.
 *
 * State: the settings the scene started with, and the change in progress (from, to, start
 * and length in game time) when the game or weather eased the wind. The field itself is a
 * pure function of those, position and game time.
 */

import { fail } from '../../../core/index.js';
import type { Json } from '../../../resource/index.js';
import type { Kernel, KernelPlugin } from '../../kernel/index.js';
import { WIND_SERVICE, WIND_SYNC_SERVICE } from '../../services/index.js';
import type { WindChange, WindRamp, WindService, WindSettings, WindSync } from '../../services/index.js';
import { blendSettings, CALM, readWindSpec, windAt } from './field.js';

export { bearing, blendSettings, CALM, readWindSpec, windAt } from './field.js';

type Ramp = WindRamp;

function checkChange(change: WindChange): void {
  const bad = (what: string, value: unknown, rule: string): never =>
    fail('PP3237', `wind.set ${what} is ${String(value)}; it ${rule}`, { fix: `Pass a ${what} that ${rule}.` });
  if (change.speed !== undefined && !(Number.isFinite(change.speed) && change.speed >= 0)) bad('speed', change.speed, "isn't negative");
  if (change.gusts !== undefined && !(change.gusts >= 0 && change.gusts <= 1)) bad('gusts', change.gusts, 'is from 0 to 1');
  if (change.seconds !== undefined && !(Number.isFinite(change.seconds) && change.seconds >= 0)) bad('seconds', change.seconds, "isn't negative");
  if ((change.dirX === undefined) !== (change.dirZ === undefined)) bad('direction', 'half given', 'has both x and z');
  if (change.dirX !== undefined) {
    const l = Math.sqrt(change.dirX * change.dirX + change.dirZ! * change.dirZ!);
    if (!(l > 0)) bad('direction', '(0, 0)', 'is not zero on the ground plane');
  }
}

export function wind(): KernelPlugin {
  let ramp: Ramp = { from: CALM, to: CALM, start: 0, seconds: 0 };
  let installedOn: Kernel | undefined;

  const now = (): WindSettings => {
    const t = installedOn?.time.now ?? 0;
    if (ramp.seconds <= 0 || t >= ramp.start + ramp.seconds) return ramp.to;
    return blendSettings(ramp.from, ramp.to, (t - ramp.start) / ramp.seconds);
  };

  const service: WindService = {
    settings: now,
    sample(x, z, out = new Float64Array(2)) {
      return windAt(now(), x, z, installedOn?.time.now ?? 0, out);
    },
    mean(out = new Float64Array(2)) {
      const s = now();
      out[0] = s.dirX * s.speed;
      out[1] = s.dirZ * s.speed;
      return out;
    },
    set(change) {
      checkChange(change);
      const from = now();
      let dirX = from.dirX;
      let dirZ = from.dirZ;
      if (change.dirX !== undefined) {
        const l = Math.sqrt(change.dirX * change.dirX + change.dirZ! * change.dirZ!);
        dirX = change.dirX / l;
        dirZ = change.dirZ! / l;
      }
      const to: WindSettings = { ...from, dirX, dirZ, speed: change.speed ?? from.speed, gusts: change.gusts ?? from.gusts };
      ramp = { from, to, start: installedOn?.time.now ?? 0, seconds: change.seconds ?? 0 };
    },
  };
  const sync: WindSync = {
    ramp: () => ramp,
    follow(next) {
      ramp = { from: { ...next.from }, to: { ...next.to }, start: next.start, seconds: next.seconds };
    },
  };

  return {
    id: 'wind',
    install(kernel) {
      if (installedOn !== undefined) fail('PP3238', 'This wind plugin is already installed in another kernel', { fix: 'Call wind() once per game.' });
      installedOn = kernel;
      kernel.provide(WIND_SERVICE, service);
      kernel.provide(WIND_SYNC_SERVICE, sync);
      kernel.observeScenes({
        loading: (scene) => {
          const s = scene === undefined ? CALM : readWindSpec(scene);
          ramp = { from: s, to: s, start: 0, seconds: 0 };
        },
      });
    },
    snapshot: () => ramp as unknown as Json,
    restore: (_kernel, state) => {
      ramp = state as unknown as Ramp;
    },
  };
}
