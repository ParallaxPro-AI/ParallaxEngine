/**
 * Water on WebGPU (water_shaders.ts): copy the lit scene and its depth, the underwater view
 * when the camera is in a body, then every body's surface into the scene with depth test
 * and write (so particles and transparent meshes drawn after sort against it).
 */

import { BUFFER, STAGE, TEXTURE } from './backend.js';
import type { Desc, GpuBuffer, GpuDevice, GpuEncoder, GpuTexture } from './backend.js';
import type { Geometry3d } from '../../../core/index.js';
import { floatsOf, offsetOf } from './layout.js';
import { NATURE_FIELDS, NATURE_SLOT, WATER_BLOCK_FLOATS } from './sky_plan.js';
import type { NaturePlan } from './sky_plan.js';
import type { NatureTargetsGpu } from './sky_webgpu.js';
import { GRID_SIDE, WGSL_WATER_COPY, wgslWater } from './water_shaders.js';

const HDR = 'rgba16float';

/** The shared grid: GRID_SIDE² vertices over -1..1, two triangles per cell. */
export function gridMesh(): { vertices: Float32Array; indices: Uint32Array } {
  const n = GRID_SIDE;
  const vertices = new Float32Array(n * n * 2);
  for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) vertices.set([(x / (n - 1)) * 2 - 1, (z / (n - 1)) * 2 - 1], (z * n + x) * 2);
  const indices = new Uint32Array((n - 1) * (n - 1) * 6);
  let o = 0;
  for (let z = 0; z + 1 < n; z++) {
    for (let x = 0; x + 1 < n; x++) {
      const a = z * n + x; const b = a + 1; const c = a + n; const d = c + 1;
      indices.set([a, c, b, b, c, d], o);
      o += 6;
    }
  }
  return { vertices, indices };
}

interface Ribbon {
  readonly position: GpuBuffer;
  readonly flow: GpuBuffer;
  readonly index: GpuBuffer;
  readonly count: number;
  used: boolean;
}

export class WaterWebGpu {
  readonly #device: GpuDevice;
  readonly #copyLayout: unknown;
  readonly #layout: unknown;
  readonly #pipelines = new Map<string, unknown>();
  readonly #sampler: unknown;
  readonly #grid: { vertex: GpuBuffer; index: GpuBuffer; count: number };
  readonly #water: GpuBuffer;
  readonly #ribbons = new Map<string, Ribbon>();
  #copies: { width: number; height: number; color: GpuTexture; depth: GpuTexture } | null = null;
  #uploaded: NaturePlan | null = null;
  #shader: unknown = null;

