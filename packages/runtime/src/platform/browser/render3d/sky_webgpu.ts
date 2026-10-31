/**
 * The outdoors on WebGPU (sky_plan.ts → GPU): the environment cube's faces from the sky
 * model, and per view the composite pass (sky, aerial perspective, cloud shadows, wet and
 * snowy surfaces; blended as dst·k + add, so it needs no copy of the scene) followed by
 * the water (water_webgpu.ts). The backend calls `environmentFace` while it builds the cube
 * and `draw` once per view after the opaque scene is resolved; everything here owns its own
 * GPU objects and binds nothing the backend relies on.
 */

import { BUFFER, STAGE, TEXTURE } from './backend.js';
import type { Desc, GpuBuffer, GpuDevice, GpuEncoder, GpuTexture, GpuTextureView } from './backend.js';
import { floatsOf, offsetOf } from './layout.js';
import { NATURE_FIELDS, NATURE_SLOT, faceSlot } from './sky_plan.js';
import type { CloudMode, NaturePlan } from './sky_plan.js';
import { wgslSky } from './sky_shaders.js';
import { WaterWebGpu } from './water_webgpu.js';

const HDR = 'rgba16float';
/** Where a view's far-fade end sits in its nature slot (0: no fade pass). */
const VIEW_FADE_END = offsetOf(NATURE_FIELDS, 'viewFade') + 1;

/** What a view's outdoor pass draws into. */
export interface NatureTargetsGpu {
  readonly plan: NaturePlan;
  /** The view's slot (its `frameSlot`). */
  readonly view: number;
  readonly viewport: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  /** The HDR color the scene is resolved into, drawn over. */
  readonly color: GpuTexture;
  /** The scene's depth (depth32float), read and written (water). */
  readonly depth: GpuTexture;
  /** The environment cube (reflections). */
  readonly cube: GpuTexture;
  readonly width: number;
  readonly height: number;
}

export class NatureWebGpu {
  readonly #device: GpuDevice;
  readonly #layout: unknown;
  readonly #pipelines = new Map<string, unknown>();
  readonly #sampler: unknown;
  readonly #dummyDepth: GpuTexture;
  readonly #water: WaterWebGpu;
  #uniforms: GpuBuffer | null = null;
  #cover: { texture: GpuTexture; size: number; version: number } | null = null;
  readonly #noCover: GpuTexture;
  /** Bound as the cube while the cube itself is being drawn (its faces don't read it). */
  readonly #blackCube: GpuTexture;
  #uploaded: NaturePlan | null = null;

