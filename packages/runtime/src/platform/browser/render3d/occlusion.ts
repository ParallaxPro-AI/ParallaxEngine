/**
 * Hi-Z occlusion culling: instances inside a view's frustum but hidden behind what an
 * earlier frame drew are left out (`PlanOptions.occluded`).
 *
 * After the first screen view's opaque scene, the backend reduces its depth to a small grid
 * (`HIZ_MAX` cells across, each the farthest depth under it) and reads it back without
 * stalling (one or two frames late). On the CPU the grid becomes a max-depth pyramid, and
 * an instance's bounding sphere is projected with the view-projection the depth was drawn
 * with: when the nearest depth of its box is farther than the farthest depth under the
 * box's screen rectangle (at a pyramid level where that rectangle is a few cells), it is
 * hidden. Conservative by construction: a box that reaches the near plane or leaves the
 * grid is visible, and the test runs only while the camera is close to where the depth was
 * drawn (a turn or a teleport waits for fresh depth).
 *
 * The adaptive governor (`OcclusionGovernor`) keeps it from costing more than it saves: it
 * samples the share of in-frustum instances it hides, suspends itself (no reduction, no
 * readback, no tests) when that stays under 5%, and probes again every few seconds or at
 * once when the camera moves far — scenes of open terrain stop paying, a city keeps it.
 */

import type { View3d } from '../../../core/index.js';
import type { CullStats } from './cull.js';

/** Most cells across the reduced depth grid. */
export const HIZ_MAX = 128;

/** The reduced grid's size for a viewport (aspect kept, at most `HIZ_MAX` across). */
export function hizSize(width: number, height: number): { width: number; height: number; block: number } {
  const block = Math.max(1, Math.ceil(Math.max(width, height) / HIZ_MAX));
  return { width: Math.max(1, Math.ceil(width / block)), height: Math.max(1, Math.ceil(height / block)), block };
}

/** A read-back depth grid: farthest depth (0..1) per cell, row 0 at the top. */
export interface DepthGrid {
  readonly width: number;
  readonly height: number;
  readonly depths: Float32Array;
  /** The view-projection and camera the depth was drawn with. */
  readonly viewProjection: Float32Array;
  readonly camera: number;
  readonly position: readonly [number, number, number];
  readonly forward: readonly [number, number, number];
}

/** A max-depth pyramid over a depth grid, and the occlusion test. */
export class HiZ {
  readonly grid: DepthGrid;
  readonly #levels: { width: number; height: number; depths: Float32Array }[];

  constructor(grid: DepthGrid) {
    this.grid = grid;
    const levels = [{ width: grid.width, height: grid.height, depths: grid.depths }];
    for (;;) {
      const top = levels[levels.length - 1]!;
      if (top.width <= 1 && top.height <= 1) break;
      const width = Math.max(1, Math.ceil(top.width / 2));
      const height = Math.max(1, Math.ceil(top.height / 2));
      const depths = new Float32Array(width * height);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          let most = 0;
          for (let dy = 0; dy < 2; dy++) {
            for (let dx = 0; dx < 2; dx++) {
              const sx = Math.min(top.width - 1, x * 2 + dx);
              const sy = Math.min(top.height - 1, y * 2 + dy);
              most = Math.max(most, top.depths[sy * top.width + sx]!);
            }
          }
          depths[y * width + x] = most;
        }
      }
      levels.push({ width, height, depths });
    }
    this.#levels = levels;
  }

  /** Whether a world sphere is certainly hidden behind the depth. */
  occluded(x: number, y: number, z: number, r: number): boolean {
    const m = this.grid.viewProjection;
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity; let nearest = Infinity;
    for (let i = 0; i < 8; i++) {
      const px = x + (i & 1 ? r : -r);
      const py = y + (i & 2 ? r : -r);
      const pz = z + (i & 4 ? r : -r);
      const cw = m[3]! * px + m[7]! * py + m[11]! * pz + m[15]!;
      if (cw <= 1e-4) return false;
      const cx = (m[0]! * px + m[4]! * py + m[8]! * pz + m[12]!) / cw;
      const cy = (m[1]! * px + m[5]! * py + m[9]! * pz + m[13]!) / cw;
      const cz = (m[2]! * px + m[6]! * py + m[10]! * pz + m[14]!) / cw;
      if (cz <= 0) return false;
      minX = Math.min(minX, cx); maxX = Math.max(maxX, cx);
      minY = Math.min(minY, cy); maxY = Math.max(maxY, cy);
      nearest = Math.min(nearest, cz);
    }
    if (minX < -1 || maxX > 1 || minY < -1 || maxY > 1) return false;
    const g = this.grid;
    // Cells (row 0 at the top: ndc y up is row down).
    const x0 = Math.floor(((minX + 1) / 2) * g.width);
    const x1 = Math.min(g.width - 1, Math.floor(((maxX + 1) / 2) * g.width));
    const y0 = Math.floor(((1 - maxY) / 2) * g.height);
    const y1 = Math.min(g.height - 1, Math.floor(((1 - minY) / 2) * g.height));
    const span = Math.max(x1 - x0 + 1, y1 - y0 + 1);
    const level = Math.min(this.#levels.length - 1, Math.max(0, Math.ceil(Math.log2(span / 4))));
    const l = this.#levels[level]!;
    const k = 2 ** level;
    let farthest = 0;
    for (let cy = Math.floor(y0 / k); cy <= Math.floor(y1 / k); cy++) {
      for (let cx = Math.floor(x0 / k); cx <= Math.floor(x1 / k); cx++) {
        farthest = Math.max(farthest, l.depths[Math.min(l.height - 1, cy) * l.width + Math.min(l.width - 1, cx)]!);
      }
    }
    return nearest > farthest + 1e-5;
  }

  /** Whether a view is close enough to the one the depth was drawn from for the test to hold (no turn, no teleport). */
  matches(view: View3d): boolean {
    const g = this.grid;
    if (view.camera !== g.camera) return false;
    const moved = Math.hypot(view.position[0] - g.position[0], view.position[1] - g.position[1], view.position[2] - g.position[2]);
    const facing = view.forward[0] * g.forward[0] + view.forward[1] * g.forward[1] + view.forward[2] * g.forward[2];
    return moved < 0.75 && facing > 0.995;
  }
}

