/**
 * Crowd avoidance: optimal reciprocal collision avoidance (ORCA, as in van den Berg et
 * al.'s RVO2) on the ground plane. Each avoiding agent gets one half-plane of permitted
 * velocities per neighbour — velocities that keep the pair apart for TIME_HORIZON
 * seconds if the neighbour does its share — and takes the permitted velocity nearest the
 * one its path wants, within its speed. Avoiding agents each take half of every
 * avoidance; a neighbour that doesn't avoid (idle, `avoid_others` False, mid-link) is
 * avoided in full. Overlapping agents get a half-plane that parts them within one step.
 *
 * ORCA alone can lock up when a meeting is mirror-symmetric (two files crossing at right
 * angles shoulder to shoulder): every agent's best velocity is to wait for its mirror
 * image. So each agent first turns its preferred velocity up to KEEP_RIGHT radians to its
 * own right while neighbours are ahead of it — the rule people use in a corridor. "Right"
 * is taken from each agent's own heading, so mirrored agents turn opposite ways and the
 * symmetry breaks with no shared state and no randomness.
 *
 * Pure and deterministic: agents and neighbours are visited in the order given (spawn
 * order) and every input is from the previous step, so the result doesn't depend on who
 * is processed first. Static geometry is not part of it (agents slide along walls in
 * agents.ts).
 */

/** Seconds ahead agents keep clear of each other. */
export const TIME_HORIZON = 1.5;
/** Most neighbours each agent considers (the nearest). */
export const MAX_NEIGHBORS = 10;
/** Largest turn to the right (radians) an agent takes before neighbours ahead. */
export const KEEP_RIGHT = 0.35;
const EPS = 1e-9;
const BUCKET = 4;

export interface CrowdAgent {
  readonly id: number;
  readonly x: number;
  readonly z: number;
  /** Ground height, so agents on different layers (a bridge and the road under it) ignore each other. */
  readonly y: number;
  /** Its velocity over the last step. */
  readonly vx: number;
  readonly vz: number;
  readonly radius: number;
  /** Whether it avoids (takes half of each avoidance); others are avoided in full. */
  readonly avoids: boolean;
  /** For avoiding agents: the velocity its path wants and the speed it may not exceed. */
  readonly prefVx: number;
  readonly prefVz: number;
  readonly maxSpeed: number;
}

interface Line {
  px: number;
  pz: number;
  dx: number;
  dz: number;
}

const det = (ax: number, az: number, bx: number, bz: number): number => ax * bz - az * bx;

/** RVO2's linearProgram1: the best point on line `n` that satisfies lines before it, within the speed circle. */
function program1(lines: readonly Line[], n: number, radius: number, ox: number, oz: number, direction: boolean, out: { x: number; z: number }): boolean {
  const line = lines[n]!;
  const dot = line.px * line.dx + line.pz * line.dz;
  const discriminant = dot * dot + radius * radius - (line.px * line.px + line.pz * line.pz);
  if (discriminant < 0) return false;
  const root = Math.sqrt(discriminant);
  let left = -dot - root;
  let right = -dot + root;
  for (let i = 0; i < n; i++) {
    const other = lines[i]!;
    const denominator = det(line.dx, line.dz, other.dx, other.dz);
    const numerator = det(other.dx, other.dz, line.px - other.px, line.pz - other.pz);
    if (Math.abs(denominator) <= EPS) {
      if (numerator < 0) return false;
      continue;
    }
    const t = numerator / denominator;
    if (denominator >= 0) right = Math.min(right, t);
    else left = Math.max(left, t);
    if (left > right) return false;
  }
  let t: number;
  if (direction) t = ox * line.dx + oz * line.dz > 0 ? right : left;
  else t = Math.min(right, Math.max(left, line.dx * (ox - line.px) + line.dz * (oz - line.pz)));
  out.x = line.px + t * line.dx;
  out.z = line.pz + t * line.dz;
  return true;
}

