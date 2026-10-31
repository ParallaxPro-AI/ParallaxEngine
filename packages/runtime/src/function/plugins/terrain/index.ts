/**
 * terrain — the heightfield declared by a scene's `"terrain"` block (sdk/parallax/
 * terrain.pyi). It bakes the field when such a scene loads and provides it as the
 * `terrain` service (function/services/terrain.ts) for render3d, physics3d, nav, foliage
 * and the hud; the api layer mounts `ctx.terrain` on it.
 *
 * State. The baked field is derived from the scene; what the game changes is the list of
 * deformation edits (craters, trenches, flattening, holes). A snapshot holds that list, and
 * restore rebakes the scene's field and replays it — same bits as before.
 */

import { fail } from '../../../core/index.js';
import type { Json } from '../../../resource/index.js';
import type { Kernel, KernelPlugin } from '../../kernel/index.js';
import type { SceneDoc } from '../../../resource/index.js';
import { JOBS_SERVICE, TERRAIN_GRADING_SERVICE, TERRAIN_SERVICE } from '../../services/index.js';
import type { TerrainEdit, TerrainGradePath, TerrainService } from '../../services/index.js';
import { bakeTerrain, TERRAIN_BAKE } from './bake.js';
import type { TerrainBake } from './bake.js';
import { fieldOf } from './field.js';
import type { Field } from './field.js';
import { readTerrainSpec } from './spec.js';
import type { TerrainSpec } from './spec.js';
import { TilePyramid } from './tiles.js';
import { bakeSplatMap, TERRAIN_SPLAT_MAP } from './splat_map.js';

export { bakeTerrain, Bins, TERRAIN_BAKE, gridNormals, gridOf, HoleMask, Relief, Splat } from './bake.js';
export type { TerrainBake } from './bake.js';
export { CHUNK_QUADS, editCover, Field, fieldOf } from './field.js';
export { DEFAULT_MAX_QUADS, MAX_RESOLUTION, readTerrainSpec } from './spec.js';
export { rayTerrain } from './ray.js';
export type { Brush, Flat, FlatMode, Hill, Paint, Path, SplatRule, TerrainSpec } from './spec.js';
export { bakeTileRelief, morphTargets, paletteOf, pyramidOf, TERRAIN_TILE, TilePyramid } from './tiles.js';
export { bakeSplatMap, paintSplatMap, SPLAT_MAP_CELL, SPLAT_PLANE_LAYERS, splatMapGrid, splatMapWeight, TERRAIN_SPLAT_MAP } from './splat_map.js';
export type { SplatMap, SplatMapInput } from './splat_map.js';
export { GROUND_MATERIALS, groundByAlbedo, groundFor, NAMED_GROUND } from './catalog.js';
export type { GroundMaterial } from './catalog.js';
export type { TileJobInput, TileJobOutput } from './tiles.js';

/** The live field for a spec (bake + field in one step, on this thread). */
export function buildField(spec: TerrainSpec, scene: string, version: number): Field {
  return fieldOf(bakeTerrain(spec), scene, version);
}

/** Checks an edit's numbers (PP3205) before it touches the ground. */
export function checkEdit(edit: TerrainEdit, layers: number): void {
  const bad = (what: string, value: number, rule: string): never =>
    fail('PP3205', `terrain ${edit.kind}: ${what} is ${value}; it ${rule}`, { fix: `Pass a ${what} that ${rule}.` });
  const finite = (what: string, value: number): void => {
    if (!Number.isFinite(value)) bad(what, value, 'must be a finite number');
  };
  finite('x', edit.x);
  finite('z', edit.z);
  if (edit.kind === 'trench') {
    finite('x2', edit.x2);
    finite('z2', edit.z2);
    if (!(edit.width > 0)) bad('width', edit.width, 'must be above 0');
    finite('depth', edit.depth);
    if (!(edit.feather >= 0)) bad('feather', edit.feather, "can't be negative");
  } else {
    if (!(edit.radius > 0)) bad('radius', edit.radius, 'must be above 0');
    if (edit.kind === 'crater') {
      finite('depth', edit.depth);
      finite('rim', edit.rim);
    }
    if (edit.kind === 'flatten') {
      finite('height', edit.height);
      if (!(edit.feather >= 0)) bad('feather', edit.feather, "can't be negative");
    }
  }
  if ((edit.kind === 'crater' || edit.kind === 'trench') && edit.layer !== null && !(Number.isInteger(edit.layer) && edit.layer >= 0 && edit.layer < layers)) {
    bad('layer', edit.layer, `must be a layer index below ${layers}`);
  }
}

