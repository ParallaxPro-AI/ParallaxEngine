/**
 * `parallax.conveyors` (sdk/parallax/conveyors.pyi): `ConveyorsApi`, the type of
 * `ctx.conveyors`, and the `conveyors()` plugin factory (`parallax.plugins.conveyors`). The
 * lanes live in the conveyors plugin (function/plugins/conveyors); this module binds
 * Python arguments.
 */

import { fail, Vec3 } from '../core/index.js';
import type { KernelPlugin } from '../function/kernel/index.js';
import { conveyors as conveyorsPlugin } from '../function/plugins/conveyors/index.js';
import type { ConveyorNet } from '../function/plugins/conveyors/index.js';
import { refString } from '../resource/index.js';
import { bindArgs } from './kwargs.js';

function describe(value: unknown): string {
  return value === null || value === undefined ? 'None' : typeof value === 'string' ? JSON.stringify(value) : String(value);
}

function num(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail('PP3911', `${what} must be a number, got ${describe(value)}`);
  return value;
}

function laneId(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) fail('PP3911', `conveyors.${where}() lane must be a lane id from conveyors.lane(), got ${describe(value)}`);
  return value;
}

function kindOf(value: unknown, where: string): string {
  if (typeof value !== 'string' || value === '') fail('PP3911', `conveyors.${where}() kind must be a non-empty str, got ${describe(value)}`);
  return value;
}

/** `ctx.conveyors`: conveyor lanes and the items riding them. */
export class ConveyorsApi {
  readonly #net: ConveyorNet;

  constructor(net: ConveyorNet) {
    this.#net = net;
  }

  /** How items of `kind` look on lanes: a model, its scale, and how high above the lane it rides. */
  look(...args: unknown[]): void {
    const a = bindArgs('look', args, { positional: ['kind', 'model'], keyword: ['scale', 'lift'], required: ['kind', 'model'] }).args;
    const kind = kindOf(a['kind'], 'look');
    const model = refString(a['model'], 'conveyors.look() model');
    const scale = a['scale'] === undefined ? 1 : num(a['scale'], 'conveyors.look() scale');
    const lift = a['lift'] === undefined ? 0 : num(a['lift'], 'conveyors.look() lift');
    this.#net.look(kind, { model, scale, lift });
  }

  /** A new lane through `points`; returns its id. */
  lane(...args: unknown[]): number {
    const a = bindArgs('lane', args, { positional: ['points'], keyword: ['speed', 'spacing', 'visible'], required: ['points'] }).args;
    const points = a['points'];
    if (!Array.isArray(points)) fail('PP3911', `conveyors.lane() points must be a list of Vec3, got ${describe(points)}`);
    const pts = points.map((p, i): [number, number, number] => {
      if (!(p instanceof Vec3)) fail('PP3911', `conveyors.lane() point ${i} must be a Vec3, got ${describe(p)}`);
      return [p.x, p.y, p.z];
    });
    const speed = a['speed'] === undefined ? 1 : num(a['speed'], 'conveyors.lane() speed');
    const spacing = a['spacing'] === undefined ? 0.25 : num(a['spacing'], 'conveyors.lane() spacing');
    const visible = a['visible'] === undefined ? true : a['visible'] === true;
    return this.#net.lane(pts, { speed, spacing, visible });
  }

  remove(...args: unknown[]): string[] {
    const a = bindArgs('remove', args, { positional: ['lane'], required: ['lane'] }).args;
    return this.#net.remove(laneId(a['lane'], 'remove'));
  }

  exists(...args: unknown[]): boolean {
    const a = bindArgs('exists', args, { positional: ['lane'], required: ['lane'] }).args;
    return this.#net.has(laneId(a['lane'], 'exists'));
  }

  clear(...args: unknown[]): void {
    bindArgs('clear', args, {});
    this.#net.clear();
  }

  connect(...args: unknown[]): void {
    const a = bindArgs('connect', args, { positional: ['lane', 'to'], keyword: ['at'], required: ['lane', 'to'] }).args;
    const to = a['to'];
    this.#net.connect(laneId(a['lane'], 'connect'), to === null ? null : laneId(to, 'connect'), a['at'] === undefined ? 0 : num(a['at'], 'conveyors.connect() at'));
  }

