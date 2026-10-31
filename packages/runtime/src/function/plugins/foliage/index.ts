/**
 * foliage — the scene's scattered trees, bushes, plants, rocks and models, and its grass
 * (sdk/parallax/foliage.pyi), provided as the `foliage` service (function/services/
 * foliage.ts) for render3d (and physics, for layers that `collide`).
 *
 * Scatter runs on first use after a scene loads (so the terrain it reads is built, whatever
 * the plugin order), deterministically from the scene. When the terrain changes under it
 * (a crater), instances are set back onto the ground. State: the removed instances (felled
 * trees, picked mushrooms), saved by layer id and index.
 */

import { closestMatch, fail } from '../../../core/index.js';
import type { Json } from '../../../resource/index.js';
import type { Kernel, KernelPlugin } from '../../kernel/index.js';
import { CELL_SIZE, FOLIAGE_SERVICE, TERRAIN_SERVICE } from '../../services/index.js';
import type { FoliageHit, FoliageLayer, FoliageService, GrassLayer, TerrainField } from '../../services/index.js';
import { cellBounds, scatter, suitability } from './scatter.js';
import type { Resolved } from './scatter.js';
import { readFoliageSpec } from './spec.js';
import type { FoliageLayerSpec } from './spec.js';

export { cellBounds, scatter, scatterBounds, SOFT_BAND, SOFT_MARGIN, suitability } from './scatter.js';
export type { Resolved, Scattered } from './scatter.js';
export { DEFAULT_PALETTES, defaultSpecies, LOOKS, MAX_INSTANCES, readFoliageSpec } from './spec.js';
export type { FoliageLayerSpec } from './spec.js';

interface Built {
  readonly scene: string;
  readonly terrainVersion: number;
  terrainRevision: number;
  readonly layers: (FoliageLayer & { cells: FoliageLayer['cells'] })[];
  readonly grass: GrassLayer[];
}

/** Terrain layer names a spec names, as indices (PP3230 for names the terrain doesn't have). */
function resolve(spec: FoliageLayerSpec, field: TerrainField | null, scene: string, index: number): Resolved {
  const names = field?.layers.map((l) => l.name) ?? [];
  const look = (list: readonly string[], key: string): number[] => list.map((name, k) => {
    if (field === null) {
      fail('PP3230', `Scene "${scene}" foliage layer "${spec.id}" grows on terrain layers, but the scene has no terrain`, {
        fix: 'Add a "terrain" block (and terrain() to the game), or give the layer an "area" instead of "on"/"avoid".',
        pointer: `/foliage/layers/${index}/${key}${list.length > 1 ? `/${k}` : ''}`,
      });
    }
    const l = names.indexOf(name);
    if (l < 0) {
      const guess = closestMatch(name, names);
      fail('PP3230', `Scene "${scene}" foliage layer "${spec.id}": "${name}" is not one of the terrain's layers`, {
        fix: guess === undefined ? `Use one of: ${names.join(', ')}.` : `Did you mean "${guess}"?`,
        pointer: `/foliage/layers/${index}/${key}`,
      });
    }
    return l;
  });
  if (field === null && spec.area === null) {
    fail('PP3230', `Scene "${scene}" foliage layer "${spec.id}" has no "area" and the scene has no terrain`, {
      fix: 'Give the layer an "area" footprint, or add a terrain.', pointer: `/foliage/layers/${index}`,
    });
  }
  return { on: look(spec.layers, 'on'), avoid: look(spec.avoid, 'avoid') };
}

