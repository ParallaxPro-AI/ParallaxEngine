/**
 * The `landscape` generator (spec.ts documents the data): a pure function of the spec and
 * the cell, so any block can be asked for in any order — a chunk filled whole and a single
 * cell asked alone agree to the bit. Layers, in order: terrain (the relief and its slopes,
 * strata, a slope's surface and spires, bottom, ores, water, galleries / tunnels / caves dug
 * out of it), then ruins, then trees; ruins and trees only fill air.
 */

import { AIR } from './blocks.js';
import type { LandscapeSpec, Ruins, Slope, Trees } from './spec.js';
import { densityFromDistance, ISO } from './smooth.js';

/** 32-bit integer hash of four integers (seeded rolls and lattice values). */
export function hash4(a: number, b: number, c: number, d: number): number {
  let h = 0x811c9dc5 ^ Math.imul(a | 0, 0x9e3779b1);
  h = Math.imul(h ^ (b | 0), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h ^ (c | 0), 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h ^ (d | 0), 0x27d4eb2f);
  h ^= h >>> 15;
  h = Math.imul(h, 0x165667b1);
  h ^= h >>> 13;
  return h >>> 0;
}

/** A roll in [0, 1). */
function unit(h: number): number {
  return h / 4294967296;
}

const smooth = (t: number): number => t * t * (3 - 2 * t);

/** 3D value noise in [0, 1). */
function valueNoise3(x: number, y: number, z: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = smooth(x - ix);
  const fy = smooth(y - iy);
  const fz = smooth(z - iz);
  let sum = 0;
  for (let c = 0; c < 8; c++) {
    const dx = c & 1;
    const dy = (c >> 1) & 1;
    const dz = (c >> 2) & 1;
    const w = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * (dz ? fz : 1 - fz);
    sum += w * unit(hash4(seed, ix + dx, iy + dy, iz + dz));
  }
  return sum;
}

const CAVE_SALT = 0x63617665;

/** The cave field at a cell: two octaves of 3D value noise in [0, 1); caves where it reaches `threshold`. */
export function caveNoise(s: LandscapeSpec, x: number, y: number, z: number): number {
  const f = s.caves!.frequency;
  return (2 * valueNoise3(x * f, y * f, z * f, s.seed ^ CAVE_SALT) + valueNoise3(x * f * 2, y * f * 2, z * f * 2, (s.seed ^ CAVE_SALT) + 1)) / 3;
}