  set_speed(...args: unknown[]): void {
    const a = bindArgs('set_speed', args, { positional: ['lane', 'speed'], required: ['lane', 'speed'] }).args;
    this.#net.setSpeed(laneId(a['lane'], 'set_speed'), num(a['speed'], 'conveyors.set_speed() speed'));
  }

  set_visible(...args: unknown[]): void {
    const a = bindArgs('set_visible', args, { positional: ['lane', 'visible'], required: ['lane', 'visible'] }).args;
    this.#net.setVisible(laneId(a['lane'], 'set_visible'), a['visible'] === true);
  }

  length(...args: unknown[]): number {
    const a = bindArgs('length', args, { positional: ['lane'], required: ['lane'] }).args;
    return this.#net.length(laneId(a['lane'], 'length'));
  }

  room(...args: unknown[]): boolean {
    const a = bindArgs('room', args, { positional: ['lane'], keyword: ['at'], required: ['lane'] }).args;
    return this.#net.room(laneId(a['lane'], 'room'), a['at'] === undefined ? 0 : num(a['at'], 'conveyors.room() at'));
  }

  push(...args: unknown[]): boolean {
    const a = bindArgs('push', args, { positional: ['lane', 'kind'], keyword: ['at'], required: ['lane', 'kind'] }).args;
    return this.#net.push(laneId(a['lane'], 'push'), kindOf(a['kind'], 'push'), a['at'] === undefined ? 0 : num(a['at'], 'conveyors.push() at'));
  }

  front(...args: unknown[]): string | null {
    const a = bindArgs('front', args, { positional: ['lane'], required: ['lane'] }).args;
    return this.#net.front(laneId(a['lane'], 'front'));
  }

  pop(...args: unknown[]): string | null {
    const a = bindArgs('pop', args, { positional: ['lane'], required: ['lane'] }).args;
    return this.#net.pop(laneId(a['lane'], 'pop'));
  }

  take(...args: unknown[]): string | null {
    const a = bindArgs('take', args, { positional: ['lane'], keyword: ['near', 'reach', 'kinds'], required: ['lane'] }).args;
    const kinds = a['kinds'];
    let wanted: string[] | null = null;
    if (kinds !== undefined && kinds !== null) {
      if (!Array.isArray(kinds)) fail('PP3911', `conveyors.take() kinds must be a list of str, got ${describe(kinds)}`);
      wanted = kinds.map((k) => kindOf(k, 'take'));
    }
    const lane = laneId(a['lane'], 'take');
    const near = a['near'] === undefined ? this.#net.length(lane) : num(a['near'], 'conveyors.take() near');
    const reach = a['reach'] === undefined ? 0.5 : num(a['reach'], 'conveyors.take() reach');
    return this.#net.take(lane, near, reach, wanted);
  }

  items(...args: unknown[]): string[] {
    const a = bindArgs('items', args, { positional: ['lane'], required: ['lane'] }).args;
    return this.#net.items(laneId(a['lane'], 'items'));
  }

  positions(...args: unknown[]): number[] {
    const a = bindArgs('positions', args, { positional: ['lane'], required: ['lane'] }).args;
    return this.#net.positions(laneId(a['lane'], 'positions'));
  }

  count(...args: unknown[]): number {
    const a = bindArgs('count', args, { positional: ['lane'] }).args;
    const lane = a['lane'];
    return this.#net.count(lane === undefined || lane === null ? null : laneId(lane, 'count'));
  }

  point(...args: unknown[]): Vec3 {
    const a = bindArgs('point', args, { positional: ['lane', 'at'], required: ['lane', 'at'] }).args;
    const [x, y, z] = this.#net.point(laneId(a['lane'], 'point'), num(a['at'], 'conveyors.point() at'));
    return new Vec3(x, y, z);
  }

  get lanes(): number {
    return this.#net.laneCount;
  }
}

/** `parallax.plugins.conveyors()`. */
export function conveyors(...args: unknown[]): KernelPlugin {
  bindArgs('conveyors', args, {});
  const plugin = conveyorsPlugin();
  return { ...plugin, namespace: { name: 'conveyors', create: () => new ConveyorsApi(plugin.net) } };
}
