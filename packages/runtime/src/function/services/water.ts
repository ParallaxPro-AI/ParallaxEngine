/**
 * The water services: the water volumes the water plugin keeps (lakes, pools, rivers, the
 * sea), as other plugins need them. `water` answers "what water is here" (characters swim in
 * it); `water_world` lists the bodies with their waves and the splashes and wakes on them
 * (render3d draws them; vehicles read how deep a hull sits). Provided by the water plugin
 * (`kernel.service(...)`, looked up at use); this file is the interface it implements.
 * Positions are world meters, velocities m/s.
 */

import type { EntityId, Vec3 } from '../../core/index.js';
import { serviceKey } from '../kernel/index.js';
import type { ServiceKey } from '../kernel/index.js';

export interface WaterSample {
  /** World y of the water surface above (or at) the point, waves included, now. */
  readonly surface: number;
  /** The water's own velocity there (currents, rivers); zero in still water. */
  readonly flow: Vec3;
}

export interface WaterSource {
  /**
   * The water at a point's x, z whose volume contains it or lies below its surface —
   * undefined when the point is in no water volume (dry land, above every surface it isn't
   * over, or under a volume's floor). Deterministic for a given game time.
   */
  sample(point: Vec3): WaterSample | undefined;
}

export const WATER_SERVICE: ServiceKey<WaterSource> = serviceKey<WaterSource>(
  'water', 'Swimming happens in water volumes: add the water plugin to Game(plugins=[...]).',
);

// ── The water world: bodies, waves and disturbances (render3d, vehicles, gameplay) ──

/** One water body as the water plugin has it (see the water plugin's bodies.ts for kinds). */
export interface WaterBodyInfo {
  /** Null for the terrain's own water (its `water_level`). */
  readonly entity: EntityId | null;
  readonly kind: 'ocean' | 'lake' | 'pool' | 'river';
  /** World y of the still surface (rivers: their course's heights instead). */
  readonly level: number;
  readonly center: Vec3;
  /** Lakes and pools: half size along the body's own x and z, its yaw (radians) and outline. */
  readonly halfX: number;
  readonly halfZ: number;
  readonly yaw: number;
  readonly shape: 'rect' | 'ellipse';
  readonly depth: number;
  /** The Gerstner waves now (weather wind applied), `WAVE_FLOATS` per wave. */
  readonly waves: Float32Array;
  /** sRGB, deep water and shallows. */
  readonly deep: readonly [number, number, number];
  readonly shallow: readonly [number, number, number];
  readonly clarity: number;
  readonly foam: number;
  readonly caustics: number;
  /** 0..2: small-ripple strength. */
  readonly ripple: number;
  /** Meters over which the surface calms to a mirror; 0: never. */
  readonly calmDistance: number;
  /** Rivers: the smoothed course (world x, y, z per point) and its width and mean flow. */
  readonly course: { readonly xs: Float64Array; readonly ys: Float64Array; readonly zs: Float64Array } | null;
  readonly width: number;
  readonly flow: number;
  /** Changes when the body is rebuilt (moved, its fields changed). */
  readonly version: number;
}

/** A splash or a wake on the surface: a ring of foam that spreads and fades. */
export interface WaterDisturbance {
  readonly kind: 'splash' | 'wake';
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Game time it started. */
  readonly start: number;
  /** 0..1. */
  readonly strength: number;
}

/** Seconds a disturbance lasts: a splash's ring and spray, a wake's foam. */
export const SPLASH_SECONDS = 2.5;
export const WAKE_SECONDS = 5;

export interface WaterWorld {
  bodies(): readonly WaterBodyInfo[];
  /** Live disturbances, oldest first. */
  disturbances(): readonly WaterDisturbance[];
  /** The surface height over (x, z) now, waves included; undefined over dry land. */
  heightAt(x: number, z: number): number | undefined;
  /** A Buoyancy body's submerged fraction (0..1) after the last step; undefined without Buoyancy. */
  submerged(entity: EntityId): number | undefined;
  /** Make a splash at a point on the surface (0..1 strength). */
  splash(point: Vec3, strength: number): void;
}

export const WATER_WORLD_SERVICE: ServiceKey<WaterWorld> = serviceKey<WaterWorld>(
  'water_world', 'Water bodies come from the water plugin: add water() to Game(plugins=[...]).',
);

/** The water's disturbances as plain data, for replication (net): also provided by the water plugin. */
export interface WaterSync {
  /** How many disturbances were ever made here (a count that only grows; a restore sets it back). */
  readonly made: number;
  /** The live disturbances made after the first `after`, oldest first. */
  since(after: number): readonly WaterDisturbance[];
  /** Take over disturbances a server made (a client draws them as its own). */
  follow(disturbances: readonly WaterDisturbance[]): void;
}

export const WATER_SYNC_SERVICE: ServiceKey<WaterSync> = serviceKey<WaterSync>(
  'water_sync', 'Add water() to Game(plugins=[...]).',
);
