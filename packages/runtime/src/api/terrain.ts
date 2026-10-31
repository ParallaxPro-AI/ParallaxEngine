/**
 * `parallax.terrain` (sdk/parallax/terrain.pyi): `TerrainApi`, the type of `ctx.terrain`,
 * and the `terrain()` plugin factory (`parallax.plugins.terrain`). The field itself lives
 * in the terrain plugin and its `terrain` service; this module binds Python arguments.
 */

import { closestMatch, fail, Vec3 } from '../core/index.js';
import type { Kernel, KernelPlugin } from '../function/kernel/index.js';
import { terrain as terrainPlugin } from '../function/plugins/terrain/index.js';
import { TERRAIN_SERVICE } from '../function/services/index.js';
import type { TerrainEdit, TerrainField } from '../function/services/index.js';
import { bindArgs } from './kwargs.js';

function coordinate(value: unknown, where: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return fail('PP3202', `${where} must be a number, got ${value === null || value === undefined ? 'None' : String(value)}`);
}

function point(value: unknown, where: string): Vec3 {
  if (value instanceof Vec3) return value;
  return fail('PP3202', `${where} must be a Vec3, got ${value === null || value === undefined ? 'None' : String(value)}`);
}

function optionalNumber(value: unknown, fallback: number, where: string): number {
  return value === undefined || value === null ? fallback : coordinate(value, where);
}

/** `ctx.terrain`: questions about the current scene's ground, and changes to it. */
export class TerrainApi {
  readonly #kernel: Kernel;

  constructor(kernel: Kernel) {
    this.#kernel = kernel;
  }