/** RVO2's linearProgram2: the velocity nearest (ox, oz) satisfying every line; returns the first line that failed (lines.length: none). */
function program2(lines: readonly Line[], radius: number, ox: number, oz: number, direction: boolean, out: { x: number; z: number }): number {
  if (direction) {
    out.x = ox * radius;
    out.z = oz * radius;
  } else if (ox * ox + oz * oz > radius * radius) {
    const length = Math.hypot(ox, oz);
    out.x = (ox / length) * radius;
    out.z = (oz / length) * radius;
  } else {
    out.x = ox;
    out.z = oz;
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (det(line.dx, line.dz, line.px - out.x, line.pz - out.z) > 0) {
      const x = out.x;
      const z = out.z;
      if (!program1(lines, i, radius, ox, oz, direction, out)) {
        out.x = x;
        out.z = z;
        return i;
      }
    }
  }
  return lines.length;
}

/** RVO2's linearProgram3: when the constraints conflict, the velocity that violates them least. */
function program3(lines: readonly Line[], begin: number, radius: number, out: { x: number; z: number }): void {
  let distance = 0;
  for (let i = begin; i < lines.length; i++) {
    const line = lines[i]!;
    if (det(line.dx, line.dz, line.px - out.x, line.pz - out.z) <= distance) continue;
    const projected: Line[] = [];
    for (let j = 0; j < i; j++) {
      const other = lines[j]!;
      const determinant = det(line.dx, line.dz, other.dx, other.dz);
      let px: number;
      let pz: number;
      if (Math.abs(determinant) <= EPS) {
        if (line.dx * other.dx + line.dz * other.dz > 0) continue;
        px = 0.5 * (line.px + other.px);
        pz = 0.5 * (line.pz + other.pz);
      } else {
        const t = det(other.dx, other.dz, line.px - other.px, line.pz - other.pz) / determinant;
        px = line.px + t * line.dx;
        pz = line.pz + t * line.dz;
      }
      const dx = other.dx - line.dx;
      const dz = other.dz - line.dz;
      const length = Math.hypot(dx, dz);
      if (length <= EPS) continue;
      projected.push({ px, pz, dx: dx / length, dz: dz / length });
    }
    const x = out.x;
    const z = out.z;
    if (program2(projected, radius, -line.dz, line.dx, true, out) < projected.length) {
      out.x = x;
      out.z = z;
    }
    distance = det(line.dx, line.dz, line.px - out.x, line.pz - out.z);
  }
}

/** The ORCA half-plane agent a gets from neighbour b. */
function orcaLine(a: CrowdAgent, b: CrowdAgent, dt: number): Line {
  const rx = b.x - a.x;
  const rz = b.z - a.z;
  const vx = a.vx - b.vx;
  const vz = a.vz - b.vz;
  const distSq = rx * rx + rz * rz;
  const combined = a.radius + b.radius;
  const combinedSq = combined * combined;
  const share = b.avoids ? 0.5 : 1;
  let dx: number;
  let dz: number;
  let ux: number;
  let uz: number;
  if (distSq > combinedSq) {
    const inv = 1 / TIME_HORIZON;
    const wx = vx - inv * rx;
    const wz = vz - inv * rz;
    const wSq = wx * wx + wz * wz;
    const dot = wx * rx + wz * rz;
    if (dot < 0 && dot * dot > combinedSq * wSq) {
      // The cut-off circle's side.
      const w = Math.sqrt(wSq);
      const nx = wx / w;
      const nz = wz / w;
      dx = nz;
      dz = -nx;
      ux = (combined * inv - w) * nx;
      uz = (combined * inv - w) * nz;
    } else {
      // A leg of the cone.
      const leg = Math.sqrt(distSq - combinedSq);
      if (det(rx, rz, wx, wz) > 0) {
        dx = (rx * leg - rz * combined) / distSq;
        dz = (rx * combined + rz * leg) / distSq;
      } else {
        dx = -(rx * leg + rz * combined) / distSq;
        dz = -(-rx * combined + rz * leg) / distSq;
      }
      const along = vx * dx + vz * dz;
      ux = along * dx - vx;
      uz = along * dz - vz;
    }
  } else {
    // Already overlapping: part within this step.
    const inv = 1 / dt;
    const wx = vx - inv * rx;
    const wz = vz - inv * rz;
    const w = Math.hypot(wx, wz);
    const nx = w > EPS ? wx / w : (a.id < b.id ? -1 : 1);
    const nz = w > EPS ? wz / w : 0;
    dx = nz;
    dz = -nx;
    ux = (combined * inv - w) * nx;
    uz = (combined * inv - w) * nz;
  }
  return { px: a.vx + share * ux, pz: a.vz + share * uz, dx, dz };
}