  constructor(device: GpuDevice) {
    this.#device = device;
    const F = STAGE.FRAGMENT;
    this.#layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: STAGE.VERTEX | F, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: floatsOf(NATURE_FIELDS) * 4 } },
        { binding: 1, visibility: F, texture: { sampleType: 'depth' } },
        { binding: 2, visibility: F, texture: { sampleType: 'float', viewDimension: 'cube' } },
        { binding: 3, visibility: F, sampler: { type: 'filtering' } },
        { binding: 4, visibility: F, texture: { sampleType: 'unfilterable-float' } },
      ],
    });
    this.#sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' });
    this.#dummyDepth = device.createTexture({ size: [1, 1], format: 'depth32float', usage: TEXTURE.TEXTURE_BINDING | TEXTURE.RENDER_ATTACHMENT });
    this.#noCover = device.createTexture({ size: [1, 1], format: 'r32float', usage: TEXTURE.TEXTURE_BINDING | TEXTURE.COPY_DST });
    this.#blackCube = device.createTexture({ size: [1, 1, 6], format: HDR, usage: TEXTURE.TEXTURE_BINDING | TEXTURE.COPY_DST });
    this.#water = new WaterWebGpu(device);
  }

  #pipeline(kind: 'composite' | 'face' | 'fade', quality: number, clouds: CloudMode): unknown {
    const key = `${kind}|${quality}|${clouds}`;
    let pipeline = this.#pipelines.get(key);
    if (pipeline === undefined) {
      const module = this.#device.createShaderModule({ code: wgslSky(quality, clouds) });
      const target: Desc = kind !== 'face'
        ? { format: HDR, blend: { color: { srcFactor: 'one', dstFactor: 'src-alpha', operation: 'add' }, alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' } } }
        : { format: HDR };
      pipeline = this.#device.createRenderPipeline({
        layout: this.#device.createPipelineLayout({ bindGroupLayouts: [this.#layout] }),
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: `${kind}_fs`, targets: [target] },
        primitive: { topology: 'triangle-list' },
      });
      this.#pipelines.set(key, pipeline);
    }
    return pipeline;
  }

  /** Upload a plan's uniforms and cover map once per plan. */
  #upload(plan: NaturePlan): GpuBuffer {
    const bytes = plan.uniforms.byteLength;
    if (this.#uniforms === null || this.#uniforms.size < bytes) {
      this.#uniforms?.destroy();
      this.#uniforms = this.#device.createBuffer({ size: Math.max(bytes, NATURE_SLOT * 4 * 8), usage: BUFFER.UNIFORM | BUFFER.COPY_DST });
    }
    if (this.#uploaded !== plan) {
      this.#device.queue.writeBuffer(this.#uniforms, 0, plan.uniforms);
      const cover = plan.cover;
      if (cover !== null) {
        if (this.#cover === null || this.#cover.size !== cover.size) {
          this.#cover?.texture.destroy();
          this.#cover = {
            texture: this.#device.createTexture({ size: [cover.size, cover.size], format: 'r32float', usage: TEXTURE.TEXTURE_BINDING | TEXTURE.COPY_DST }),
            size: cover.size, version: -1,
          };
        }
        if (this.#cover.version !== cover.version) {
          this.#device.queue.writeTexture({ texture: this.#cover.texture }, cover.heights, { bytesPerRow: cover.size * 4 }, { width: cover.size, height: cover.size });
          this.#cover.version = cover.version;
        }
      }
      this.#uploaded = plan;
    }
    return this.#uniforms;
  }

  #group(buffer: GpuBuffer, depth: GpuTexture, cube: GpuTexture | null, plan: NaturePlan): unknown {
    return this.#device.createBindGroup({
      layout: this.#layout,
      entries: [
        { binding: 0, resource: { buffer, size: floatsOf(NATURE_FIELDS) * 4 } },
        { binding: 1, resource: depth.createView() },
        { binding: 2, resource: (cube ?? this.#blackCube).createView({ dimension: 'cube' }) },
        { binding: 3, resource: this.#sampler },
        { binding: 4, resource: (plan.cover !== null && this.#cover !== null ? this.#cover.texture : this.#noCover).createView() },
      ],
    });
  }

  /** Render one face of the environment cube's sky (level 0) from the plan's sky. */
  environmentFace(encoder: GpuEncoder, target: GpuTextureView, face: number, size: number, plan: NaturePlan): void {
    const buffer = this.#upload(plan);
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: target, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
    pass.setViewport(0, 0, size, size, 0, 1);
    pass.setPipeline(this.#pipeline('face', plan.quality, plan.clouds));
    pass.setBindGroup(0, this.#group(buffer, this.#dummyDepth, null, plan), [faceSlot(plan, face) * NATURE_SLOT * 4]);
    pass.draw(3);
    pass.end();
  }

  /** One view's outdoors: the composite, the water, then the far fade over both. */
  draw(encoder: GpuEncoder, t: NatureTargetsGpu): void {
    const plan = t.plan;
    const buffer = this.#upload(plan);
    const vp = t.viewport;
    const offset = [t.view * NATURE_SLOT * 4];
    const fullscreen = (kind: 'composite' | 'fade'): void => {
      const pass = encoder.beginRenderPass({ colorAttachments: [{ view: t.color.createView(), loadOp: 'load', storeOp: 'store' }] });
      pass.setViewport(vp.x, vp.y, vp.width, vp.height, 0, 1);
      pass.setScissorRect(Math.floor(vp.x), Math.floor(vp.y), Math.max(1, Math.min(t.width, Math.round(vp.x + vp.width)) - Math.floor(vp.x)), Math.max(1, Math.min(t.height, Math.round(vp.y + vp.height)) - Math.floor(vp.y)));
      pass.setPipeline(this.#pipeline(kind, plan.quality, plan.clouds));
      pass.setBindGroup(0, this.#group(buffer, t.depth, t.cube, plan), offset);
      pass.draw(3);
      pass.end();
    };
    if (plan.sky !== null || plan.nature.weather !== null) fullscreen('composite');
    if (plan.bodies.length > 0) this.#water.draw(encoder, t, buffer);
    if (plan.uniforms[t.view * NATURE_SLOT + VIEW_FADE_END]! > 0) fullscreen('fade');
  }

  dispose(): void {
    this.#uniforms?.destroy();
    this.#cover?.texture.destroy();
    this.#noCover.destroy();
    this.#blackCube.destroy();
    this.#dummyDepth.destroy();
    this.#water.dispose();
  }
}