/** The "lattice" family's 2D hash in [0, 1). */
function latticeHash(x: number, y: number, seed: number): number {
  let h = seed | 0;
  h = Math.imul(h ^ (x | 0), 0x27d4eb2d);
  h = Math.imul(h ^ (y | 0), 0x165667b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}

/** The "lattice" family's fbm in [0, 1): smoothstep-blended lattice values, octave seeds seed + 1013 · i. */
export function latticeFbm(x: number, z: number, seed: number, octaves: number, frequency: number): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = frequency;
  for (let i = 0; i < octaves; i++) {
    const px = x * f;
    const pz = z * f;
    const xi = Math.floor(px);
    const zi = Math.floor(pz);
    const u = smooth(px - xi);
    const v = smooth(pz - zi);
    const s = seed + i * 1013;
    const a = latticeHash(xi, zi, s);
    const b = latticeHash(xi + 1, zi, s);
    const c = latticeHash(xi, zi + 1, s);
    const d = latticeHash(xi + 1, zi + 1, s);
    sum += ((a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v) * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

/** 2D value noise in [-1, 1]. */
function valueNoise(x: number, z: number, seed: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = smooth(x - ix);
  const fz = smooth(z - iz);
  const v = (a: number, b: number): number => unit(hash4(seed, a, b, 0x6e6f)) * 2 - 1;
  const top = v(ix, iz) + (v(ix + 1, iz) - v(ix, iz)) * fx;
  const bottom = v(ix, iz + 1) + (v(ix + 1, iz + 1) - v(ix, iz + 1)) * fx;
  return top + (bottom - top) * fz;
}

interface TreeAt {
  readonly x: number;
  readonly z: number;
  /** Surface y under the trunk. */
  readonly ground: number;
  readonly height: number;
}

interface RuinAt {
  readonly x: number;
  readonly z: number;
  readonly ground: number;
}

const TREE_SALT = 0x51ed27;
const RUIN_SALT = 0x2c1b3c6d;
const ORE_SALT = 0x0e5;
const SLOPE_SALT = 0x51095e;
const CRUMBLE = 0.25;

/** x mod m in [0, m). */
const mod = (x: number, m: number): number => ((x % m) + m) % m;

export class Landscape {
  readonly #spec: LandscapeSpec;
  readonly #yMin: number;
  readonly #yMax: number;
  readonly #trees = new Map<string, TreeAt | null>();
  readonly #ruins = new Map<string, RuinAt | null>();

  constructor(spec: LandscapeSpec, yMin: number, yMax: number) {
    this.#spec = spec;
    this.#yMin = yMin;
    this.#yMax = yMax;
  }

  /** The surface block's y (the top of the terrain, before ruins and trees): the hills to a whole
   *  block, then the slopes on top, so a slope lifts the land in whole steps. */
  height(x: number, z: number): number {
    const s = this.#spec;
    const hills = Math.floor(this.#hills(x, z));
    return s.slopes.length === 0 ? hills : Math.floor(hills + this.#slopes(x, z));
  }

  /** The continuous surface height at (x, z): the hills plus the slopes (smooth worlds use it as is). */
  relief(x: number, z: number): number {
    return this.#hills(x, z) + this.#slopes(x, z);
  }

  /** base_height + amplitude · fbm in the spec's noise family. */
  #hills(x: number, z: number): number {
    const s = this.#spec;
    if (s.amplitude === 0) return s.baseHeight;
    if (s.noise === 'lattice') return s.baseHeight + s.amplitude * (2 * latticeFbm(x, z, s.seed, s.octaves, s.frequency) - 1);
    let sum = 0;
    let weight = 0;
    let amp = 1;
    let freq = s.frequency;
    for (let o = 0; o < s.octaves; o++) {
      sum += amp * valueNoise(x * freq, z * freq, s.seed + o * 7919);
      weight += amp;
      amp *= 0.5;
      freq *= 2;
    }
    return s.baseHeight + s.amplitude * (sum / weight);
  }

  /** The slopes' summed rise at (x, z). */
  #slopes(x: number, z: number): number {
    const slopes = this.#spec.slopes;
    let rise = 0;
    for (let i = 0; i < slopes.length; i++) rise += this.#weight(slopes[i]!, i, x, z) * slopes[i]!.rise;
    return rise;
  }

  /** How far into slope `i` (x, z) lies: 0 before `start`, ramping to 1 over `width`, times its broad variation. */
  #weight(slope: Slope, i: number, x: number, z: number): number {
    const along = x * slope.dirX + z * slope.dirZ;
    const ramp = Math.min(1, (along - slope.start) / slope.width);
    if (ramp <= 0) return 0;
    if (slope.variation === 0) return ramp;
    const f = slope.variationFrequency;
    const s = this.#spec;
    const broad = s.noise === 'lattice' ? 2 * latticeFbm(x, z, s.seed + 3907 * (i + 1), 2, f) - 1 : valueNoise(x * f, z * f, s.seed + SLOPE_SALT + i);
    return ramp * (1 + slope.variation * broad);
  }

  /** The surface block a slope puts at (x, z) (its first that claims the column), if any. */
  #slopeSurface(x: number, z: number): number | undefined {
    const slopes = this.#spec.slopes;
    for (let i = 0; i < slopes.length; i++) {
      const slope = slopes[i]!;
      if (slope.surface !== undefined && this.#weight(slope, i, x, z) > slope.surfaceAbove) return slope.surface;
    }
    return undefined;
  }

  /** A slope's spire block at (x, y, z) above a surface at h, or air. */
  #spire(x: number, y: number, z: number, h: number): number {
    const slopes = this.#spec.slopes;
    for (let i = 0; i < slopes.length; i++) {
      const slope = slopes[i]!;
      const sp = slope.spires;
      if (sp === undefined || y > h + sp.height || mod(x, sp.spacingX) >= sp.size || mod(z, sp.spacingZ) >= sp.size) continue;
      if (this.#weight(slope, i, x, z) > slope.surfaceAbove) return sp.block;
    }
    return AIR;
  }

  /** True where a gallery or tunnel is dug out of the ground (`depth` below the surface). */
  #dug(x: number, y: number, z: number, depth: number): boolean {
    const s = this.#spec;
    for (const g of s.galleries) {
      const lx = g.toX - g.fromX;
      const lz = g.toZ - g.fromZ;
      const length = Math.hypot(lx, lz);
      const ux = lx / length;
      const uz = lz / length;
      const t = (x - g.fromX) * ux + (z - g.fromZ) * uz;
      if (t < 0 || t > length || Math.abs((z - g.fromZ) * ux - (x - g.fromX) * uz) > g.width) continue;
      const floor = Math.max(g.lowest, this.height(Math.round(g.fromX + ux * t), Math.round(g.fromZ + uz * t)) - Math.floor(t * g.slope));
      if (y > floor && y <= floor + g.height) return true;
    }
    const tunnels = s.tunnels;
    if (tunnels === undefined || depth < tunnels.minDepth || y <= this.#yMin + 3) return false;
    const half = tunnels.spacing / 2;
    const ty = tunnels.y + Math.sin(x * 0.044 + s.seed) * 3;
    const lane = Math.sin(x * 0.035 + s.seed * 0.01) * 10;
    const dz = mod(z - lane + half, tunnels.spacing) - half;
    if ((y - ty) ** 2 / tunnels.height ** 2 + dz ** 2 / tunnels.width ** 2 < 1) return true;
    if (tunnels.crossY === undefined) return false;
    const dx = mod(x - Math.sin(z * 0.025) * 8 + half, tunnels.spacing) - half;
    return ((y - tunnels.crossY) ** 2 + dx ** 2) / tunnels.crossRadius ** 2 < 1;
  }

  /** The terrain layer alone at (x, y, z) over a column whose surface is `h`. */
  terrain(x: number, y: number, z: number, h: number): number {
    const s = this.#spec;
    if (y < this.#yMin || y >= this.#yMax) return AIR;
    if (y === this.#yMin && s.bottom !== undefined) return s.bottom;
    const shore = s.shore !== undefined && h <= s.seaLevel + s.shoreHeight;
    if (y > h) {
      if (y <= s.seaLevel && s.water !== undefined) return s.water;
      return shore || s.slopes.length === 0 ? AIR : this.#spire(x, y, z, h);
    }
    const depth = h - y;
    if (this.#dug(x, y, z, depth)) return AIR;
    if (s.caves !== undefined && depth >= s.caves.minDepth && caveNoise(s, x, y, z) >= s.caves.threshold) return AIR;
    if (depth === 0 && !shore && s.slopes.length > 0) {
      const surface = this.#slopeSurface(x, z);
      if (surface !== undefined) return surface;
    }
    let top = 0;
    for (const stratum of s.strata) {
      if (stratum.depth === undefined) break;
      top += stratum.depth;
      if (depth < top) return shore ? s.shore! : stratum.block;
    }
    for (let i = 0; i < s.ores.length; i++) {
      const ore = s.ores[i]!;
      if (depth >= ore.minDepth && unit(hash4(s.seed ^ ORE_SALT, x, y, z ^ Math.imul(i + 1, 0x3b9ac9ff))) < ore.chance) return ore.block;
    }
    return s.strata[s.strata.length - 1]!.block;
  }

  /** The generated block at a cell. */
  blockAt(x: number, y: number, z: number): number {
    if (y < this.#yMin || y >= this.#yMax) return AIR;
    const terrain = this.terrain(x, y, z, this.height(x, z));
    if (terrain !== AIR) return terrain;
    const ruin = this.#ruinBlock(x, y, z);
    if (ruin !== AIR) return ruin;
    return this.#treeBlock(x, y, z);
  }

  /**
   * Fill a chunk: `out[(ly * size + lz) * size + lx]` for the block at
   * (x0 + lx, y0 + ly, z0 + lz). Identical to `blockAt` cell by cell.
   */
  fill(x0: number, y0: number, z0: number, size: number, out: Uint16Array): void {
    const heights = new Int32Array(size * size);
    for (let lz = 0; lz < size; lz++) for (let lx = 0; lx < size; lx++) heights[lz * size + lx] = this.height(x0 + lx, z0 + lz);
    for (let ly = 0; ly < size; ly++) {
      for (let lz = 0; lz < size; lz++) {
        for (let lx = 0; lx < size; lx++) {
          out[(ly * size + lz) * size + lx] = this.terrain(x0 + lx, y0 + ly, z0 + lz, heights[lz * size + lx]!);
        }
      }
    }
    const put = (x: number, y: number, z: number, block: number): void => {
      const lx = x - x0;
      const ly = y - y0;
      const lz = z - z0;
      if (lx < 0 || ly < 0 || lz < 0 || lx >= size || ly >= size || lz >= size) return;
      if (y < this.#yMin || y >= this.#yMax) return;
      const i = (ly * size + lz) * size + lx;
      if (out[i] === AIR) out[i] = block;
    };
    const s = this.#spec;
    if (s.ruins !== undefined) {
      const ruins = s.ruins;
      this.#lattice(x0, z0, size, ruins.spacing, (gx, gz) => {
        const ruin = this.#ruin(gx, gz);
        if (ruin !== null) this.#eachRuinCell(ruins, ruin, put);
      });
    }
    if (s.trees !== undefined) {
      const trees = s.trees;
      this.#lattice(x0, z0, size, trees.spacing, (gx, gz) => {
        const tree = this.#tree(gx, gz);
        if (tree !== null) this.#eachTreeCell(trees, tree, put);
      });
    }
  }

  /** Lattice squares of `spacing` overlapping the chunk's x/z range. */
  #lattice(x0: number, z0: number, size: number, spacing: number, visit: (gx: number, gz: number) => void): void {
    const gx0 = Math.floor(x0 / spacing);
    const gx1 = Math.floor((x0 + size - 1) / spacing);
    const gz0 = Math.floor(z0 / spacing);
    const gz1 = Math.floor((z0 + size - 1) / spacing);
    for (let gz = gz0; gz <= gz1; gz++) for (let gx = gx0; gx <= gx1; gx++) visit(gx, gz);
  }

  // ── Trees ────────────────────────────────────────────────────────────────────

  #tree(gx: number, gz: number): TreeAt | null {
    const key = `${gx},${gz}`;
    const cached = this.#trees.get(key);
    if (cached !== undefined) return cached;
    const t = this.#spec.trees!;
    const seed = this.#spec.seed ^ TREE_SALT;
    let tree: TreeAt | null = null;
    if (unit(hash4(seed, gx, gz, 1)) < t.density) {
      const span = t.spacing - 2 * t.radius;
      const x = gx * t.spacing + t.radius + (hash4(seed, gx, gz, 2) % span);
      const z = gz * t.spacing + t.radius + (hash4(seed, gx, gz, 3) % span);
      const ground = this.height(x, z);
      const height = t.minHeight + (hash4(seed, gx, gz, 4) % (t.maxHeight - t.minHeight + 1));
      if (ground > this.#spec.seaLevel && this.terrain(x, ground, z, ground) === t.on) tree = { x, z, ground, height };
    }
    this.#trees.set(key, tree);
    return tree;
  }

  #treeCell(t: Trees, tree: TreeAt, x: number, y: number, z: number): number {
    const top = tree.ground + tree.height;
    const dx = Math.abs(x - tree.x);
    const dz = Math.abs(z - tree.z);
    if (dx === 0 && dz === 0 && y > tree.ground && y <= top) return t.trunk;
    const dy = y - top;
    const r = dy === 1 ? Math.max(t.radius - 1, 0) : t.radius;
    if (dy < -1 || dy > 1 || dx > r || dz > r) return AIR;
    if (r > 0 && dx === r && dz === r) return AIR;
    return t.leaves;
  }

  #eachTreeCell(t: Trees, tree: TreeAt, put: (x: number, y: number, z: number, block: number) => void): void {
    const top = tree.ground + tree.height;
    for (let y = tree.ground + 1; y <= top + 1; y++) {
      for (let z = tree.z - t.radius; z <= tree.z + t.radius; z++) {
        for (let x = tree.x - t.radius; x <= tree.x + t.radius; x++) {
          const block = this.#treeCell(t, tree, x, y, z);
          if (block !== AIR) put(x, y, z, block);
        }
      }
    }
  }

  #treeBlock(x: number, y: number, z: number): number {
    const t = this.#spec.trees;
    if (t === undefined) return AIR;
    const tree = this.#tree(Math.floor(x / t.spacing), Math.floor(z / t.spacing));
    return tree === null ? AIR : this.#treeCell(t, tree, x, y, z);
  }

  // ── Ruins ────────────────────────────────────────────────────────────────────

  #ruin(gx: number, gz: number): RuinAt | null {
    const key = `${gx},${gz}`;
    const cached = this.#ruins.get(key);
    if (cached !== undefined) return cached;
    const r = this.#spec.ruins!;
    const seed = this.#spec.seed ^ RUIN_SALT;
    const half = r.size >> 1;
    let ruin: RuinAt | null = null;
    if (unit(hash4(seed, gx, gz, 1)) < r.chance) {
      const span = r.spacing - 2 * half;
      const x = gx * r.spacing + half + (hash4(seed, gx, gz, 2) % span);
      const z = gz * r.spacing + half + (hash4(seed, gx, gz, 3) % span);
      const ground = this.height(x, z);
      if (ground > this.#spec.seaLevel) ruin = { x, z, ground };
    }
    this.#ruins.set(key, ruin);
    return ruin;
  }

  #ruinCell(r: Ruins, ruin: RuinAt, x: number, y: number, z: number): number {
    const half = r.size >> 1;
    const dx = Math.abs(x - ruin.x);
    const dz = Math.abs(z - ruin.z);
    if (dx > half || dz > half) return AIR;
    if (dx === 0 && dz === 0) return y === ruin.ground + 1 ? r.block : AIR;
    if (dx !== half && dz !== half) return AIR;
    const ground = this.height(x, z);
    if (y <= ground || y > ground + r.height) return AIR;
    return unit(hash4(this.#spec.seed ^ RUIN_SALT, x, y, z)) < CRUMBLE ? AIR : r.walls;
  }

  #eachRuinCell(r: Ruins, ruin: RuinAt, put: (x: number, y: number, z: number, block: number) => void): void {
    const half = r.size >> 1;
    for (let z = ruin.z - half; z <= ruin.z + half; z++) {
      for (let x = ruin.x - half; x <= ruin.x + half; x++) {
        const ground = x === ruin.x && z === ruin.z ? ruin.ground : this.height(x, z);
        for (let y = ground + 1; y <= ground + r.height; y++) {
          const block = this.#ruinCell(r, ruin, x, y, z);
          if (block !== AIR) put(x, y, z, block);
        }
      }
    }
  }

  #ruinBlock(x: number, y: number, z: number): number {
    const r = this.#spec.ruins;
    if (r === undefined) return AIR;
    const ruin = this.#ruin(Math.floor(x / r.spacing), Math.floor(z / r.spacing));
    return ruin === null ? AIR : this.#ruinCell(r, ruin, x, y, z);
  }
}