/** The agent's preferred velocity turned toward its right by how crowded the way ahead is (see the header). */
function keepRight(a: CrowdAgent, neighbours: readonly CrowdAgent[]): [number, number] {
  const speed = Math.hypot(a.prefVx, a.prefVz);
  if (speed <= EPS) return [a.prefVx, a.prefVz];
  const fx = a.prefVx / speed;
  const fz = a.prefVz / speed;
  let crowding = 0;
  for (const b of neighbours) {
    const rx = b.x - a.x;
    const rz = b.z - a.z;
    const d = Math.hypot(rx, rz);
    const reach = a.radius + b.radius + speed * TIME_HORIZON;
    if (d <= EPS || d >= reach) continue;
    // Within 60° of straight ahead.
    if ((rx * fx + rz * fz) / d < 0.5) continue;
    crowding += 1 - d / reach;
  }
  const angle = KEEP_RIGHT * Math.min(1, crowding);
  if (angle <= 0) return [a.prefVx, a.prefVz];
  // The right of heading (fx, fz) is (fz, -fx).
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [(fx * cos + fz * sin) * speed, (fz * cos - fx * sin) * speed];
}

function bucketKey(bx: number, bz: number): number {
  return (bx + 0x100000) * 0x200000 + (bz + 0x100000);
}

/**
 * New velocities for the avoiding agents (by id), each the ORCA velocity nearest its
 * preferred one. Neighbours are agents within reach of meeting in TIME_HORIZON whose
 * ground heights are within `layerGap` (m).
 */
export function avoid(agents: readonly CrowdAgent[], dt: number, layerGap: number): Map<number, { x: number; z: number }> {
  const buckets = new Map<number, number[]>();
  let fastest = 0;
  let widest = 0;
  agents.forEach((a, n) => {
    const key = bucketKey(Math.floor(a.x / BUCKET), Math.floor(a.z / BUCKET));
    const list = buckets.get(key) ?? [];
    list.push(n);
    buckets.set(key, list);
    fastest = Math.max(fastest, Math.hypot(a.vx, a.vz), a.avoids ? a.maxSpeed : 0);
    widest = Math.max(widest, a.radius);
  });
  const out = new Map<number, { x: number; z: number }>();
  for (const a of agents) {
    if (!a.avoids) continue;
    const reach = a.radius + widest + (a.maxSpeed + fastest) * TIME_HORIZON;
    const near: Array<{ n: number; d: number }> = [];
    for (let bx = Math.floor((a.x - reach) / BUCKET); bx <= Math.floor((a.x + reach) / BUCKET); bx++) {
      for (let bz = Math.floor((a.z - reach) / BUCKET); bz <= Math.floor((a.z + reach) / BUCKET); bz++) {
        for (const n of buckets.get(bucketKey(bx, bz)) ?? []) {
          const b = agents[n]!;
          if (b.id === a.id || Math.abs(b.y - a.y) > layerGap) continue;
          const d = Math.hypot(b.x - a.x, b.z - a.z);
          if (d <= reach) near.push({ n, d });
        }
      }
    }
    near.sort((p, q) => p.d - q.d || agents[p.n]!.id - agents[q.n]!.id);
    const neighbours = near.slice(0, MAX_NEIGHBORS);
    const lines = neighbours.map(({ n }) => orcaLine(a, agents[n]!, dt));
    const [px, pz] = keepRight(a, neighbours.map(({ n }) => agents[n]!));
    const result = { x: 0, z: 0 };
    const failed = program2(lines, a.maxSpeed, px, pz, false, result);
    if (failed < lines.length) program3(lines, failed, a.maxSpeed, result);
    out.set(a.id, result);
  }
  return out;
}
