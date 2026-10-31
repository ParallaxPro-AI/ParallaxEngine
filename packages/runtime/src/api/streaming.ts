/**
 * Open worlds on the api side: `WorldLayer` (what `ctx.world.layer(ref)` returns,
 * sdk/parallax/__init__.pyi) and the core streaming plugin the runtime includes. The rules
 * live in the streaming plugin and its service (function/services/streaming.ts).
 */

import { fail } from '../core/index.js';
import type { Kernel, KernelPlugin } from '../function/kernel/index.js';
import { streaming } from '../function/plugins/streaming/index.js';
import { STREAMING_SERVICE } from '../function/services/index.js';
import type { LayerState, StreamedWorld } from '../function/services/index.js';
import { WorldLayerRef } from './types.js';

/** A world layer of the current scene's world.json. Prefer declarative `active_when`. */
export class WorldLayer {
  readonly ref: WorldLayerRef;
  readonly #kernel: Kernel;

  /** Unknown layers fail here, where the game names them, not at first use. */
  constructor(kernel: Kernel, ref: WorldLayerRef) {
    this.#kernel = kernel;
    this.ref = ref;
    this.#world().layerState(ref.id);
  }

  #world(): StreamedWorld {
    const world = this.#kernel.service(STREAMING_SERVICE).current();
    if (world === null) {
      fail('PP3637', `World layer "${this.ref.id}": scene "${this.#kernel.scene?.id ?? '?'}" has no world.json`, {
        fix: 'Use world layers only in open-world scenes (scenes/<id>/world.json declares them).',
      });
    }
    return world;
  }

  /** "unloaded", "loaded" or "active". */
  get state(): LayerState { return this.#world().layerState(this.ref.id); }

  activate(): void { this.#world().setLayerState(this.ref.id, 'active'); }
  deactivate(): void { this.#world().setLayerState(this.ref.id, 'loaded'); }
  unload(): void { this.#world().setLayerState(this.ref.id, 'unloaded'); }

  toString(): string { return `WorldLayer(${this.ref.id})`; }
}

/** `ctx.world.layer(ref)`. */
export function worldLayer(kernel: Kernel, ref: unknown): WorldLayer {
  if (!(ref instanceof WorldLayerRef)) {
    fail('PP3630', `world.layer() takes a world layer (WorldLayers.<id>), got ${ref === null || ref === undefined ? 'None' : String(ref)}`, {
      fix: 'Pass a handle from `from project import WorldLayers`.',
    });
  }
  return new WorldLayer(kernel, ref);
}

/** The core streaming plugin (every game; it acts only in scenes with a world.json). */
export function coreStreaming(): KernelPlugin {
  return streaming();
}
