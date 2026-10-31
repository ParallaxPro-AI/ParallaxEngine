/**
 * Effect particles and ribbons on WebGPU (vfx.ts): one render pass per view into the HDR
 * target with no depth attachment, the scene's depth bound as a texture.
 */

import { BUFFER, STAGE } from './backend.js';
import type { GpuBuffer, GpuDevice, GpuEncoder, GpuRenderPass, GpuTexture, GpuTextureView } from './backend.js';
import { RIBBON_VERTEX_FLOATS, VFX_INSTANCE_FLOATS, wgslParticles, wgslRibbons } from './vfx.js';
import type { VfxPlan, VfxRange } from './vfx.js';

const HDR = 'rgba16float';
const PREMULTIPLIED = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};
const ADD = {
  color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
  alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
};

export interface VfxImageGpu {
  readonly view: GpuTextureView;
  readonly sampler: unknown;
}

export interface VfxDrawGpu {
  readonly plan: VfxPlan;
  /** The frame bind group (group 0) and this view's dynamic offset into it. */
  readonly frameGroup: unknown;
  readonly frameOffset: number[];
  readonly color: GpuTexture;
  readonly depth: GpuTexture;
  /** Sets the view's viewport and scissor on a pass. */
  readonly enter: (pass: GpuRenderPass) => void;
  /** A batch's image (null: white). */
  readonly image: (texture: VfxPlan['particles'][number]['texture']) => VfxImageGpu;
}

function vec4s(count: number): { shaderLocation: number; offset: number; format: string }[] {
  return Array.from({ length: count }, (_, i) => ({ shaderLocation: i, offset: i * 16, format: 'float32x4' }));
}

export class VfxWebGpu {
  readonly #device: GpuDevice;
  readonly #frameLayout: unknown;
  readonly #imageLayout: unknown;
  readonly #depthLayout: unknown;
  /** Ribbons sample no image: an empty group 1 keeps the depth texture at group 2 in both pipelines. */
  readonly #emptyLayout: unknown;
  readonly #empty: unknown;
  readonly #pipelines = new Map<string, unknown>();
  readonly #imageGroups = new WeakMap<object, unknown>();
  readonly #depthGroups = new WeakMap<GpuTexture, unknown>();
  #instances: GpuBuffer | null = null;
  #ribbons: GpuBuffer | null = null;
  #uploaded: VfxPlan | null = null;

  constructor(device: GpuDevice, frameLayout: unknown) {
    this.#device = device;
    this.#frameLayout = frameLayout;
    const F = STAGE.FRAGMENT;
    this.#imageLayout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: F, texture: { sampleType: 'float' } }, { binding: 1, visibility: F, sampler: { type: 'filtering' } }],
    });
    this.#depthLayout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: F, texture: { sampleType: 'depth' } }] });
    this.#emptyLayout = device.createBindGroupLayout({ entries: [] });
    this.#empty = device.createBindGroup({ layout: this.#emptyLayout, entries: [] });
  }

  draw(encoder: GpuEncoder, d: VfxDrawGpu): void {
    const plan = d.plan;
    if (this.#uploaded !== plan) {
      this.#instances = this.#write(this.#instances, plan.instances);
      this.#ribbons = this.#write(this.#ribbons, plan.ribbonVertices);
      this.#uploaded = plan;
    }
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: d.color.createView(), loadOp: 'load', storeOp: 'store' }] });
    d.enter(pass);
    pass.setBindGroup(0, d.frameGroup, d.frameOffset);
    let depth = this.#depthGroups.get(d.depth);
    if (depth === undefined) {
      depth = this.#device.createBindGroup({ layout: this.#depthLayout, entries: [{ binding: 0, resource: d.depth.createView() }] });
      this.#depthGroups.set(d.depth, depth);
    }
    pass.setBindGroup(2, depth);
    for (const blend of ['alpha', 'additive'] as const) {
      const items = plan.particles.filter((p) => p.blend === blend);
      if (items.length > 0) {
        pass.setPipeline(this.#pipeline('particles', blend));
        pass.setBindGroup(2, depth);
        for (const item of items) {
          const image = d.image(item.texture);
          let group = this.#imageGroups.get(image.view as object);
          if (group === undefined) {
            group = this.#device.createBindGroup({ layout: this.#imageLayout, entries: [{ binding: 0, resource: image.view }, { binding: 1, resource: image.sampler }] });
            this.#imageGroups.set(image.view as object, group);
          }
          pass.setBindGroup(1, group);
          pass.setVertexBuffer(0, this.#instances!, item.first * VFX_INSTANCE_FLOATS * 4);
          pass.draw(6, item.count);
        }
      }
      const range: VfxRange = plan.ribbons[blend];
      if (range.count > 0) {
        pass.setPipeline(this.#pipeline('ribbons', blend));
        pass.setBindGroup(1, this.#empty);
        pass.setBindGroup(2, depth);
        pass.setVertexBuffer(0, this.#ribbons!);
        pass.draw(range.count, 1, range.first);
      }
    }
    pass.end();
  }

  dispose(): void {
    this.#instances?.destroy();
    this.#ribbons?.destroy();
    this.#instances = null;
    this.#ribbons = null;
  }

  #write(buffer: GpuBuffer | null, data: Float32Array): GpuBuffer {
    let b = buffer;
    if (b === null || b.size < data.byteLength) {
      b?.destroy();
      b = this.#device.createBuffer({ size: Math.max(256, 2 ** Math.ceil(Math.log2(data.byteLength))), usage: BUFFER.VERTEX | BUFFER.COPY_DST });
    }
    this.#device.queue.writeBuffer(b, 0, data);
    return b;
  }

  #pipeline(kind: 'particles' | 'ribbons', blend: 'alpha' | 'additive'): unknown {
    const key = `${kind}|${blend}`;
    let pipeline = this.#pipelines.get(key);
    if (pipeline !== undefined) return pipeline;
    const device = this.#device;
    const additive = blend === 'additive';
    const module = device.createShaderModule({ code: kind === 'particles' ? wgslParticles(additive) : wgslRibbons(additive) });
    const layouts = [this.#frameLayout, kind === 'particles' ? this.#imageLayout : this.#emptyLayout, this.#depthLayout];
    pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: layouts }),
      vertex: {
        module, entryPoint: 'vs',
        buffers: [kind === 'particles'
          ? { arrayStride: VFX_INSTANCE_FLOATS * 4, stepMode: 'instance', attributes: vec4s(5) }
          : { arrayStride: RIBBON_VERTEX_FLOATS * 4, stepMode: 'vertex', attributes: vec4s(4) }],
      },
      fragment: { module, entryPoint: 'fs', targets: [{ format: HDR, blend: additive ? ADD : PREMULTIPLIED }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
    });
    this.#pipelines.set(key, pipeline);
    return pipeline;
  }
}