  constructor(device: GpuDevice) {
    this.#device = device;
    const F = STAGE.FRAGMENT;
    const VF = STAGE.VERTEX | F;
    this.#copyLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: F, texture: { sampleType: 'unfilterable-float' } },
        { binding: 1, visibility: F, texture: { sampleType: 'depth' } },
      ],
    });
    this.#layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: VF, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: floatsOf(NATURE_FIELDS) * 4 } },
        { binding: 1, visibility: VF, buffer: { type: 'uniform' } },
        { binding: 2, visibility: VF, texture: { sampleType: 'unfilterable-float' } },
        { binding: 3, visibility: VF, texture: { sampleType: 'unfilterable-float' } },
        { binding: 4, visibility: F, texture: { sampleType: 'float', viewDimension: 'cube' } },
        { binding: 5, visibility: F, sampler: { type: 'filtering' } },
      ],
    });
    this.#sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' });
    const grid = gridMesh();
    this.#grid = { vertex: this.#static(grid.vertices, BUFFER.VERTEX), index: this.#static(grid.indices, BUFFER.INDEX), count: grid.indices.length };
    this.#water = device.createBuffer({ size: WATER_BLOCK_FLOATS * 4, usage: BUFFER.UNIFORM | BUFFER.COPY_DST });
  }

  #static(data: Float32Array | Uint32Array, usage: number): GpuBuffer {
    const buffer = this.#device.createBuffer({ size: Math.max(4, data.byteLength), usage: usage | BUFFER.COPY_DST });
    this.#device.queue.writeBuffer(buffer, 0, data);
    return buffer;
  }

  #pipeline(kind: 'copy' | 'under' | 'grid' | 'ribbon'): unknown {
    let pipeline = this.#pipelines.get(kind);
    if (pipeline !== undefined) return pipeline;
    const device = this.#device;
    if (kind === 'copy') {
      const module = device.createShaderModule({ code: WGSL_WATER_COPY });
      pipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [this.#copyLayout] }),
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: HDR }, { format: 'r32float' }] },
        primitive: { topology: 'triangle-list' },
      });
    } else {
      const module = this.#module();
      const layout = device.createPipelineLayout({ bindGroupLayouts: [this.#layout] });
      if (kind === 'under') {
        pipeline = device.createRenderPipeline({
          layout, vertex: { module, entryPoint: 'under_vs' },
          fragment: { module, entryPoint: 'under_fs', targets: [{ format: HDR }] }, primitive: { topology: 'triangle-list' },
        });
      } else {
        const buffers: Desc[] = kind === 'grid'
          ? [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] }]
          : [
            { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
            { arrayStride: 16, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x4' }] },
          ];
        pipeline = device.createRenderPipeline({
          layout,
          vertex: { module, entryPoint: kind === 'grid' ? 'grid_vs' : 'ribbon_vs', buffers },
          fragment: { module, entryPoint: 'surface_fs', targets: [{ format: HDR }] },
          primitive: { topology: 'triangle-list', cullMode: 'none' },
          depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less-equal' },
        });
      }
    }
    this.#pipelines.set(kind, pipeline);
    return pipeline;
  }

  #module(): unknown {
    if (this.#shader === null) this.#shader = this.#device.createShaderModule({ code: wgslWater() });
    return this.#shader;
  }

  #copiesFor(width: number, height: number): { color: GpuTexture; depth: GpuTexture } {
    const c = this.#copies;
    if (c !== null && c.width === width && c.height === height) return c;
    c?.color.destroy();
    c?.depth.destroy();
    const usage = TEXTURE.RENDER_ATTACHMENT | TEXTURE.TEXTURE_BINDING;
    this.#copies = {
      width, height,
      color: this.#device.createTexture({ size: [width, height], format: HDR, usage }),
      depth: this.#device.createTexture({ size: [width, height], format: 'r32float', usage }),
    };
    return this.#copies;
  }

  #ribbon(g: Geometry3d): Ribbon {
    let r = this.#ribbons.get(g.id);
    if (r === undefined) {
      r = {
        position: this.#static(g.positions, BUFFER.VERTEX), flow: this.#static(g.colors!, BUFFER.VERTEX),
        index: this.#static(g.indices instanceof Uint32Array ? g.indices : Uint32Array.from(g.indices), BUFFER.INDEX),
        count: g.indices.length, used: true,
      };
      this.#ribbons.set(g.id, r);
    }
    r.used = true;
    return r;
  }

  draw(encoder: GpuEncoder, t: NatureTargetsGpu, uniforms: GpuBuffer): void {
    const device = this.#device;
    const plan = t.plan;
    if (this.#uploaded !== plan) {
      device.queue.writeBuffer(this.#water, 0, plan.waterBlock);
      for (const r of this.#ribbons.values()) r.used = false;
      this.#uploaded = plan;
    }
    const vp = t.viewport;
    const area = (pass: { setViewport(...a: number[]): void; setScissorRect(...a: number[]): void }): void => {
      pass.setViewport(vp.x, vp.y, vp.width, vp.height, 0, 1);
      // Clamped to the target: a fractional viewport rounds outward past its edge otherwise
      // (an invalid scissor drops the whole frame's command buffer).
      const x0 = Math.min(t.width - 1, Math.max(0, Math.floor(vp.x)));
      const y0 = Math.min(t.height - 1, Math.max(0, Math.floor(vp.y)));
      pass.setScissorRect(x0, y0, Math.max(1, Math.min(t.width, Math.ceil(vp.x + vp.width)) - x0), Math.max(1, Math.min(t.height, Math.ceil(vp.y + vp.height)) - y0));
    };
    const copies = this.#copiesFor(t.width, t.height);

    // 1. Copy the scene and its depth.
    const copy = encoder.beginRenderPass({
      colorAttachments: [
        { view: copies.color.createView(), loadOp: 'load', storeOp: 'store' },
        { view: copies.depth.createView(), loadOp: 'load', storeOp: 'store' },
      ],
    });
    area(copy);
    copy.setPipeline(this.#pipeline('copy'));
    copy.setBindGroup(0, device.createBindGroup({
      layout: this.#copyLayout, entries: [{ binding: 0, resource: t.color.createView() }, { binding: 1, resource: t.depth.createView() }],
    }));
    copy.draw(3);
    copy.end();

    const group = device.createBindGroup({
      layout: this.#layout,
      entries: [
        { binding: 0, resource: { buffer: uniforms, size: floatsOf(NATURE_FIELDS) * 4 } },
        { binding: 1, resource: { buffer: this.#water } },
        { binding: 2, resource: copies.color.createView() },
        { binding: 3, resource: copies.depth.createView() },
        { binding: 4, resource: t.cube.createView({ dimension: 'cube' }) },
        { binding: 5, resource: this.#sampler },
      ],
    });
    const offset = [t.view * NATURE_SLOT * 4];
    const under = plan.uniforms[t.view * NATURE_SLOT + offsetOf(NATURE_FIELDS, 'waterAt')]! >= 0;

    // 2. Under the surface: everything through water.
    if (under) {
      const pass = encoder.beginRenderPass({ colorAttachments: [{ view: t.color.createView(), loadOp: 'load', storeOp: 'store' }] });
      area(pass);
      pass.setPipeline(this.#pipeline('under'));
      pass.setBindGroup(0, group, offset);
      pass.draw(3);
      pass.end();
    }

    // 3. The surfaces.
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: t.color.createView(), loadOp: 'load', storeOp: 'store' }],
      depthStencilAttachment: { view: t.depth.createView(), depthLoadOp: 'load', depthStoreOp: 'store' },
    });
    area(pass);
    pass.setBindGroup(0, group, offset);
    plan.bodies.forEach((body, i) => {
      if (body.ribbon !== null) {
        const r = this.#ribbon(body.ribbon);
        pass.setPipeline(this.#pipeline('ribbon'));
        pass.setVertexBuffer(0, r.position);
        pass.setVertexBuffer(1, r.flow);
        pass.setIndexBuffer(r.index, 'uint32');
        pass.drawIndexed(r.count, 1, 0, 0, i);
      } else {
        pass.setPipeline(this.#pipeline('grid'));
        pass.setVertexBuffer(0, this.#grid.vertex);
        pass.setIndexBuffer(this.#grid.index, 'uint32');
        pass.drawIndexed(this.#grid.count, 1, 0, 0, i);
      }
    });
    pass.end();
    if (t.view === plan.views - 1) {
      for (const [id, r] of this.#ribbons) {
        if (r.used) continue;
        r.position.destroy(); r.flow.destroy(); r.index.destroy();
        this.#ribbons.delete(id);
      }
    }
  }

  dispose(): void {
    this.#grid.vertex.destroy();
    this.#grid.index.destroy();
    this.#water.destroy();
    this.#copies?.color.destroy();
    this.#copies?.depth.destroy();
    for (const r of this.#ribbons.values()) { r.position.destroy(); r.flow.destroy(); r.index.destroy(); }
    this.#ribbons.clear();
  }
}