  #field(what: string): TerrainField {
    const field = this.#kernel.service(TERRAIN_SERVICE).current();
    if (field === null) {
      fail('PP3204', `ctx.terrain.${what}: scene "${this.#kernel.scene?.id ?? '?'}" has no terrain`, {
        fix: 'Add a "terrain" block to the scene, or only ask about terrain in scenes that have one.',
      });
    }
    return field;
  }

  /** The column a point query reads: `name(point)`, the point's y ignored. */
  #xz(name: string, args: readonly unknown[]): [number, number] {
    const p = point(bindArgs(name, args, { positional: ['point'], required: ['point'] }).args['point'], `${name}() point`);
    return [p.x, p.z];
  }

  #layer(field: TerrainField, value: unknown, where: string): number {
    const names = field.layers.map((l) => l.name);
    if (typeof value !== 'string' || !names.includes(value)) {
      const guess = typeof value === 'string' ? closestMatch(value, names) : undefined;
      fail('PP3206', `${where}: ${value === null || value === undefined ? 'None' : JSON.stringify(value)} is not one of the terrain's layers`, {
        fix: guess === undefined ? `Use one of: ${names.join(', ')}.` : `Did you mean "${guess}"?`,
      });
    }
    return names.indexOf(value);
  }

  #optionalLayer(field: TerrainField, value: unknown, where: string): number | null {
    return value === undefined || value === null ? null : this.#layer(field, value, where);
  }

  #edit(edit: TerrainEdit): void {
    this.#kernel.service(TERRAIN_SERVICE).deform(edit);
  }

  contains(...args: unknown[]): boolean {
    const [x, z] = this.#xz('contains', args);
    return this.#field('contains').contains(x, z);
  }

  height_at(...args: unknown[]): number {
    const [x, z] = this.#xz('height_at', args);
    return this.#field('height_at').heightAt(x, z);
  }

  normal_at(...args: unknown[]): Vec3 {
    const [x, z] = this.#xz('normal_at', args);
    return this.#field('normal_at').normalAt(x, z);
  }

  surface_at(...args: unknown[]): string {
    const [x, z] = this.#xz('surface_at', args);
    return this.#field('surface_at').surfaceAt(x, z);
  }

  weight_at(...args: unknown[]): number {
    const a = bindArgs('weight_at', args, { positional: ['point', 'layer'], required: ['point', 'layer'] }).args;
    const p = point(a['point'], 'weight_at() point');
    const field = this.#field('weight_at');
    return field.weightAt(p.x, p.z, this.#layer(field, a['layer'], 'weight_at() layer'));
  }

  ground(...args: unknown[]): Vec3 {
    const p = point(bindArgs('ground', args, { positional: ['point'], required: ['point'] }).args['point'], 'ground() point');
    return this.#field('ground').ground(p);
  }

  is_hole(...args: unknown[]): boolean {
    const [x, z] = this.#xz('is_hole', args);
    return this.#field('is_hole').holeAt(x, z);
  }

  brush_at(...args: unknown[]): string | null {
    const p = point(bindArgs('brush_at', args, { positional: ['point'], required: ['point'] }).args['point'], 'brush_at() point');
    return this.#field('brush_at').brushAt(p.x, p.y, p.z)?.id ?? null;
  }

  hidden_by_brush(...args: unknown[]): boolean {
    const a = bindArgs('hidden_by_brush', args, { positional: ['viewer', 'target'], required: ['viewer', 'target'] }).args;
    const viewer = point(a['viewer'], 'hidden_by_brush() viewer');
    const target = point(a['target'], 'hidden_by_brush() target');
    const field = this.#field('hidden_by_brush');
    const hiding = field.brushAt(target.x, target.y, target.z);
    return hiding !== null && field.brushAt(viewer.x, viewer.y, viewer.z) !== hiding;
  }

  crater(...args: unknown[]): void {
    const a = bindArgs('crater', args, { positional: ['center', 'radius'], keyword: ['depth', 'rim', 'layer'], required: ['center', 'radius'] }).args;
    const field = this.#field('crater');
    const center = point(a['center'], 'crater() center');
    const radius = coordinate(a['radius'], 'crater() radius');
    this.#edit({
      kind: 'crater', x: center.x, z: center.z, radius,
      depth: optionalNumber(a['depth'], radius * 0.4, 'crater() depth'),
      rim: optionalNumber(a['rim'], 0, 'crater() rim'),
      layer: this.#optionalLayer(field, a['layer'], 'crater() layer'),
    });
  }

  trench(...args: unknown[]): void {
    const a = bindArgs('trench', args, { positional: ['start', 'end', 'width', 'depth'], keyword: ['feather', 'layer'], required: ['start', 'end', 'width', 'depth'] }).args;
    const field = this.#field('trench');
    const start = point(a['start'], 'trench() start');
    const end = point(a['end'], 'trench() end');
    this.#edit({
      kind: 'trench', x: start.x, z: start.z, x2: end.x, z2: end.z,
      width: coordinate(a['width'], 'trench() width'), depth: coordinate(a['depth'], 'trench() depth'),
      feather: optionalNumber(a['feather'], 1, 'trench() feather'),
      layer: this.#optionalLayer(field, a['layer'], 'trench() layer'),
    });
  }

  flatten(...args: unknown[]): void {
    const a = bindArgs('flatten', args, { positional: ['center', 'radius'], keyword: ['height', 'feather'], required: ['center', 'radius'] }).args;
    const field = this.#field('flatten');
    const center = point(a['center'], 'flatten() center');
    this.#edit({
      kind: 'flatten', x: center.x, z: center.z, radius: coordinate(a['radius'], 'flatten() radius'),
      height: a['height'] === undefined || a['height'] === null ? field.heightAt(center.x, center.z) : coordinate(a['height'], 'flatten() height'),
      feather: optionalNumber(a['feather'], 2, 'flatten() feather'),
    });
  }

  cut_hole(...args: unknown[]): void {
    const a = bindArgs('cut_hole', args, { positional: ['center', 'radius'], required: ['center', 'radius'] }).args;
    this.#field('cut_hole');
    const center = point(a['center'], 'cut_hole() center');
    this.#edit({ kind: 'hole', x: center.x, z: center.z, radius: coordinate(a['radius'], 'cut_hole() radius') });
  }
}

/** `parallax.plugins.terrain()`. */
export function terrain(...args: unknown[]): KernelPlugin {
  bindArgs('terrain', args, {});
  return { ...terrainPlugin(), namespace: { name: 'terrain', create: (kernel) => new TerrainApi(kernel) } };
}
