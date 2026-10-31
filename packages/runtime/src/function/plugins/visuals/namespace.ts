/**
 * `ctx.camera` (CameraApi in sdk/parallax/__init__.pyi): the active camera of the current
 * seat, of any player, and switching cameras (cutscenes). `main` returns the camera
 * component itself, with its methods (`shake`, `ray`, …) and `.entity`.
 */

import { fail } from '../../../core/index.js';
import type { Fields, Kernel } from '../../kernel/index.js';
import { describe } from './args.js';
import type { Cameras } from './camera.js';
import { CAMERA } from './schemas.js';

export class CameraApi {
  readonly #kernel: Kernel;
  readonly #cameras: Cameras;
  readonly #seat: () => number;

  constructor(kernel: Kernel, cameras: Cameras, seat: () => number) {
    this.#kernel = kernel;
    this.#cameras = cameras;
    this.#seat = seat;
  }

  #component(seat: number): Fields {
    return this.#kernel.world.require(this.#cameras.main(seat)).components.get(CAMERA)!;
  }

  /** The active camera for the current player's seat. */
  get main(): Fields {
    return this.#component(this.#seat());
  }

  for_player(player: unknown): Fields {
    const index = (player as { index?: unknown } | null)?.index;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
      fail('PP3746', `camera.for_player() takes a Player, got ${describe(player)}`, { fix: 'Pass one of ctx.players.' });
    }
    return this.#component(index);
  }

  /** Make another camera entity the active one for the current seat. */
  use(camera: unknown): void {
    const id = this.#kernel.handles.unwrap(camera);
    if (id === undefined || this.#kernel.world.get(id) === undefined) {
      fail('PP3721', `camera.use() takes a live camera entity, got ${describe(camera)}`, { fix: 'Pass the camera entity (camera.entity).' });
    }
    this.#cameras.use(id);
  }
}
