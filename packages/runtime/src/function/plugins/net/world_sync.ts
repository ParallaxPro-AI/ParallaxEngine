/**
 * World state outside entities that a client must mirror: the ground's edits (craters,
 * trenches, flattening, holes: the terrain service's edit list), felled foliage (the
 * foliage service's removed instances), the wind's ramp (`wind.set`), the weather's and the
 * environment's course (`weather.set`, strikes, preset blends; time of day, sky, fog, post
 * and cloud changes: services/sync.ts) and the water's splashes and wakes. The server sends
 * each client what it hasn't had yet with the reliable state — everything after a full
 * sync (a new client, a scene change) — and the client applies it through the same
 * services, so its terrain, foliage and wind are built from the same calls as the server's.
 *
 * Wind is a pure function of its ramp and game time, which clients follow; terrain edits
 * are deterministic, so the client's ground ends up bit-identical to the server's.
 */

import type { Json, JsonObject } from '../../../resource/index.js';
import type { Kernel } from '../../kernel/index.js';
import {
  ENVIRONMENT_SYNC_SERVICE, FOLIAGE_SERVICE, TERRAIN_SERVICE, WATER_SYNC_SERVICE, WEATHER_SYNC_SERVICE, WIND_SYNC_SERVICE,
} from '../../services/index.js';
import type { CourseSync, TerrainEdit, WaterDisturbance, WindRamp } from '../../services/index.js';
import type { ServiceKey } from '../../kernel/index.js';

/** The `world` part of a state message. */
export interface WorldJson {
  /** Terrain edits after the ones already sent, in order. */
  readonly terrain?: readonly TerrainEdit[];
  /** Foliage instances removed since the last state: [layer id, index]. */
  readonly foliage?: readonly (readonly [string, number])[];
  /** The wind's ramp, when it changed. */
  readonly wind?: WindRamp;
  /** The weather's and the environment's state, when their course changed. */
  readonly weather?: Json;
  readonly environment?: Json;
  /** Splashes and wakes made since the last state. */
  readonly water?: readonly WaterDisturbance[];
}

interface Sent {
  terrain: number;
  readonly foliage: Set<string>;
  wind: string;
  weather: number;
  environment: number;
  water: number;
}

const COURSES = [['weather', WEATHER_SYNC_SERVICE], ['environment', ENVIRONMENT_SYNC_SERVICE]] as const satisfies readonly (readonly [string, ServiceKey<CourseSync>])[];

/** The server side: what each client view has been sent. */
export class WorldSender {
  readonly #kernel: Kernel;
  readonly #sent = new WeakMap<object, Sent>();
  #removed: { revision: number; list: [string, number][] } | undefined;

  constructor(kernel: Kernel) {
    this.#kernel = kernel;
  }

  /** What `view` still needs; `full`: it is starting over (new client, new scene). Undefined: nothing. */
  build(view: object, full: boolean): WorldJson | undefined {
    let sent = this.#sent.get(view);
    if (sent === undefined || full) {
      sent = { terrain: 0, foliage: new Set(), wind: '', weather: -1, environment: -1, water: -1 };
      this.#sent.set(view, sent);
    }
    const out: {
      terrain?: TerrainEdit[]; foliage?: [string, number][]; wind?: WindRamp; weather?: Json; environment?: Json; water?: WaterDisturbance[];
    } = {};
    const terrain = this.#kernel.tryService(TERRAIN_SERVICE);
    if (terrain !== undefined && terrain.current() !== null) {
      const edits = terrain.edits();
      if (edits.length < sent.terrain) sent.terrain = 0; // rebuilt under us (a restore): resend
      if (edits.length > sent.terrain) {
        out.terrain = edits.slice(sent.terrain);
        sent.terrain = edits.length;
      }
    }
    const foliage = this.#kernel.tryService(FOLIAGE_SERVICE);
    if (foliage !== undefined) {
      const fresh = this.#removedNow(foliage.revision, () => {
        const list: [string, number][] = [];
        for (const layer of foliage.layers()) for (let k = 0; k < layer.count; k++) if (layer.alive[k] === 0) list.push([layer.id, k]);
        return list;
      }).filter(([layer, index]) => !sent!.foliage.has(`${layer}\u0000${index}`));
      if (fresh.length > 0) {
        for (const [layer, index] of fresh) sent.foliage.add(`${layer}\u0000${index}`);
        out.foliage = fresh;
      }
    }
    const wind = this.#kernel.tryService(WIND_SYNC_SERVICE);
    if (wind !== undefined) {
      const ramp = wind.ramp();
      const key = JSON.stringify(ramp);
      if (key !== sent.wind) {
        sent.wind = key;
        out.wind = ramp;
      }
    }
    for (const [key, service] of COURSES) {
      const course = this.#kernel.tryService(service);
      if (course === undefined || course.revision === sent[key]) continue;
      sent[key] = course.revision;
      out[key] = course.state();
    }
    const water = this.#kernel.tryService(WATER_SYNC_SERVICE);
    if (water !== undefined) {
      // A new view gets the live ones; a restore that set the count back resends what is live.
      if (sent.water < 0 || water.made < sent.water) sent.water = 0;
      const fresh = water.since(sent.water);
      sent.water = water.made;
      if (fresh.length > 0) out.water = [...fresh];
    }
    return Object.keys(out).length === 0 ? undefined : out;
  }

  #removedNow(revision: number, list: () => [string, number][]): [string, number][] {
    if (this.#removed?.revision !== revision) this.#removed = { revision, list: list() };
    return this.#removed.list;
  }
}

/** The client side: apply a state's `world` through this kernel's services. */
export function applyWorld(kernel: Kernel, world: WorldJson): void {
  if (world.terrain !== undefined) {
    const terrain = kernel.service(TERRAIN_SERVICE);
    for (const edit of world.terrain) terrain.deform(edit);
  }
  if (world.foliage !== undefined) {
    const foliage = kernel.service(FOLIAGE_SERVICE);
    const layers = new Map(foliage.layers().map((l) => [l.id, l]));
    for (const [layer, index] of world.foliage) {
      // Gone already (the client's own prediction, or a restore): nothing to do.
      if (layers.get(layer)?.alive[index] === 1) foliage.remove(layer, index);
    }
  }
  if (world.wind !== undefined) kernel.service(WIND_SYNC_SERVICE).follow(world.wind);
  if (world.weather !== undefined) kernel.service(WEATHER_SYNC_SERVICE).follow(world.weather);
  if (world.environment !== undefined) kernel.service(ENVIRONMENT_SYNC_SERVICE).follow(world.environment);
  if (world.water !== undefined) kernel.service(WATER_SYNC_SERVICE).follow(world.water);
}

export function worldJson(world: WorldJson): JsonObject {
  return world as unknown as JsonObject;
}

export function worldOf(json: Json): WorldJson {
  return json as unknown as WorldJson;
}