export function foliage(): KernelPlugin {
  let installedOn: Kernel | undefined;
  let built: Built | null = null;
  let removed = new Map<string, Set<number>>();
  let revision = 0;

  const field = (): TerrainField | null => installedOn?.tryService(TERRAIN_SERVICE)?.current() ?? null;

  const build = (): Built | null => {
    const kernel = installedOn!;
    const scene = kernel.scene;
    if (scene === undefined) return null;
    const terrain = field();
    if (built !== null && built.scene === scene.id && built.terrainVersion === (terrain?.version ?? 0)) {
      if (terrain !== null && terrain.revision !== built.terrainRevision) reground(built, terrain);
      return built;
    }
    const specs = readFoliageSpec(scene);
    const layers: Built['layers'] = [];
    const grass: GrassLayer[] = [];
    specs.forEach((spec, i) => {
      const resolved = resolve(spec, terrain, scene.id, i);
      if (spec.kind === 'grass') {
        grass.push({
          id: spec.id, density: spec.density, bladeHeight: spec.bladeHeight, color: spec.color, sway: spec.sway, radius: spec.drawRadius,
          densityAt: (x, z) => suitability(spec, field(), resolved, x, z, true),
        });
        return;
      }
      const s = scatter(spec, terrain, resolved);
      const alive = new Uint8Array(s.count).fill(1);
      for (const index of removed.get(spec.id) ?? []) if (index < s.count) alive[index] = 0;
      layers.push({
        id: spec.id, kind: spec.kind, species: spec.species, model: spec.model, color: spec.color, sway: spec.sway, collide: spec.collide,
        radius: spec.radius, height: spec.height, count: s.count, x: s.x, y: s.y, z: s.z, yaw: s.yaw, scale: s.scale, alive, cells: s.cells,
      });
    });
    built = { scene: scene.id, terrainVersion: terrain?.version ?? 0, terrainRevision: terrain?.revision ?? 0, layers, grass };
    revision++;
    return built;
  };

  const reground = (b: Built, terrain: TerrainField): void => {
    for (const layer of b.layers) {
      for (let k = 0; k < layer.count; k++) {
        const x = layer.x[k]!;
        const z = layer.z[k]!;
        (layer.y as Float32Array)[k] = terrain.contains(x, z) ? terrain.heightAt(x, z) : 0;
      }
      layer.cells = layer.cells.map((c) => cellBounds(layer, c.start, c.count, Math.round(c.minX / CELL_SIZE), Math.round(c.minZ / CELL_SIZE)));
    }
    b.terrainRevision = terrain.revision;
    revision++;
  };

  const layerById = (id: string): FoliageLayer => {
    const b = build();
    const layer = b?.layers.find((l) => l.id === id);
    if (layer === undefined) {
      const names = b?.layers.map((l) => l.id) ?? [];
      const guess = closestMatch(id, names);
      fail('PP3231', `There is no foliage layer "${id}" in this scene`, { fix: guess === undefined ? `Scatter layers: ${names.join(', ') || '(none)'}.` : `Did you mean "${guess}"?` });
    }
    return layer;
  };

  const service: FoliageService = {
    layers: () => build()?.layers ?? [],
    grass: () => build()?.grass ?? [],
    get revision() {
      build();
      return revision;
    },
    near(x, z, radius, only) {
      if (!(Number.isFinite(x) && Number.isFinite(z) && radius >= 0)) fail('PP3232', `foliage near(${x}, ${z}, ${radius}): give a finite point and a radius of 0 or more`);
      const layers = only === undefined ? build()?.layers ?? [] : [layerById(only)];
      const hits: (FoliageHit & { d: number })[] = [];
      for (const layer of layers) {
        for (const cell of layer.cells) {
          if (x + radius < cell.minX || x - radius > cell.maxX || z + radius < cell.minZ || z - radius > cell.maxZ) continue;
          for (let k = cell.start; k < cell.start + cell.count; k++) {
            if (layer.alive[k] === 0) continue;
            const dx = layer.x[k]! - x;
            const dz = layer.z[k]! - z;
            const d = Math.sqrt(dx * dx + dz * dz);
            if (d <= radius) hits.push({ layer: layer.id, index: k, x: layer.x[k]!, y: layer.y[k]!, z: layer.z[k]!, scale: layer.scale[k]!, d });
          }
        }
      }
      hits.sort((a, b) => a.d - b.d || a.layer.localeCompare(b.layer) || a.index - b.index);
      return hits.map(({ d: _, ...hit }) => hit);
    },
    remove(id, index) {
      const layer = layerById(id);
      if (!(Number.isInteger(index) && index >= 0 && index < layer.count) || layer.alive[index] === 0) {
        fail('PP3231', `foliage "${id}" has no standing instance ${index}`, { fix: 'Remove instances that near() returned, once each.' });
      }
      layer.alive[index] = 0;
      let set = removed.get(id);
      if (set === undefined) removed.set(id, (set = new Set()));
      set.add(index);
      revision++;
    },
  };

  return {
    id: 'foliage',
    install(kernel) {
      if (installedOn !== undefined) fail('PP3233', 'This foliage plugin is already installed in another kernel', { fix: 'Call foliage() once per game.' });
      installedOn = kernel;
      kernel.provide(FOLIAGE_SERVICE, service);
      kernel.observeScenes({
        loading: () => {
          built = null;
          removed = new Map();
        },
      });
    },
    snapshot: () => {
      if (removed.size === 0) return null;
      const out: Record<string, number[]> = {};
      for (const [id, set] of [...removed].sort((a, b) => a[0].localeCompare(b[0]))) out[id] = [...set].sort((a, b) => a - b);
      return out as unknown as Json;
    },
    restore: (_kernel, state) => {
      removed = new Map(Object.entries((state ?? {}) as Record<string, number[]>).map(([id, list]) => [id, new Set(list)]));
      built = null;
      revision++;
    },
  };
}