export type OcclusionState = 'active' | 'suspended';

/** Turns Hi-Z off where it hides too little to pay for itself, and probes again later. */
export class OcclusionGovernor {
  #state: OcclusionState = 'active';
  #frames = 0;
  #tested = 0;
  #hidden = 0;
  #lowSamples = 0;
  #suspendedAt = 0;
  readonly #sampleFrames: number;
  readonly #suspendBelow: number;
  readonly #probeAfter: number;

  constructor(options: { sampleFrames?: number; suspendBelow?: number; probeAfter?: number } = {}) {
    this.#sampleFrames = options.sampleFrames ?? 30;
    this.#suspendBelow = options.suspendBelow ?? 0.05;
    this.#probeAfter = options.probeAfter ?? 300;
  }

  get state(): OcclusionState {
    return this.#state;
  }

  /** Whether this frame reduces and reads depth (and tests against it). */
  get wanted(): boolean {
    return this.#state === 'active';
  }

  /** A frame's counts; a camera jump probes at once. */
  record(stats: CullStats, jumped: boolean): void {
    this.#frames++;
    if (this.#state === 'suspended') {
      if (jumped || this.#frames - this.#suspendedAt >= this.#probeAfter) this.#resume();
      return;
    }
    this.#tested += stats.inFrustum;
    this.#hidden += stats.occluded;
    if (this.#frames % this.#sampleFrames !== 0) return;
    const ratio = this.#tested === 0 ? 0 : this.#hidden / this.#tested;
    this.#tested = 0;
    this.#hidden = 0;
    this.#lowSamples = ratio < this.#suspendBelow ? this.#lowSamples + 1 : 0;
    if (this.#lowSamples >= 2) {
      this.#state = 'suspended';
      this.#suspendedAt = this.#frames;
      this.#lowSamples = 0;
    }
  }

  #resume(): void {
    this.#state = 'active';
    this.#tested = 0;
    this.#hidden = 0;
    this.#lowSamples = 0;
  }
}

// ── The reduction pass (WGSL, GLSL) ──────────────────────────────────────────

/** WebGPU: each output cell the farthest depth of its `block`² texels of the view's depth (block and view origin in the uniform). */
export const WGSL_HIZ = `
struct Reduce { params: vec4<f32>, };
@group(0) @binding(0) var depthTexture: texture_depth_2d;
@group(0) @binding(1) var<uniform> reduce: Reduce;

@vertex fn vs(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
  var corners = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  return vec4<f32>(corners[index], 0.0, 1.0);
}

@fragment fn fs(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
  let block = i32(reduce.params.x);
  let origin = vec2<i32>(reduce.params.yz);
  let size = vec2<i32>(textureDimensions(depthTexture));
  let start = origin + vec2<i32>(floor(p.xy)) * block;
  var most = 0.0;
  for (var y = 0; y < block; y++) {
    for (var x = 0; x < block; x++) {
      let t = min(start + vec2<i32>(x, y), size - vec2<i32>(1));
      most = max(most, textureLoad(depthTexture, t, 0));
    }
  }
  return vec4<f32>(most, 0.0, 0.0, 1.0);
}
`;

/** WebGL2: the same; GL rows run bottom-up, so cell row r reads the texels of the view's row r from its top. */
export const GLSL_HIZ = {
  vertex: `#version 300 es
void main() {
  vec2 corners[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  gl_Position = vec4(corners[gl_VertexID], 0.0, 1.0);
}
`,
  fragment: `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D depthTexture;
uniform vec4 reduceParams;
out vec4 fragColor;
void main() {
  int block = int(reduceParams.x);
  ivec2 size = textureSize(depthTexture, 0);
  int cells = int(reduceParams.w);
  // Output rows are drawn bottom-up too: flip so row 0 of the read-back is the top.
  int row = cells - 1 - int(gl_FragCoord.y);
  ivec2 start = ivec2(int(reduceParams.y) + int(gl_FragCoord.x) * block, size.y - int(reduceParams.z) - (row + 1) * block);
  float most = 0.0;
  for (int y = 0; y < block; y++) {
    for (int x = 0; x < block; x++) {
      ivec2 t = clamp(start + ivec2(x, y), ivec2(0), size - ivec2(1));
      most = max(most, texelFetch(depthTexture, t, 0).r);
    }
  }
  fragColor = vec4(most, 0.0, 0.0, 1.0);
}
`,
};
