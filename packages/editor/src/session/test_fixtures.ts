/**
 * Games for this package's tests: a small 3D scene (a camera, crates with a behavior, a
 * prefab with a child, a grid row) and a 2D one, with their logic declared in TypeScript
 * the way compiled game code declares it.
 */

import {
  Behavior, behavior, close_panel, Game, kw, Panel, param, resetDeclarations, rt, SceneRef, state, system, System, ui,
} from '@parallax/runtime/api';
import type { Context, Entity } from '@parallax/runtime/api';
import { Quat, Vec3 } from '@parallax/runtime/core';
import type { ProjectFiles, View3d } from '@parallax/runtime/core';
import { invert, multiply, perspective, viewMatrix } from '@parallax/runtime/resource';
import { view3d } from './view_math.js';
import type { ScreenView } from './view_math.js';

/** A perspective view of an 800×600 surface from `eye` looking at `target`, built independently of any game. */
export function lookAt(eye: Vec3, target: Vec3, fov = 60, near = 0.1, far = 1000): ScreenView {
  const q = Quat.look_rotation(target.__sub__(eye));
  const r = q.rotate(Vec3.RIGHT); const u = q.rotate(Vec3.UP); const f = q.rotate(Vec3.FORWARD);
  const view = viewMatrix([eye.x, eye.y, eye.z], [r.x, r.y, r.z], [u.x, u.y, u.z], [f.x, f.y, f.z]);
  const projection = perspective(fov, 800 / 600, near, far);
  const vp = multiply(projection, view);
  const v: View3d = {
    camera: 1, viewport: { x: 0, y: 0, width: 800, height: 600 }, position: [eye.x, eye.y, eye.z],
    right: [r.x, r.y, r.z], up: [u.x, u.y, u.z], forward: [f.x, f.y, f.z], view, projection, viewProjection: vp,
    inverseViewProjection: invert(vp)!, near, far, clear: null, colorVision: 'none',
  };
  return view3d(v);
}

export function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, typeof v === 'string' ? v : `${JSON.stringify(v, null, 2)}\n`]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

export const DATA_3D: Record<string, unknown> = {
  'prefabs/camera.prefab.json': { components: { camera: { rig: 'fixed', fov: 60 } } },
  'prefabs/crate.prefab.json': { components: { shape: { kind: 'box', color: [0.8, 0.5, 0.2, 1] } }, behaviors: { spinner: { speed: 1 } } },
  'prefabs/tower.prefab.json': {
    components: { shape: { kind: 'box', size: [1, 2, 1] } },
    children: [{ name: 'top', at: [0, 2, 0], components: { shape: { kind: 'sphere' } } }],
  },
  'ui/hud.html': '<div><span data-text="score"></span><button data-action="dismiss">OK</button></div>',
  'scenes/main/scene.json': {
    ui: ['hud'],
    entities: [
      // Looks down at the origin from behind (pitch atan(5/10) ≈ 26.565°).
      { prefab: 'camera', id: 'camera', at: [0, 5, -10], rotation: [26.56505, 0, 0] },
      { prefab: 'crate', id: 'a', at: [0, 0, 0] },
      { prefab: 'crate', at: [3, 0, 0] },
      { prefab: 'tower', id: 'tower', at: [-3, 0, 0] },
      { prefab: 'crate', grid: { cols: 2, rows: 1, spacing: [1.5, 1], origin: [-1, 0, 4] } },
    ],
  },
};

/** What the test game's logic did (start / update calls), to see edit mode run nothing. */
export const LOG: string[] = [];

/** Declare the 3D game's logic; `version` 2 is the "edited code" a hot reload picks up. */
export function declare3d(version = 1): Readonly<Record<string, unknown>> {
  resetDeclarations();
  class Spinner extends Behavior {
    static __annotations__ = { speed: () => rt.float, ticks: () => rt.int };
    static speed = param(1);
    static ticks = state(0);
    declare speed: number;
    declare ticks: number;
    declare entity: Entity;
    start() { LOG.push(`start v${version}`); }
    update(_ctx: Context, _dt: number) { this.ticks += version === 1 ? 1 : 100; }
  }
  behavior('spinner')(Spinner);
  class Director extends System {
    start() { LOG.push('director'); }
  }
  system('director')(Director);
  ui('hud', kw({ html: 'ui/hud.html' }))(class Hud extends Panel {
    static override actions: unknown = { dismiss: close_panel() };
    override state(): unknown { return { score: 3 }; }
  });
  return { game: new Game(kw({ id: 'boxes', title: 'Boxes', sdk: '1.0', start_scene: new SceneRef('main'), mode: '3d', systems: [Director] })) };
}

export const DATA_2D: Record<string, unknown> = {
  'prefabs/camera.prefab.json': { components: { camera: { mode: 'orthographic', size: 5 } } },
  'prefabs/block.prefab.json': { z: 1, components: { shape: { kind: 'rect', size: [2, 1, 1] } } },
  'prefabs/coin.prefab.json': { z: 2, components: { shape: { kind: 'circle', size: [1, 1, 1] } } },
  'scenes/main/scene.json': {
    entities: [
      { prefab: 'camera', at: [0, 0] },
      { prefab: 'block', id: 'block', at: [2, 1] },
      { prefab: 'coin', id: 'coin', at: [2, 1] },
      { prefab: 'block', at: [-3, -2], rotation: 90 },
    ],
  },
};

export function declare2d(): Readonly<Record<string, unknown>> {
  resetDeclarations();
  return { game: new Game(kw({ id: 'flat', title: 'Flat', sdk: '1.0', start_scene: new SceneRef('main'), mode: '2d' })) };
}