export function terrain(): KernelPlugin {
  let field: Field | null = null;
  let spec: TerrainSpec | undefined;
  let tiles: TilePyramid | null = null;
  let edits: TerrainEdit[] = [];
  let version = 0;
  let installedOn: Kernel | undefined;

  /** Paths other plugins ask to grade (race tracks), looked up at bake time. */
  const graded = (scene: SceneDoc): readonly TerrainGradePath[] => installedOn?.tryService(TERRAIN_GRADING_SERVICE)?.paths(scene) ?? [];

  /** Bakes made ahead of time (`prebake`), by scene id. */
  const baked = new Map<string, TerrainBake>();

  const build = (scene: SceneDoc | undefined, replay: readonly TerrainEdit[]): void => {
    tiles?.close();
    tiles = null;
    spec = scene === undefined ? undefined : readTerrainSpec(scene, graded(scene));
    field = spec === undefined ? null : fieldOf(baked.get(scene!.id) ?? bakeTerrain(spec), scene!.id, ++version);
    edits = [];
    if (field !== null) for (const edit of replay) apply(edit);
  };

  const apply = (edit: TerrainEdit): void => {
    if (field === null) {
      fail('PP3204', `terrain ${edit.kind}: scene "${installedOn?.scene?.id ?? '?'}" has no terrain`, {
        fix: 'Add a "terrain" block to the scene, or only change terrain in scenes that have one.',
      });
    }
    checkEdit(edit, field.layers.length);
    field.apply(edit);
    edits.push(edit);
  };

  /** The field a splat-map bake was started for (one per field). */
  let splatFor: Field | null = null;

  const service: TerrainService = {
    current: () => field,
    splatMap() {
      const f = field;
      if (f === null) return null;
      if (f.splatMap === null && splatFor !== f) {
        splatFor = f;
        const input = f.splatMapInput();
        const runner = installedOn?.tryService(JOBS_SERVICE);
        const baked = runner !== undefined ? runner.run(TERRAIN_SPLAT_MAP, input) : Promise.resolve().then(() => bakeSplatMap(input));
        baked.then((map) => {
          if (field === f) f.attachSplatMap(map, edits);
        }, () => {
          // No splat map: renderers keep blending by the vertex weights.
        });
      }
      return f.splatMap === null ? null : { map: f.splatMap, revision: f.splatRevision, key: `${f.scene}:${f.version}` };
    },
    tiles: () => {
      if (field === null || installedOn === undefined) return null;
      tiles ??= new TilePyramid(installedOn, field, spec!);
      return tiles;
    },
    deform: apply,
    edits: () => edits,
    async prebake() {
      const kernel = installedOn;
      const runner = kernel?.tryService(JOBS_SERVICE);
      if (kernel === undefined || runner === undefined) return;
      const scenes = [...kernel.project.scenes.values()].filter((s) => !baked.has(s.id));
      const specs = scenes.map((s) => [s.id, readTerrainSpec(s, graded(s))] as const).filter((e): e is readonly [string, TerrainSpec] => e[1] !== undefined);
      const bakes = await runner.all(TERRAIN_BAKE, specs.map(([, s]) => s));
      specs.forEach(([id], i) => baked.set(id, bakes[i]!));
    },
  };

  return {
    id: 'terrain',
    install(kernel) {
      if (installedOn !== undefined) {
        fail('PP3201', 'This terrain plugin is already installed in another kernel', { fix: 'Call terrain() once per game.' });
      }
      installedOn = kernel;
      kernel.provide(TERRAIN_SERVICE, service);
      kernel.observeScenes({ loading: (scene) => build(scene, []) });
    },
    snapshot: () => (edits.length === 0 ? null : ([...edits] as unknown as Json)),
    restore: (kernel, state) => build(kernel.scene, state === null ? [] : (state as unknown as TerrainEdit[])),
  };
}
