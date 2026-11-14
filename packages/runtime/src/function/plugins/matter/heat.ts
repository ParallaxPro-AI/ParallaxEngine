/**
 * Heat, as plain arithmetic (no kernel), for the matter plugin's Thermal bodies.
 *
 * A body is two lumped nodes: its surface (a `surface_share` of its heat capacity) and its
 * core (the rest), joined by conduction through half its thickness. Everything outside
 * (air, a hot plate, an oil bath, water, a flame, a furnace's air) exchanges heat with the
 * surface; volumetric heating deposits power into both. So a thick block scorches outside
 * long before its middle warms, a thin slice heats through at once, and a block taken off
 * the heat keeps warming at its core.
 *
 * Every exchange between two finite nodes uses the exact two-body solution over the step,
 * q = ΔT · (1 − e^(−G·dt·(1/Ca + 1/Cb))) / (1/Ca + 1/Cb), so a large step or a tiny piece
 * never overshoots (unconditionally stable); a source of fixed temperature is a node of
 * infinite capacity, capped at its power.
 *
 * Water in the surface (`moisture`, kg per kg of the surface layer) holds the surface at
 * 100 °C while it boils off (the latent heat of vaporisation), which is why a wet surface
 * scorches only once it is dry. A body with a `melt_point` absorbs latent heat while it melts and
 * gives it back as it sets again (wax, solder, ice).
 */

export const WATER_LATENT = 2.26e6;
export const WATER_BOIL = 100;

/** Heat moved from a to b (J) in `dt` through conductance `g` (W/K) between capacities ca, cb (J/K). */
export function exchange(ta: number, tb: number, ca: number, cb: number, g: number, dt: number): number {
  if (g <= 0 || ca <= 0 || cb <= 0 || dt <= 0) return 0;
  const inv = 1 / ca + 1 / cb;
  return ((ta - tb) * (1 - Math.exp(-g * dt * inv))) / inv;
}

/** Heat (J) a fixed-temperature source at `ts` gives a node (t, c) in `dt` through `g`, at most `power`·dt. */
export function fromSource(ts: number, t: number, c: number, g: number, dt: number, power: number): number {
  if (g <= 0 || c <= 0 || dt <= 0) return 0;
  const q = (ts - t) * c * (1 - Math.exp((-g * dt) / c));
  if (power <= 0) return 0;
  const cap = power * dt;
  return Math.max(-cap * 4, Math.min(cap, q));
}

export interface Node2 {
  surface: number;
  core: number;
  melted: number;
  moisture: number;
}

export interface BodyHeat {
  readonly mass: number;
  readonly specificHeat: number;
  readonly surfaceShare: number;
  /** Surface ↔ core conductance, W/K. */
  readonly internal: number;
  readonly meltPoint: number | null;
  readonly latentHeat: number;
}

export function capacities(b: BodyHeat): [number, number] {
  const c = Math.max(1e-6, b.mass) * Math.max(1, b.specificHeat);
  const s = Math.min(0.95, Math.max(0.05, b.surfaceShare));
  return [c * s, c * (1 - s)];
}

/**
 * Add `qs` J to the surface and `qc` J to the core, conduct between them for `dt`, then
 * resolve boiling-off of surface water and melting / setting. Mutates `n`.
 */
export function settle(n: Node2, b: BodyHeat, qs: number, qc: number, dt: number): { evaporated: number } {
  const [cs, cc] = capacities(b);
  n.surface += qs / cs;
  n.core += qc / cc;
  const q = exchange(n.surface, n.core, cs, cc, b.internal, dt);
  n.surface -= q / cs;
  n.core += q / cc;
  let evaporated = 0;
  if (n.moisture > 0 && n.surface > WATER_BOIL) {
    const water = n.moisture * b.mass * b.surfaceShare;
    const energy = (n.surface - WATER_BOIL) * cs;
    const boiled = Math.min(water, energy / WATER_LATENT);
    evaporated = boiled;
    n.surface -= (boiled * WATER_LATENT) / cs;
    n.moisture = Math.max(0, n.moisture - boiled / Math.max(1e-9, b.mass * b.surfaceShare));
  }
  if (b.meltPoint !== null && b.latentHeat > 0) {
    const mp = b.meltPoint;
    const total = b.mass * b.latentHeat;
    const share = Math.min(0.95, Math.max(0.05, b.surfaceShare));
    for (const [key, c, w] of [['surface', cs, share], ['core', cc, 1 - share]] as const) {
      const t = n[key];
      if (t > mp && n.melted < 1) {
        const room = (1 - n.melted) * total;
        const e = Math.min((t - mp) * c, room * w * 2, room);
        n[key] = t - e / c;
        n.melted = Math.min(1, n.melted + e / total);
      } else if (t < mp - 1 && n.melted > 0) {
        const e = Math.min((mp - 1 - t) * c, n.melted * total * w * 2, n.melted * total);
        n[key] = t + e / c;
        n.melted = Math.max(0, n.melted - e / total);
      }
    }
  }
  return { evaporated };
}

/** Surface area (m²) and smallest full extent (m) of a box of half extents h. */
export function boxMetrics(h: readonly [number, number, number]): { area: number; thickness: number } {
  const [a, b, c] = [Math.max(1e-4, 2 * h[0]), Math.max(1e-4, 2 * h[1]), Math.max(1e-4, 2 * h[2])];
  return { area: 2 * (a * b + b * c + c * a), thickness: Math.min(a, b, c) };
}

/** Surface ↔ core conductance of a body: conduction through a quarter of its thickness over its area. */
export function internalConductance(conductivity: number, area: number, thickness: number): number {
  return (2 * conductivity * area) / Math.max(1e-4, thickness);
}
