/**
 * Rapier 2D's WASM must be compiled before any world exists. That is async, and the
 * kernel is synchronous, so boot awaits `initPhysics2d()` once before it builds a kernel
 * with this plugin; installing the plugin earlier is an error, not a hang.
 */

import RAPIER from '@dimforge/rapier2d-compat';
import { fail } from '../../../core/index.js';

export type Rapier = typeof RAPIER;

let ready: Promise<void> | undefined;
let initialized = false;

/** Compile Rapier 2D's WASM. Safe to call more than once; every call awaits the same work. */
export function initPhysics2d(): Promise<void> {
  ready ??= RAPIER.init().then(() => {
    initialized = true;
  });
  return ready;
}

export function physics2dReady(): boolean {
  return initialized;
}

/** The Rapier module, once `initPhysics2d()` has resolved. */
export function rapier(): Rapier {
  if (!initialized) {
    fail('PP9100', 'Rapier 2D is not initialized', {
      fix: 'Boot must `await initPhysics2d()` before building a kernel that uses the physics2d plugin.',
    });
  }
  return RAPIER;
}