/**
 * The smooth-mode generator over a landscape spec (smooth.ts documents density): packed
 * `material << 8 | density` per lattice point. Solid points take the landscape's block for
 * their depth below the (continuous) relief; caves carve by their distance into rock.
 */
export class SmoothLandscape {
  readonly #land: Landscape;
  readonly #spec: LandscapeSpec;
  readonly #yMin: number;
  readonly #yMax: number;

  constructor(spec: LandscapeSpec, yMin: number, yMax: number) {
    this.#land = new Landscape(spec, yMin, yMax);
    this.#spec = spec;
    this.#yMin = yMin;
    this.#yMax = yMax;
  }

  /** The generated packed value at a lattice point. */
  blockAt(x: number, y: number, z: number): number {
    return this.#at(x, y, z, this.#land.relief(x, z));
  }

  #at(x: number, y: number, z: number, relief: number): number {
    if (y < this.#yMin || y >= this.#yMax) return 0;
    const s = this.#spec;
    let inside = relief - y;
    const caves = s.caves;
    if (caves !== undefined && inside >= caves.minDepth) {
      // Meters into rock from the cave wall: the noise gradient is about `frequency` per meter.
      inside = Math.min(inside, (caves.threshold - caveNoise(s, x, y, z)) / caves.frequency);
    }
    const density = densityFromDistance(inside);
    if (density < ISO) return density;
    const h = Math.floor(relief);
    const depth = h - y;
    let material = s.strata[s.strata.length - 1]!.block;
    if (y === this.#yMin && s.bottom !== undefined) material = s.bottom;
    else {
      let top = 0;
      let found = false;
      for (const stratum of s.strata) {
        if (stratum.depth === undefined) break;
        top += stratum.depth;
        if (depth < top) {
          material = stratum.block;
          found = true;
          break;
        }
      }
      if (!found) {
        for (let i = 0; i < s.ores.length; i++) {
          const ore = s.ores[i]!;
          if (depth >= ore.minDepth && unit(hash4(s.seed ^ ORE_SALT, x, y, z ^ Math.imul(i + 1, 0x3b9ac9ff))) < ore.chance) {
            material = ore.block;
            break;
          }
        }
      }
    }
    return (material << 8) | density;
  }

  fill(x0: number, y0: number, z0: number, size: number, out: Uint16Array): void {
    const relief = new Float64Array(size * size);
    for (let lz = 0; lz < size; lz++) for (let lx = 0; lx < size; lx++) relief[lz * size + lx] = this.#land.relief(x0 + lx, z0 + lz);
    for (let ly = 0; ly < size; ly++) {
      for (let lz = 0; lz < size; lz++) {
        for (let lx = 0; lx < size; lx++) {
          out[(ly * size + lz) * size + lx] = this.#at(x0 + lx, y0 + ly, z0 + lz, relief[lz * size + lx]!);
        }
      }
    }
  }
}
