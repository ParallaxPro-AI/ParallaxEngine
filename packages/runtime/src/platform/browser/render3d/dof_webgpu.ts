/**
 * Depth of field on WebGPU (dof.ts): copy the view's HDR rectangle, then blur it back into
 * the HDR color. Owns its pipelines, its copy texture and a uniform buffer with one 256-byte
 * slot per view (written before the frame's commands run, so each view keeps its own).
 */

import { BUFFER, STAGE, TEXTURE } from './backend.js';
import type { GpuBuffer, GpuDevice, GpuEncoder, GpuRenderPass, GpuTexture } from './backend.js';
import { DOF_FLOATS, WGSL_DOF_COPY, wgslDof } from './dof.js';
import type { DofPlan } from './dof.js';

const HDR = 'rgba16float';
const SLOT = 256;

export interface DofTargetsGpu {
  readonly plan: DofPlan;
  /** The view's frame slot (its uniform slot here). */
  readonly slot: number;
  readonly viewport: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  /** The HDR color the pass reads and writes back. */
  readonly color: GpuTexture;
  readonly depth: GpuTexture;
  readonly width: number;
  readonly height: number;
}

export class DofWebGpu {
  readonly #device: GpuDevice;
  readonly #copyLayout: unknown;
  readonly #layout: unknown;
  readonly #sampler: unknown;
  readonly #pipelines = new Map<string, unknown>();
  #copy: GpuTexture | null = null;
  #uniforms: GpuBuffer | null = null;
  /** Outgrown uniform buffers: earlier passes of this frame may still bind them, so they go at dispose. */
  readonly #retired: GpuBuffer[] = [];

  constructor(device: GpuDevice) {
    this.#device = device;
    const F = STAGE.FRAGMENT;
    this.#copyLayout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: F, texture: { sampleType: 'unfilterable-float' } }] });
    this.#layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: F, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: DOF_FLOATS * 4 } },
        { binding: 1, visibility: F, texture: { sampleType: 'float' } },
        { binding: 2, visibility: F, texture: { sampleType: 'depth' } },
        { binding: 3, visibility: F, sampler: { type: 'filtering' } },
      ],
    });
    this.#sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
  }

  #pipeline(kind: 'copy' | number): unknown {
    const key = String(kind);
    let pipeline = this.#pipelines.get(key);
    if (pipeline !== undefined) return pipeline;
    const device = this.#device;
    const module = device.createShaderModule({ code: kind === 'copy' ? WGSL_DOF_COPY : wgslDof(kind) });
    pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [kind === 'copy' ? this.#copyLayout : this.#layout] }),
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: HDR }] },
      primitive: { topology: 'triangle-list' },
    });
    this.#pipelines.set(key, pipeline);
    return pipeline;
  }

  #copyFor(width: number, height: number): GpuTexture {
    const c = this.#copy;
    if (c !== null && c.width === width && c.height === height) return c;
    c?.destroy();
    this.#copy = this.#device.createTexture({ size: [width, height], format: HDR, usage: TEXTURE.RENDER_ATTACHMENT | TEXTURE.TEXTURE_BINDING });
    return this.#copy;
  }

  #uniformsFor(slot: number): GpuBuffer {
    const need = (slot + 1) * SLOT;
    if (this.#uniforms === null || this.#uniforms.size < need) {
      if (this.#uniforms !== null) this.#retired.push(this.#uniforms);
      this.#uniforms = this.#device.createBuffer({ size: Math.max(need * 2, 8 * SLOT), usage: BUFFER.UNIFORM | BUFFER.COPY_DST });
    }
    return this.#uniforms;
  }

  draw(encoder: GpuEncoder, t: DofTargetsGpu): void {
    const device = this.#device;
    const vp = t.viewport;
    const area = (pass: GpuRenderPass): void => {
      pass.setViewport(vp.x, vp.y, vp.width, vp.height, 0, 1);
      // Clamped to the target: a fractional viewport rounds outward past its edge otherwise.
      const x0 = Math.min(t.width - 1, Math.max(0, Math.floor(vp.x)));
      const y0 = Math.min(t.height - 1, Math.max(0, Math.floor(vp.y)));
      pass.setScissorRect(x0, y0, Math.max(1, Math.min(t.width, Math.ceil(vp.x + vp.width)) - x0), Math.max(1, Math.min(t.height, Math.ceil(vp.y + vp.height)) - y0));
    };
    const copy = this.#copyFor(t.width, t.height);
    const uniforms = this.#uniformsFor(t.slot);
    device.queue.writeBuffer(uniforms, t.slot * SLOT, t.plan.uniforms);

    const first = encoder.beginRenderPass({ colorAttachments: [{ view: copy.createView(), loadOp: 'load', storeOp: 'store' }] });
    area(first);
    first.setPipeline(this.#pipeline('copy'));
    first.setBindGroup(0, device.createBindGroup({ layout: this.#copyLayout, entries: [{ binding: 0, resource: t.color.createView() }] }));
    first.draw(3);
    first.end();

    const blur = encoder.beginRenderPass({ colorAttachments: [{ view: t.color.createView(), loadOp: 'load', storeOp: 'store' }] });
    area(blur);
    blur.setPipeline(this.#pipeline(t.plan.samples));
    blur.setBindGroup(0, device.createBindGroup({
      layout: this.#layout,
      entries: [
        { binding: 0, resource: { buffer: uniforms, size: DOF_FLOATS * 4 } },
        { binding: 1, resource: copy.createView() },
        { binding: 2, resource: t.depth.createView() },
        { binding: 3, resource: this.#sampler },
      ],
    }), [t.slot * SLOT]);
    blur.draw(3);
    blur.end();
  }

  dispose(): void {
    this.#copy?.destroy();
    this.#uniforms?.destroy();
    for (const b of this.#retired.splice(0)) b.destroy();
    this.#copy = null;
    this.#uniforms = null;
    this.#pipelines.clear();
  }
}
