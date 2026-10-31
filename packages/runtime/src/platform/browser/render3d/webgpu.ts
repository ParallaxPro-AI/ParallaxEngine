/**
 * The WebGPU backend. Draws a plan into HDR targets and through the post chain
 * (plan.ts `visitPasses`), then presents into the canvas:
 *
 *   targets      rgba16float color (two, when a resolve pass runs) + rgba16float normals/
 *                roughness + depth32float (sampled by the screen-space passes), r8unorm AO
 *                (two: raw and blurred), rgba16float reflections and outline mask, an
 *                rgba16float bloom mip chain, an rgba8unorm LDR image; recreated on resize
 *   shadows      two depth32float atlases (sun cascades, point/spot faces), compared
 *                through one comparison sampler
 *   lighting     light, cluster-grid and cluster-item data textures, rewritten each frame
 *   environment  the sky cube and its GGX-prefiltered copy, rebuilt when the sky changes
 *   uniforms     dynamic-offset slots: one per view, per material, per shadow tile, per
 *                environment face
 *
 * Textures are mipmapped on upload (`WGSL_MIPMAP` blits). Antialiasing is FXAA in the
 * present pass (MSAA can't coexist with sampled depth and the HDR chain cheaply).
 */

import { fail } from '../../../core/index.js';
import type { Geometry3d, Wrap } from '../../../core/index.js';
import { BUFFER, GeometryCache, MAP_READ, NO_RESOURCES, STAGE, TEXTURE } from './backend.js';
import { WGSL_HIZ } from './occlusion.js';
import type { DepthGrid } from './occlusion.js';
import type { CompressionFamily } from './backend.js';
import type { BlockFormat, Ktx2Image } from './ktx2.js';
import type {
  Backend3d, BackendTexture, Desc, FrameResources, GpuBuffer, GpuCanvasContext, GpuDevice, GpuEncoder, GpuRenderPass, GpuTexture, GpuTextureView, TextureArrayOptions, TextureDesc, TextureImage,
} from './backend.js';
import { environmentMips } from './ibl.js';
import {
  BILLBOARD_INSTANCE_FLOATS, CASTER_FIELDS, CASTER_SLOT, DATA_ROW, FRAME_FIELDS, FRAME_SLOT, floatsOf, LINE_VERTEX_FLOATS, LOCATION as L,
  bindingId, MATERIAL_FIELDS, MATERIAL_SLOT, MESH_INSTANCE_FLOATS, OUTLINE_FIELDS, SHADOW_FIELDS, TERRAIN_FIELDS, transmissive,
} from './layout.js';
import { visitPasses } from './plan.js';
import type { BillboardItem, EnvironmentPlan, FramePlan, MeshItem, OcclusionPlan, ShadowTile, TerrainItem, TextureRef, ViewPlan } from './plan.js';
import { ENV_FIELDS, ENV_SLOT, POST_BINDINGS, VIEW_PASSES, wgslPost } from './post_shaders.js';
import type { PostPass, PostVariant } from './post_shaders.js';
import { FRAME_BINDINGS, wgsl } from './shaders.js';
import type { ScenePass, SceneVariant } from './shaders.js';
import { edgeIndices } from './wireframe.js';
import { NatureWebGpu } from './sky_webgpu.js';
import { VfxWebGpu } from './vfx_webgpu.js';
import { DofWebGpu } from './dof_webgpu.js';
import { DECAL_FLOATS, wgslDecal } from './decals.js';
import { BAKE_FIELDS, BAKE_SLOT, IMPOSTOR_FIELDS, IMPOSTOR_INSTANCE_FLOATS, IMPOSTOR_SLOT, packBake, wgslBake, wgslImpostor } from './impostors.js';
import type { ImpostorFrame } from './impostors.js';
import type { NaturePlan } from './sky_plan.js';

const HDR = 'rgba16float';
const DEPTH = 'depth32float';
const LDR = 'rgba8unorm';

/** Prefilter samples per environment texel, by cube size. */
export function prefilterSamples(size: number): number {
  return size >= 128 ? 64 : size >= 64 ? 32 : 16;
}

interface GpuTextureHandle extends BackendTexture {
  readonly backend: 'webgpu';
  readonly texture: GpuTexture;
  readonly view: GpuTextureView;
  readonly sampler: unknown;
}

/** A Hi-Z read-back slot: the reduced grid, its mappable copy, the reduction's parameters. */
interface Readback {
  readonly width: number;
  readonly height: number;
  readonly bytesPerRow: number;
  readonly texture: GpuTexture;
  readonly buffer: GpuBuffer;
  readonly params: GpuBuffer;
  busy: boolean;
  mapping?: boolean;
  pending: OcclusionPlan | null;
}

interface GpuGeometry {
  readonly position: GpuBuffer;
  readonly normal: GpuBuffer;
  readonly uv: GpuBuffer;
  readonly color: GpuBuffer;
  readonly joints: GpuBuffer | null;
  readonly weights: GpuBuffer | null;
  readonly index: GpuBuffer;
  readonly indexFormat: 'uint16' | 'uint32';
  readonly indexCount: number;
  readonly vertexCount: number;
}

interface Edges {
  readonly index: GpuBuffer;
  readonly count: number;
}

interface Targets {
  readonly width: number;
  readonly height: number;
  readonly hdr: readonly [GpuTexture, GpuTexture];
  readonly gbuf: GpuTexture;
  readonly depth: GpuTexture;
  readonly ao: readonly [GpuTexture, GpuTexture];
  readonly aoScale: number;
  readonly ssr: GpuTexture;
  readonly mask: GpuTexture;
  readonly ldr: GpuTexture;
  readonly bloom: readonly GpuTexture[];
  readonly version: number;
}

const WRAP: Record<Wrap, string> = { repeat: 'repeat', clamp: 'clamp-to-edge', mirror: 'mirror-repeat' };

const vertexBuffer = (location: number, format: string, stride: number): Desc => ({
  arrayStride: stride, stepMode: 'vertex', attributes: [{ shaderLocation: location, offset: 0, format }],
});

const MESH_INSTANCE_LAYOUT: Desc = {
  arrayStride: MESH_INSTANCE_FLOATS * 4,
  stepMode: 'instance',
  attributes: [L.model0, L.model1, L.model2, L.model3, L.normal0, L.normal1, L.normal2, L.tint]
    .map((shaderLocation, i) => ({ shaderLocation, offset: i * 16, format: 'float32x4' })),
};

const recordLayout = (floats: number, count: number, stepMode: string): Desc => ({
  arrayStride: floats * 4,
  stepMode,
  attributes: Array.from({ length: count }, (_, i) => ({ shaderLocation: i, offset: i * 16, format: 'float32x4' })),
});

/** The vertex buffers a scene pass binds, in slot order. */
export function webgpuVertexLayouts(pass: ScenePass, skinned: boolean): Desc[] {
  const skin = skinned ? [vertexBuffer(L.joints, 'uint16x4', 8), vertexBuffer(L.weights, 'float32x4', 16)] : [];
  switch (pass) {
    case 'caster': case 'outline': return [vertexBuffer(L.position, 'float32x3', 12), ...skin, MESH_INSTANCE_LAYOUT];
    case 'mesh':
      return [
        vertexBuffer(L.position, 'float32x3', 12), vertexBuffer(L.normal, 'float32x3', 12), vertexBuffer(L.uv, 'float32x2', 8),
        vertexBuffer(L.color, 'float32x4', 16), ...skin, MESH_INSTANCE_LAYOUT,
      ];
    case 'terrain':
      return [
        vertexBuffer(L.position, 'float32x3', 12), vertexBuffer(L.normal, 'float32x3', 12), vertexBuffer(L.uv, 'float32x2', 8),
        vertexBuffer(L.color, 'float32x4', 16),
      ];
    case 'billboard': return [recordLayout(BILLBOARD_INSTANCE_FLOATS, 5, 'instance')];
    case 'line': return [recordLayout(LINE_VERTEX_FLOATS, 4, 'vertex')];
    case 'sky': return [];
  }
}

const BLEND = {
  color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};
/** Transmissive surfaces (glass): color already carries its own light, the background shows through by 1 - alpha. */
const PREMULTIPLIED = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};
const ADD = {
  color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
  alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
};

function mipLevels(width: number, height: number): number {
  return Math.floor(Math.log2(Math.max(width, height))) + 1;
}

interface PipelineKey {
  readonly pass: ScenePass;
  readonly variant: SceneVariant;
  readonly targets: readonly string[];
  readonly blend: false | 'alpha' | 'premultiplied';
  readonly cull: 'back' | 'front' | 'none';
  readonly topology: 'triangle-list' | 'line-list';
  readonly depthWrite: boolean;
  readonly depthCompare: string;
}

export class WebGpuBackend implements Backend3d {
  readonly kind = 'webgpu';
  readonly #device: GpuDevice;
  readonly #context: GpuCanvasContext;
  readonly #format: string;
  readonly #layouts: Record<string, unknown>;
  readonly #pipelines = new Map<string, unknown>();
  readonly #mipPipelines = new Map<string, unknown>();
  readonly #geometry: GeometryCache<GpuGeometry>;
  readonly #edges: GeometryCache<Edges>;
  readonly #buffers = new Map<string, GpuBuffer>();
  readonly #groups = new Map<string, unknown>();
  /** The texture handles each cached material group was built from. */
  readonly #materialMaps = new Map<string, readonly GpuTextureHandle[]>();
  readonly #imageGroups = new WeakMap<GpuTextureHandle, unknown>();
  /** Render targets by use: the screen's, and a capture's (photos and portraits draw at their own size). */
  readonly #targetSets = new Map<'screen' | 'capture', Targets>();
  #targetVersion = 0;
  #atlas: { sun: GpuTexture | null; local: GpuTexture | null } = { sun: null, local: null };
  #data: { lights: GpuTexture; grid: GpuTexture; items: GpuTexture } | null = null;
  #env: { key: string; size: number; sky: GpuTexture; cube: GpuTexture } | null = null;
  /** Bumped whenever a resource named by the frame bind group is replaced. */
  #resources = 0;
  readonly #dummyDepth: GpuTexture;
  readonly #shadowSampler: unknown;
  readonly #linearSampler: unknown;
  readonly #mipSampler: unknown;
  readonly #white: GpuTextureHandle;
  readonly #black: GpuTextureHandle;
  readonly #nature: NatureWebGpu;
  /** Effect particles and ribbons (vfx.ts). */
  readonly #vfx: VfxWebGpu;
  readonly #dof: DofWebGpu;
  /** Distinct decal arrays seen (their bind groups' keys). */
  readonly #decalArrays = new WeakMap<GpuTextureHandle, number>();
  readonly #readbacks: Readback[] = [];
  /** Fog-of-war cell textures by view slot, with the key they hold. */
  readonly #fogTextures = new Map<number, { key: string; width: number; height: number; texture: GpuTexture; id: number }>();
  #fogIds = 0;
  #depthReady: DepthGrid | null = null;
  #decalArrayCount = 0;
  /** Baked impostor atlases by source id, and the frame each was last drawn. */
  readonly #atlases3d = new Map<string, { albedo: GpuTexture; normal: GpuTexture; group: unknown; used: number }>();
  /** Offscreen views' render targets (camera feeds, mirrors), by id. */
  readonly #renderTargets = new Map<string, { handle: GpuTextureHandle; levels: number; width: number; height: number }>();
  #frameCount = 0;
  /** Scratch resources this frame's encoder uses, destroyed once it is submitted (destroying them earlier fails the submit). */
  #afterSubmit: { destroy(): void }[] = [];

  constructor(device: GpuDevice, context: GpuCanvasContext, format: string) {
    this.#device = device;
    this.#context = context;
    this.#format = format;
    context.configure({ device, format, alphaMode: 'opaque' });
    const both = STAGE.VERTEX | STAGE.FRAGMENT;
    const F = STAGE.FRAGMENT;
    const tex = (binding: number, sampleType = 'float', viewDimension = '2d'): Desc => ({ binding, visibility: F, texture: { sampleType, viewDimension } });
    const samp = (binding: number, type = 'filtering'): Desc => ({ binding, visibility: F, sampler: { type } });
    const uniform = (binding: number, fields: Parameters<typeof floatsOf>[0], dynamic = true, visibility = both): Desc => ({
      binding, visibility, buffer: { type: 'uniform', hasDynamicOffset: dynamic, minBindingSize: floatsOf(fields) * 4 },
    });
    const B = FRAME_BINDINGS;
    this.#layouts = {
      frame: device.createBindGroupLayout({
        entries: [
          uniform(B.frame, FRAME_FIELDS),
          uniform(B.shadowTiles, SHADOW_FIELDS, false, F),
          tex(B.sunAtlas, 'depth'), tex(B.localAtlas, 'depth'), samp(B.shadowSampler, 'comparison'),
          { binding: B.palette, visibility: STAGE.VERTEX, buffer: { type: 'read-only-storage' } },
          tex(B.lightData, 'unfilterable-float'), tex(B.clusterGrid, 'uint'), tex(B.clusterItems, 'uint'),
          tex(B.envCube, 'float', 'cube'), samp(B.envSampler),
        ],
      }),
      caster: device.createBindGroupLayout({
        entries: [uniform(0, CASTER_FIELDS, true, STAGE.VERTEX), { binding: 1, visibility: STAGE.VERTEX, buffer: { type: 'read-only-storage' } }],
      }),
      material: device.createBindGroupLayout({
        entries: [uniform(0, MATERIAL_FIELDS, true), tex(1), samp(2), tex(3), samp(4), tex(5), samp(6), tex(7), samp(8), tex(9), samp(10)],
      }),
      terrain: device.createBindGroupLayout({ entries: [uniform(0, TERRAIN_FIELDS), tex(1, 'float', '2d-array'), tex(2, 'float', '2d-array'), tex(3), tex(4), tex(5), tex(6), samp(7), tex(8)] }),
      image: device.createBindGroupLayout({ entries: [tex(0), samp(1)] }),
      outline: device.createBindGroupLayout({ entries: [uniform(0, OUTLINE_FIELDS, true, F)] }),
      postFrame: device.createBindGroupLayout({ entries: [uniform(0, FRAME_FIELDS, true, F)] }),
      bake: device.createBindGroupLayout({ entries: [uniform(0, BAKE_FIELDS), tex(1), samp(2)] }),
      // The impostor vertex shader reads its sphere and frame parameters to build
      // each camera-facing quad; the fragment shader also reads roughness.
      impostor: device.createBindGroupLayout({ entries: [uniform(0, IMPOSTOR_FIELDS, true, both), tex(1), tex(2), samp(3)] }),
      decals: device.createBindGroupLayout({ entries: [tex(0, 'depth'), tex(1, 'float', '2d-array'), samp(2)] }),
      hiz: device.createBindGroupLayout({ entries: [tex(0, 'depth'), { binding: 1, visibility: F, buffer: { type: 'uniform' } }] }),
      mip: device.createBindGroupLayout({ entries: [tex(0), samp(1)] }),
    };
    for (const pass of Object.keys(POST_BINDINGS) as PostPass[]) {
      this.#layouts[`post:${pass}`] = device.createBindGroupLayout({
        entries: POST_BINDINGS[pass].map((b, i) => {
          switch (b.kind) {
            case 'depth': return tex(i, 'depth');
            case 'float': return tex(i);
            case 'cube': return tex(i, 'float', 'cube');
            case 'linear': return samp(i);
            case 'env': return uniform(i, ENV_FIELDS, true, F);
          }
        }),
      });
    }
    this.#geometry = new GeometryCache<GpuGeometry>((g: Geometry3d) => this.#upload(g), (g) => {
      for (const b of [g.position, g.normal, g.uv, g.color, g.joints, g.weights, g.index]) b?.destroy();
    }, 600, (gpu: GpuGeometry, g: Geometry3d) => {
      // Dynamic geometry: same vertex and index counts → rewrite positions, normals and colors in place.
      if (g.positions.length / 3 !== gpu.vertexCount || g.indices.length !== gpu.indexCount) return false;
      this.#device.queue.writeBuffer(gpu.position, 0, g.positions);
      this.#device.queue.writeBuffer(gpu.normal, 0, g.normals);
      if (g.colors !== null) this.#device.queue.writeBuffer(gpu.color, 0, g.colors);
      return true;
    });
    this.#edges = new GeometryCache<Edges>((g: Geometry3d) => {
      const indices = edgeIndices(g);
      return { index: this.#static(indices, BUFFER.INDEX), count: indices.length };
    }, (e) => e.index.destroy());
    this.#dummyDepth = device.createTexture({ size: [1, 1], format: DEPTH, usage: TEXTURE.TEXTURE_BINDING | TEXTURE.RENDER_ATTACHMENT });
    this.#shadowSampler = device.createSampler({ compare: 'less', magFilter: 'linear', minFilter: 'linear' });
    this.#linearSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    this.#mipSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' });
    const pixel = (rgba: number[]): GpuTextureHandle => {
      const t = device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: TEXTURE.TEXTURE_BINDING | TEXTURE.COPY_DST });
      device.queue.writeTexture({ texture: t }, new Uint8Array(rgba), { bytesPerRow: 4 }, { width: 1, height: 1 });
      return { backend: 'webgpu', texture: t, view: t.createView(), sampler: device.createSampler({}) };
    };
    this.#white = pixel([255, 255, 255, 255]);
    this.#black = pixel([0, 0, 0, 0]);
    this.#nature = new NatureWebGpu(device);
    this.#vfx = new VfxWebGpu(device, this.#layouts['frame']);
    this.#dof = new DofWebGpu(device);
  }

  // ── Resources ─────────────────────────────────────────────────────────────────

  createTexture(image: TextureImage, desc: TextureDesc): BackendTexture {
    const device = this.#device;
    const format = desc.colorSpace === 'srgb' ? 'rgba8unorm-srgb' : 'rgba8unorm';
    const levels = mipLevels(image.width, image.height);
    const texture = device.createTexture({
      size: [image.width, image.height],
      format,
      mipLevelCount: levels,
      usage: TEXTURE.TEXTURE_BINDING | TEXTURE.COPY_DST | TEXTURE.RENDER_ATTACHMENT,
    });
    device.queue.copyExternalImageToTexture({ source: image }, { texture }, [image.width, image.height]);
    this.#generateMips(texture, format, levels);
    const filter = desc.filter === 'nearest' ? 'nearest' : 'linear';
    const sampler = device.createSampler({
      addressModeU: WRAP[desc.wrapU], addressModeV: WRAP[desc.wrapV],
      magFilter: filter, minFilter: filter, mipmapFilter: filter, maxAnisotropy: filter === 'linear' ? 8 : 1,
    });
    const handle: GpuTextureHandle = { backend: 'webgpu', texture, view: texture.createView(), sampler };
    return handle;
  }

  destroyTexture(texture: BackendTexture): void {
    (texture as GpuTextureHandle).texture.destroy();
  }

  get compressed(): readonly CompressionFamily[] {
    const features = this.#device.features;
    const families: CompressionFamily[] = [];
    if (features?.has('texture-compression-bc') === true) families.push('bc');
    if (features?.has('texture-compression-astc') === true) families.push('astc');
    if (features?.has('texture-compression-etc2') === true) families.push('etc2');
    return families;
  }

  createCompressedTexture(image: Ktx2Image, format: BlockFormat, desc: TextureDesc): BackendTexture | null {
    if (!this.compressed.includes(format.family) || image.width % 4 !== 0 || image.height % 4 !== 0) return null;
    const device = this.#device;
    const texture = device.createTexture({
      size: [image.width, image.height], format: desc.colorSpace === 'srgb' ? format.webgpu.srgb : format.webgpu.unorm,
      mipLevelCount: image.levels.length, usage: TEXTURE.TEXTURE_BINDING | TEXTURE.COPY_DST,
    });
    image.levels.forEach((bytes, level) => {
      const w = Math.max(1, image.width >> level);
      const h = Math.max(1, image.height >> level);
      const blocksWide = Math.ceil(w / 4);
      const blocksHigh = Math.ceil(h / 4);
      device.queue.writeTexture({ texture, mipLevel: level }, bytes, { bytesPerRow: blocksWide * format.bytesPerBlock, rowsPerImage: blocksHigh },
        { width: blocksWide * 4, height: blocksHigh * 4 });
    });
    const filter = desc.filter === 'nearest' ? 'nearest' : 'linear';
    const sampler = device.createSampler({
      addressModeU: WRAP[desc.wrapU], addressModeV: WRAP[desc.wrapV],
      magFilter: filter, minFilter: filter, mipmapFilter: filter, maxAnisotropy: filter === 'linear' ? 8 : 1,
    });
    const handle: GpuTextureHandle = { backend: 'webgpu', texture, view: texture.createView(), sampler };
    return handle;
  }

  /** Mip levels 1.. from level 0 (of one array layer), recorded into `into` or submitted on their own. */
  #generateMips(texture: GpuTexture, format: string, levels: number, layer = 0, into?: GpuEncoder): void {
    if (levels <= 1) return;
    const device = this.#device;
    let pipeline = this.#mipPipelines.get(format);
    if (pipeline === undefined) {
      const module = device.createShaderModule({ code: WGSL_MIPMAP });
      pipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [this.#layouts['mip']] }),
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format }] },
        primitive: { topology: 'triangle-list' },
      });
      this.#mipPipelines.set(format, pipeline);
    }
    const encoder = into ?? device.createCommandEncoder();
    const level = (l: number): Desc => ({ dimension: '2d', baseMipLevel: l, mipLevelCount: 1, baseArrayLayer: layer, arrayLayerCount: 1 });
    for (let l = 1; l < levels; l++) {
      const group = device.createBindGroup({
        layout: this.#layouts['mip'],
        entries: [{ binding: 0, resource: texture.createView(level(l - 1)) }, { binding: 1, resource: this.#mipSampler }],
      });
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: texture.createView(level(l)), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.draw(3);
      pass.end();
    }
    if (into === undefined) device.queue.submit([encoder.finish()]);
  }

  createTextureArray(images: readonly TextureImage[], size: number, options: TextureArrayOptions = {}): BackendTexture {
    const device = this.#device;
    const format = options.colorSpace === 'linear' ? 'rgba8unorm' : 'rgba8unorm-srgb';
    const address = options.wrap === 'repeat' ? 'repeat' : 'clamp-to-edge';
    const levels = mipLevels(size, size);
    const layers = Math.max(1, images.length);
    const texture = device.createTexture({
      size: [size, size, layers], format, mipLevelCount: levels, usage: TEXTURE.TEXTURE_BINDING | TEXTURE.COPY_DST | TEXTURE.RENDER_ATTACHMENT,
    });
    images.forEach((image, i) => {
      device.queue.copyExternalImageToTexture({ source: image }, { texture, origin: [0, 0, i] }, [size, size]);
      this.#generateMips(texture, format, levels, i);
    });
    const sampler = device.createSampler({
      addressModeU: address, addressModeV: address, magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', maxAnisotropy: 8,
    });
    const handle: GpuTextureHandle = { backend: 'webgpu', texture, view: texture.createView({ dimension: '2d-array' }), sampler };
    return handle;
  }

  #terrainArrays: { albedo: BackendTexture; normal: BackendTexture } | null = null;

  /** Placeholder terrain arrays for a frame drawn without the surface's (one uninitialized layer each). */
  #emptyTerrainArrays(): { albedo: BackendTexture; normal: BackendTexture } {
    this.#terrainArrays ??= {
      albedo: this.createTextureArray([], 4, { wrap: 'repeat' }),
      normal: this.createTextureArray([], 4, { colorSpace: 'linear', wrap: 'repeat' }),
    };
    return this.#terrainArrays;
  }

  target(id: string): BackendTexture | null {
    return this.#renderTargets.get(id)?.handle ?? null;
  }

  dropTarget(id: string): void {
    const t = this.#renderTargets.get(id);
    if (t === undefined) return;
    t.handle.texture.destroy();
    this.#renderTargets.delete(id);
  }

  /** The render target `id` at a size (made, or remade when its size changed). */
  #renderTarget(id: string, width: number, height: number): { handle: GpuTextureHandle; levels: number } {
    const known = this.#renderTargets.get(id);
    if (known !== undefined && known.width === width && known.height === height) return known;
    if (known !== undefined) known.handle.texture.destroy();
    const levels = mipLevels(width, height);
    const texture = this.#device.createTexture({
      size: [width, height], format: 'rgba8unorm-srgb', mipLevelCount: levels,
      usage: TEXTURE.TEXTURE_BINDING | TEXTURE.COPY_DST | TEXTURE.RENDER_ATTACHMENT,
    });
    const sampler = this.#device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    const made = { handle: { backend: 'webgpu' as const, texture, view: texture.createView(), sampler }, levels, width, height };
    this.#renderTargets.set(id, made);
    return made;
  }

  #static(data: ArrayBufferView, usage: number): GpuBuffer {
    const size = Math.max(4, Math.ceil(data.byteLength / 4) * 4);
    const buffer = this.#device.createBuffer({ size, usage: usage | BUFFER.COPY_DST });
    if (data.byteLength % 4 === 0) {
      this.#device.queue.writeBuffer(buffer, 0, data);
    } else {
      const padded = new Uint8Array(size);
      padded.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      this.#device.queue.writeBuffer(buffer, 0, padded);
    }
    return buffer;
  }

  #upload(g: Geometry3d): GpuGeometry {
    const vertices = g.positions.length / 3;
    return {
      position: this.#static(g.positions, BUFFER.VERTEX),
      normal: this.#static(g.normals, BUFFER.VERTEX),
      uv: this.#static(g.uvs, BUFFER.VERTEX),
      color: this.#static(g.colors ?? new Float32Array(vertices * 4).fill(1), BUFFER.VERTEX),
      joints: g.joints === null ? null : this.#static(g.joints, BUFFER.VERTEX),
      weights: g.weights === null ? null : this.#static(g.weights, BUFFER.VERTEX),
      index: this.#static(g.indices, BUFFER.INDEX),
      indexFormat: g.indices instanceof Uint32Array ? 'uint32' : 'uint16',
      indexCount: g.indices.length,
      vertexCount: vertices,
    };
  }

  /** A buffer at least `bytes` long; growing it replaces it (and every bind group naming it). */
  #buffer(name: string, bytes: number, usage: number): GpuBuffer {
    const current = this.#buffers.get(name);
    if (current !== undefined && current.size >= bytes) return current;
    current?.destroy();
    const size = Math.max(256, 2 ** Math.ceil(Math.log2(Math.max(bytes, 1))));
    const buffer = this.#device.createBuffer({ size, usage: usage | BUFFER.COPY_DST });
    this.#buffers.set(name, buffer);
    this.#groups.clear();
    this.#resources++;
    return buffer;
  }

  #write(name: string, data: Float32Array, usage: number): GpuBuffer {
    const buffer = this.#buffer(name, data.byteLength, usage);
    if (data.byteLength > 0) this.#device.queue.writeBuffer(buffer, 0, data);
    return buffer;
  }

  #group(key: string, make: () => unknown): unknown {
    let group = this.#groups.get(key);
    if (group === undefined) {
      group = make();
      this.#groups.set(key, group);
    }
    return group;
  }

  // ── Targets, atlases, data textures, environment ─────────────────────────────

  #texture(width: number, height: number, format: string, usage = TEXTURE.RENDER_ATTACHMENT | TEXTURE.TEXTURE_BINDING): GpuTexture {
    return this.#device.createTexture({ size: [Math.max(1, width), Math.max(1, height)], format, usage });
  }

  #targetsFor(plan: FramePlan, use: 'screen' | 'capture'): Targets {
    const { width, height } = plan;
    const aoScale = plan.flags.ao === 'half' ? 2 : 1;
    const bloomLevels = Math.max(1, plan.quality.bloomLevels);
    const t = this.#targetSets.get(use) ?? null;
    if (t !== null && t.width === width && t.height === height && t.aoScale === aoScale && t.bloom.length === bloomLevels) return t;
    if (t !== null) for (const x of [...t.hdr, t.gbuf, t.depth, ...t.ao, t.ssr, t.mask, t.ldr, ...t.bloom]) x.destroy();
    const bloom: GpuTexture[] = [];
    for (let i = 0, w = Math.ceil(width / 2), h = Math.ceil(height / 2); i < bloomLevels; i++, w = Math.ceil(w / 2), h = Math.ceil(h / 2)) {
      bloom.push(this.#texture(w, h, HDR));
    }
    const aoW = Math.ceil(width / aoScale);
    const aoH = Math.ceil(height / aoScale);
    const made: Targets = {
      width, height, aoScale,
      hdr: [this.#texture(width, height, HDR), this.#texture(width, height, HDR)],
      gbuf: this.#texture(width, height, HDR),
      depth: this.#texture(width, height, DEPTH),
      ao: [this.#texture(aoW, aoH, 'r8unorm'), this.#texture(aoW, aoH, 'r8unorm')],
      ssr: this.#texture(width, height, HDR),
      mask: this.#texture(width, height, HDR),
      ldr: this.#texture(width, height, LDR, TEXTURE.RENDER_ATTACHMENT | TEXTURE.TEXTURE_BINDING | TEXTURE.COPY_SRC),
      bloom,
      version: ++this.#targetVersion,
    };
    this.#targetSets.set(use, made);
    return made;
  }

  #atlases(plan: FramePlan): void {
    const want = (current: GpuTexture | null, size: number, used: boolean): GpuTexture | null => {
      if (!used) return current;
      if (current !== null && current.width === size) return current;
      current?.destroy();
      this.#resources++;
      this.#groups.clear();
      return this.#texture(size, size, DEPTH);
    };
    this.#atlas = {
      sun: want(this.#atlas.sun, plan.sunAtlas, plan.shadowTiles.some((t) => t.atlas === 'sun')),
      local: want(this.#atlas.local, plan.localAtlas, plan.shadowTiles.some((t) => t.atlas === 'local')),
    };
  }

  #dataTextures(plan: FramePlan): { lights: GpuTexture; grid: GpuTexture; items: GpuTexture } {
    const rows = (floats: number, perTexel: number): number => Math.max(1, Math.ceil(floats / perTexel / DATA_ROW));
    const lightRows = rows(plan.lights.length, 4);
    const gridRows = rows(plan.clusters.grid.length, 2);
    const itemRows = rows(plan.clusters.items.length, 1);
    let d = this.#data;
    if (d === null || d.lights.height < lightRows || d.grid.height < gridRows || d.items.height < itemRows) {
      if (d !== null) for (const t of [d.lights, d.grid, d.items]) t.destroy();
      const usage = TEXTURE.TEXTURE_BINDING | TEXTURE.COPY_DST;
      const grow = (n: number, have: number | undefined): number => Math.max(n, have ?? 0);
      d = {
        lights: this.#texture(DATA_ROW, grow(lightRows, this.#data?.lights.height), 'rgba32float', usage),
        grid: this.#texture(DATA_ROW, grow(gridRows, this.#data?.grid.height), 'rg32uint', usage),
        items: this.#texture(DATA_ROW, grow(itemRows * 2, this.#data?.items.height), 'r32uint', usage),
      };
      this.#data = d;
      this.#resources++;
      this.#groups.clear();
    }
    const q = this.#device.queue;
    q.writeTexture({ texture: d.lights }, plan.lights, { bytesPerRow: DATA_ROW * 16 }, { width: DATA_ROW, height: lightRows });
    q.writeTexture({ texture: d.grid }, plan.clusters.grid, { bytesPerRow: DATA_ROW * 8 }, { width: DATA_ROW, height: gridRows });
    q.writeTexture({ texture: d.items }, plan.clusters.items, { bytesPerRow: DATA_ROW * 4 }, { width: DATA_ROW, height: itemRows });
    return d;
  }

  #frameGroup(): unknown {
    const d = this.#data!;
    const env = this.#env!;
    const B = FRAME_BINDINGS;
    return this.#group(`frame|${this.#resources}`, () => this.#device.createBindGroup({
      layout: this.#layouts['frame'],
      entries: [
        { binding: B.frame, resource: { buffer: this.#buffers.get('frames')!, size: floatsOf(FRAME_FIELDS) * 4 } },
        { binding: B.shadowTiles, resource: { buffer: this.#buffers.get('shadowBlock')! } },
        { binding: B.sunAtlas, resource: (this.#atlas.sun ?? this.#dummyDepth).createView() },
        { binding: B.localAtlas, resource: (this.#atlas.local ?? this.#dummyDepth).createView() },
        { binding: B.shadowSampler, resource: this.#shadowSampler },
        { binding: B.palette, resource: { buffer: this.#buffers.get('palette')! } },
        { binding: B.lightData, resource: d.lights.createView() },
        { binding: B.clusterGrid, resource: d.grid.createView() },
        { binding: B.clusterItems, resource: d.items.createView() },
        { binding: B.envCube, resource: env.cube.createView({ dimension: 'cube' }) },
        { binding: B.envSampler, resource: this.#mipSampler },
      ],
    }));
  }

  // ── Pipelines ────────────────────────────────────────────────────────────────

  #scenePipeline(k: PipelineKey): unknown {
    const key = JSON.stringify(k);
    let pipeline = this.#pipelines.get(key);
    if (pipeline !== undefined) return pipeline;
    const device = this.#device;
    const module = device.createShaderModule({ code: wgsl(k.pass, k.variant) });
    const group1: Partial<Record<ScenePass, string>> = { mesh: 'material', terrain: 'terrain', billboard: 'image', outline: 'outline', sky: 'image' };
    const layouts = k.pass === 'caster' ? [this.#layouts['caster']] : [this.#layouts['frame'], ...(group1[k.pass] === undefined ? [] : [this.#layouts[group1[k.pass]!]])];
    const caster = k.pass === 'caster';
    pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: layouts }),
      vertex: { module, entryPoint: 'vs', buffers: webgpuVertexLayouts(k.pass, k.variant.skinned === true) },
      ...(!caster && {
        fragment: {
          module, entryPoint: 'fs',
          targets: k.targets.map((format, i) => ({ format, ...(k.blend !== false && i === 0 && { blend: k.blend === 'alpha' ? BLEND : PREMULTIPLIED }) })),
        },
      }),
      primitive: { topology: k.topology, frontFace: 'cw', cullMode: k.cull },
      depthStencil: {
        format: DEPTH,
        depthWriteEnabled: k.depthWrite,
        depthCompare: k.depthCompare,
        ...(caster && { depthBias: 2, depthBiasSlopeScale: 2 }),
        ...(k.pass === 'outline' && { depthBias: -4, depthBiasSlopeScale: -1 }),
      },
    });
    this.#pipelines.set(key, pipeline);
    return pipeline;
  }

  #postPipeline(pass: PostPass, variant: PostVariant, format: string, additive: boolean): unknown {
    const key = `post|${pass}|${JSON.stringify(variant)}|${format}|${additive}`;
    let pipeline = this.#pipelines.get(key);
    if (pipeline !== undefined) return pipeline;
    const device = this.#device;
    const module = device.createShaderModule({ code: wgslPost(pass, variant) });
    const own = this.#layouts[`post:${pass}`];
    const layouts = VIEW_PASSES.includes(pass)
      ? [this.#layouts['frame'], own]
      : pass === 'envSky' || pass === 'envPrefilter' ? [own] : [own, this.#layouts['postFrame']];
    pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: layouts }),
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format, ...(pass === 'fogOfWar' ? { blend: PREMULTIPLIED } : additive && { blend: ADD }) }] },
      primitive: { topology: 'triangle-list' },
    });
    this.#pipelines.set(key, pipeline);
    return pipeline;
  }

  /** A post pass's own bind group from views and samplers in binding order. */
  #postGroup(pass: PostPass, key: string, resources: readonly unknown[]): unknown {
    return this.#group(`post|${pass}|${key}`, () => this.#device.createBindGroup({
      layout: this.#layouts[`post:${pass}`],
      entries: resources.map((resource, binding) => ({ binding, resource })),
    }));
  }

  // ── The environment cube ─────────────────────────────────────────────────────

  #environment(env: EnvironmentPlan, encoder: GpuEncoder, nature: NaturePlan | null, skyImage: GpuTextureHandle): void {
    if (this.#env !== null && this.#env.key === env.key) return;
    const size = env.size;
    if (this.#env === null || this.#env.size !== size) {
      this.#env?.sky.destroy();
      this.#env?.cube.destroy();
      const usage = TEXTURE.RENDER_ATTACHMENT | TEXTURE.TEXTURE_BINDING;
      this.#env = {
        key: '', size,
        sky: this.#device.createTexture({ size: [size, size, 6], format: HDR, usage }),
        cube: this.#device.createTexture({ size: [size, size, 6], format: HDR, usage, mipLevelCount: environmentMips(size) }),
      };
      this.#resources++;
      this.#groups.clear();
    }
    const target = this.#env;
    const mips = environmentMips(size);
    const slots = 6 * (mips + 1);
    const data = new Float32Array(slots * ENV_SLOT);
    const slot = (i: number, face: number, roughness: number, faceSize: number): void => {
      const box = env.skybox;
      data.set([
        face, roughness, faceSize, prefilterSamples(size), ...env.zenith, 1, ...env.horizon, 1, box === null ? 0 : 1, box?.turn ?? 0, box?.intensity ?? 1, 0,
      ], i * ENV_SLOT);
    };
    for (let f = 0; f < 6; f++) slot(f, f, 0, size);
    for (let m = 0; m < mips; m++) for (let f = 0; f < 6; f++) slot(6 + m * 6 + f, f, m / Math.max(1, mips - 1), Math.max(1, size >> m));
    const buffer = this.#write('env', data, BUFFER.UNIFORM);
    const envGroup = (pass: PostPass, extra: unknown[]): unknown => this.#device.createBindGroup({
      layout: this.#layouts[`post:${pass}`],
      entries: [{ binding: 0, resource: { buffer, size: floatsOf(ENV_FIELDS) * 4 } }, ...extra.map((resource, i) => ({ binding: i + 1, resource }))],
    });
    const skyGroup = envGroup('envSky', [skyImage.view, this.#linearSampler]);
    const prefilterGroup = envGroup('envPrefilter', [target.sky.createView({ dimension: 'cube' }), this.#linearSampler]);
    const face = (texture: GpuTexture, f: number, level: number): GpuTextureView => texture.createView({
      dimension: '2d', baseArrayLayer: f, arrayLayerCount: 1, baseMipLevel: level, mipLevelCount: 1,
    });
    for (let f = 0; f < 6; f++) {
      if (nature !== null && nature.sky !== null && env.skybox === null) {
        this.#nature.environmentFace(encoder, face(target.sky, f, 0), f, size, nature);
        continue;
      }
      const pass = encoder.beginRenderPass({ colorAttachments: [{ view: face(target.sky, f, 0), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
      pass.setPipeline(this.#postPipeline('envSky', {}, HDR, false));
      pass.setBindGroup(0, skyGroup, [f * ENV_SLOT * 4]);
      pass.draw(3);
      pass.end();
    }
    for (let m = 0; m < mips; m++) {
      for (let f = 0; f < 6; f++) {
        const pass = encoder.beginRenderPass({ colorAttachments: [{ view: face(target.cube, f, m), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
        pass.setPipeline(this.#postPipeline('envPrefilter', {}, HDR, false));
        pass.setBindGroup(0, prefilterGroup, [(6 + m * 6 + f) * ENV_SLOT * 4]);
        pass.draw(3);
        pass.end();
      }
    }
    target.key = env.key;
  }

  // ── Impostors ────────────────────────────────────────────────────────────────

  /** Bake every source the frame draws that has no atlas yet (impostors.ts). */
  #bakeImpostors(frame: ImpostorFrame, encoder: GpuEncoder, texture: (ref: TextureRef | null | undefined) => GpuTextureHandle): void {
    const device = this.#device;
    for (const source of frame.sources) {
      const known = this.#atlases3d.get(source.id);
      if (known !== undefined) continue;
      const size = source.frames * source.frameSize;
      const usage = TEXTURE.RENDER_ATTACHMENT | TEXTURE.TEXTURE_BINDING;
      const albedo = device.createTexture({ size: [size, size], format: 'rgba8unorm-srgb', usage });
      const normal = device.createTexture({ size: [size, size], format: 'rgba8unorm', usage });
      const depth = device.createTexture({ size: [size, size], format: DEPTH, usage: TEXTURE.RENDER_ATTACHMENT });
      const data = packBake(source, false);
      const buffer = device.createBuffer({ size: Math.max(256, data.byteLength), usage: BUFFER.UNIFORM | BUFFER.COPY_DST });
      device.queue.writeBuffer(buffer, 0, data);
      const pipeline = this.#bakePipeline();
      const pass = encoder.beginRenderPass({
        colorAttachments: [albedo, normal].map((t) => ({ view: t.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] })),
        depthStencilAttachment: { view: depth.createView(), depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 1 },
      });
      pass.setPipeline(pipeline);
      const groups = source.parts.map((part) => {
        const h = texture(part.material.baseColorTexture);
        return device.createBindGroup({
          layout: this.#layouts['bake'],
          entries: [{ binding: 0, resource: { buffer, size: floatsOf(BAKE_FIELDS) * 4 } }, { binding: 1, resource: h.view }, { binding: 2, resource: h.sampler }],
        });
      });
      const fs = source.frameSize;
      for (let f = 0; f < source.frames * source.frames; f++) {
        const x = (f % source.frames) * fs;
        const y = Math.floor(f / source.frames) * fs;
        pass.setViewport(x, y, fs, fs, 0, 1);
        pass.setScissorRect(x, y, fs, fs);
        source.parts.forEach((part, p) => {
          const g = this.#geometry.get(part.geometry);
          pass.setBindGroup(0, groups[p], [(f * source.parts.length + p) * BAKE_SLOT * 4]);
          pass.setVertexBuffer(0, g.position);
          pass.setVertexBuffer(1, g.normal);
          pass.setVertexBuffer(2, g.uv);
          pass.setVertexBuffer(3, g.color);
          pass.setIndexBuffer(g.index, g.indexFormat);
          pass.drawIndexed(g.indexCount, 1);
        });
      }
      pass.end();
      this.#afterSubmit.push(depth, buffer);
      const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
      this.#atlases3d.set(source.id, {
        albedo, normal, used: this.#frameCount,
        group: { albedo: albedo.createView(), normal: normal.createView(), sampler },
      });
    }
  }

  // ── Hi-Z depth read-back (occlusion.ts) ──────────────────────────────────────

  takeDepth(): DepthGrid | null {
    const grid = this.#depthReady;
    this.#depthReady = null;
    return grid;
  }

  /** Reduce the view's depth to the occlusion grid and copy it to a mappable buffer (two in flight at most). */
  #reduceDepth(encoder: GpuEncoder, o: OcclusionPlan, depth: GpuTexture): void {
    const free = this.#readbacks.find((r) => !r.busy && r.width === o.width && r.height === o.height);
    const slotFree = free ?? (this.#readbacks.filter((r) => r.busy).length < 2 ? this.#newReadback(o.width, o.height) : undefined);
    if (slotFree === undefined || encoder.copyTextureToBuffer === undefined) return;
    const device = this.#device;
    let pipeline = this.#pipelines.get('hiz');
    if (pipeline === undefined) {
      const module = device.createShaderModule({ code: WGSL_HIZ });
      pipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [this.#layouts['hiz']] }),
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: 'r32float' }] },
        primitive: { topology: 'triangle-list' },
      });
      this.#pipelines.set('hiz', pipeline);
    }
    device.queue.writeBuffer(slotFree.params, 0, new Float32Array([o.block, Math.floor(o.viewport.x), Math.floor(o.viewport.y), o.height]));
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: slotFree.texture.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [1, 0, 0, 1] }] });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, device.createBindGroup({
      layout: this.#layouts['hiz'],
      entries: [{ binding: 0, resource: depth.createView() }, { binding: 1, resource: { buffer: slotFree.params } }],
    }));
    pass.draw(3);
    pass.end();
    encoder.copyTextureToBuffer({ texture: slotFree.texture }, { buffer: slotFree.buffer, bytesPerRow: slotFree.bytesPerRow }, [o.width, o.height]);
    slotFree.pending = o;
    slotFree.busy = true;
  }

  #newReadback(width: number, height: number): Readback {
    const device = this.#device;
    const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
    const made: Readback = {
      width, height, bytesPerRow, busy: false, pending: null,
      texture: device.createTexture({ size: [width, height], format: 'r32float', usage: TEXTURE.RENDER_ATTACHMENT | TEXTURE.COPY_SRC }),
      buffer: device.createBuffer({ size: bytesPerRow * height, usage: BUFFER.MAP_READ | BUFFER.COPY_DST }),
      params: device.createBuffer({ size: 16, usage: BUFFER.UNIFORM | BUFFER.COPY_DST }),
    };
    this.#readbacks.push(made);
    return made;
  }

  /** After submitting: map the read-backs recorded this frame; each, once mapped, becomes the newest grid. */
  #mapDepth(): void {
    for (const r of this.#readbacks) {
      if (r.pending === null || r.mapping) continue;
      const o = r.pending;
      r.mapping = true;
      void r.buffer.mapAsync!(MAP_READ).then(() => {
        const bytes = r.buffer.getMappedRange!();
        const depths = new Float32Array(o.width * o.height);
        for (let y = 0; y < o.height; y++) depths.set(new Float32Array(bytes, y * r.bytesPerRow, o.width), y * o.width);
        r.buffer.unmap!();
        this.#depthReady = {
          width: o.width, height: o.height, depths, viewProjection: o.viewProjection, camera: o.camera, position: o.position, forward: o.forward,
        };
      }, () => { /* the device went away; the next frame asks again */ }).finally(() => {
        r.busy = false;
        r.mapping = false;
        r.pending = null;
      });
    }
  }

  #decalArrayId(images: GpuTextureHandle): number {
    let id = this.#decalArrays.get(images);
    if (id === undefined) this.#decalArrays.set(images, (id = ++this.#decalArrayCount));
    return id;
  }

  #decalPipeline(mirrored: boolean): unknown {
    const key = `decals|${mirrored}`;
    let pipeline = this.#pipelines.get(key);
    if (pipeline === undefined) {
      const module = this.#device.createShaderModule({ code: wgslDecal() });
      pipeline = this.#device.createRenderPipeline({
        layout: this.#device.createPipelineLayout({ bindGroupLayouts: [this.#layouts['frame'], this.#layouts['decals']] }),
        vertex: { module, entryPoint: 'vs', buffers: [recordLayout(DECAL_FLOATS, 10, 'instance')] },
        fragment: { module, entryPoint: 'fs', targets: [{ format: HDR, blend: BLEND }] },
        // The boxes' inside faces: one fragment per pixel, also with the camera inside a box (a mirror flips which those are).
        primitive: { topology: 'triangle-list', frontFace: 'cw', cullMode: mirrored ? 'back' : 'front' },
      });
      this.#pipelines.set(key, pipeline);
    }
    return pipeline;
  }

  #bakePipeline(): unknown {
    let pipeline = this.#pipelines.get('bake');
    if (pipeline === undefined) {
      const module = this.#device.createShaderModule({ code: wgslBake() });
      pipeline = this.#device.createRenderPipeline({
        layout: this.#device.createPipelineLayout({ bindGroupLayouts: [this.#layouts['bake']] }),
        vertex: { module, entryPoint: 'vs', buffers: webgpuVertexLayouts('terrain', false) },
        fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm-srgb' }, { format: 'rgba8unorm' }] },
        primitive: { topology: 'triangle-list', frontFace: 'cw', cullMode: 'none' },
        depthStencil: { format: DEPTH, depthWriteEnabled: true, depthCompare: 'less-equal' },
      });
      this.#pipelines.set('bake', pipeline);
    }
    return pipeline;
  }

  #impostorPipeline(formats: readonly string[]): unknown {
    const key = `impostor|${formats.join(',')}`;
    let pipeline = this.#pipelines.get(key);
    if (pipeline === undefined) {
      const module = this.#device.createShaderModule({ code: wgslImpostor(formats.length > 1) });
      pipeline = this.#device.createRenderPipeline({
        layout: this.#device.createPipelineLayout({ bindGroupLayouts: [this.#layouts['frame'], this.#layouts['impostor']] }),
        vertex: { module, entryPoint: 'vs', buffers: [recordLayout(IMPOSTOR_INSTANCE_FLOATS, 2, 'instance')] },
        fragment: { module, entryPoint: 'fs', targets: formats.map((format) => ({ format })) },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: DEPTH, depthWriteEnabled: true, depthCompare: 'less-equal' },
      });
      this.#pipelines.set(key, pipeline);
    }
    return pipeline;
  }

  /** Atlases not drawn for a while go. */
  #dropIdleAtlases(): void {
    for (const [id, atlas] of this.#atlases3d) {
      if (this.#frameCount - atlas.used > 600) {
        atlas.albedo.destroy();
        atlas.normal.destroy();
        this.#atlases3d.delete(id);
        // Its bind group names the destroyed views: a re-baked atlas needs a new one.
        for (const key of [...this.#groups.keys()]) if (key.startsWith(`impostor|${id}|`)) this.#groups.delete(key);
      }
    }
  }

  // ── The frame ─────────────────────────────────────────────────────────────────

  render(plan: FramePlan, texture: (ref: TextureRef) => BackendTexture, resources: FrameResources = NO_RESOURCES, capture?: (pixels: Uint8Array) => void): void {
    const device = this.#device;
    const f = plan.flags;
    this.#write('frames', plan.frames, BUFFER.UNIFORM);
    this.#write('shadowBlock', plan.shadowBlock, BUFFER.UNIFORM);
    this.#write('casters', plan.casters, BUFFER.UNIFORM);
    this.#write('materials', plan.materials, BUFFER.UNIFORM);
    const instances = this.#write('instances', plan.instances, BUFFER.VERTEX);
    const billboards = this.#write('billboards', plan.billboards, BUFFER.VERTEX);
    const lines = this.#write('lines', plan.lines, BUFFER.VERTEX);
    this.#write('palette', plan.palette, BUFFER.STORAGE);
    this.#atlases(plan);
    this.#dataTextures(plan);
    const targets = this.#targetsFor(plan, capture === undefined ? 'screen' : 'capture');
    const handle = (ref: TextureRef | null | undefined): GpuTextureHandle => (ref === null || ref === undefined ? this.#white : texture(ref) as GpuTextureHandle);
    const encoder = device.createCommandEncoder();
    this.#environment(plan.environment, encoder, plan.nature, handle(plan.environment.skybox?.texture ?? null));
    const decalBuffer = plan.decals === null || plan.decals.records.length === 0 ? null : this.#write('decals', plan.decals.records, BUFFER.VERTEX);
    const impostorFrame = plan.impostors;
    let impostorBuffers: { blocks: GpuBuffer; instances: GpuBuffer } | null = null;
    if (impostorFrame !== null) {
      this.#bakeImpostors(impostorFrame, encoder, handle);
      impostorBuffers = {
        blocks: this.#write('impostorBlocks', impostorFrame.blocks, BUFFER.UNIFORM),
        instances: this.#write('impostorInstances', impostorFrame.instances.length > 0 ? impostorFrame.instances : new Float32Array(IMPOSTOR_INSTANCE_FLOATS), BUFFER.VERTEX),
      };
    }
    const frameGroup = this.#frameGroup();
    const frameOffset = (view: ViewPlan): number[] => [view.frameSlot * FRAME_SLOT * 4];
    const view = (t: GpuTexture): GpuTextureView => t.createView();
    const current = targets.hdr[f.resolve ? 1 : 0];
    const v = targets.version;

    const viewport = (pass: GpuRenderPass, vp: ViewPlan['viewport'], scale = 1): void => {
      const x = vp.x / scale; const y = vp.y / scale; const w = vp.width / scale; const h = vp.height / scale;
      pass.setViewport(x, y, w, h, 0, 1);
      // Clamped to the target: a view planned a pixel taller than the target (a resize between
      // planning and drawing, a split rounding up) makes an invalid scissor, and an invalid
      // scissor drops the whole frame's command buffer (a black frame).
      const tw = Math.max(1, Math.floor(current.width / scale)); const th = Math.max(1, Math.floor(current.height / scale));
      const x0 = Math.min(tw - 1, Math.max(0, Math.floor(x))); const y0 = Math.min(th - 1, Math.max(0, Math.floor(y)));
      pass.setScissorRect(x0, y0, Math.max(1, Math.min(tw, Math.round(x + w)) - x0), Math.max(1, Math.min(th, Math.round(y + h)) - y0));
    };
    const colorAttachment = (t: GpuTexture, clear: boolean): Desc => ({
      view: view(t), loadOp: clear ? 'clear' : 'load', storeOp: 'store', clearValue: [0, 0, 0, 0],
    });
    const depthAttachment = (clear: boolean, readOnly = false): Desc => (readOnly
      ? { view: view(targets.depth), depthReadOnly: true }
      : { view: view(targets.depth), depthLoadOp: clear ? 'clear' : 'load', depthStoreOp: 'store', depthClearValue: 1 });

    const drawMesh = (pass: GpuRenderPass, item: MeshItem, kind: 'mesh' | 'position', wire: boolean): void => {
      const g = this.#geometry.get(item.geometry);
      let slot = 0;
      pass.setVertexBuffer(slot++, g.position);
      if (kind === 'mesh') {
        pass.setVertexBuffer(slot++, g.normal);
        pass.setVertexBuffer(slot++, g.uv);
        pass.setVertexBuffer(slot++, g.color);
      }
      if (item.skinned) {
        if (g.joints === null || g.weights === null) fail('PP9804', `Geometry ${item.geometry.id} is drawn skinned but has no joints`);
        pass.setVertexBuffer(slot++, g.joints);
        pass.setVertexBuffer(slot++, g.weights);
      }
      pass.setVertexBuffer(slot, instances, item.firstInstance * MESH_INSTANCE_FLOATS * 4);
      if (wire) {
        const e = this.#edges.get(item.geometry);
        pass.setIndexBuffer(e.index, 'uint32');
        pass.drawIndexed(e.count, item.instanceCount);
      } else {
        pass.setIndexBuffer(g.index, g.indexFormat);
        pass.drawIndexed(g.indexCount, item.instanceCount);
      }
    };
    const drawTerrainTile = (pass: GpuRenderPass, terrain: TerrainItem, geometry: Geometry3d, asMesh: boolean, wire: boolean): void => {
      const g = this.#geometry.get(geometry);
      pass.setVertexBuffer(0, g.position);
      if (asMesh) {
        pass.setVertexBuffer(1, instances, terrain.instance * MESH_INSTANCE_FLOATS * 4);
      } else {
        pass.setVertexBuffer(1, g.normal);
        pass.setVertexBuffer(2, g.uv);
        pass.setVertexBuffer(3, g.color);
      }
      if (wire) {
        const e = this.#edges.get(geometry);
        pass.setIndexBuffer(e.index, 'uint32');
        pass.drawIndexed(e.count, 1);
      } else {
        pass.setIndexBuffer(g.index, g.indexFormat);
        pass.drawIndexed(g.indexCount, 1);
      }
    };
    const drawTerrainChunks = (pass: GpuRenderPass, terrain: TerrainItem, asMesh: boolean, wire: boolean): void => {
      for (const tile of terrain.tiles) drawTerrainTile(pass, terrain, tile.geometry, asMesh, wire);
    };
    const materialGroup = (item: MeshItem): unknown => {
      const m = item.material;
      const maps = [m.baseColorTexture, m.metallicRoughnessTexture, m.emissiveTexture, m.normalTexture, m.occlusionTexture].map(handle);
      // A material keeps its id while a texture behind it is replaced (a screen repaints into a
      // new texture), so the group is rebuilt whenever any of its handles changed.
      const key = `material|${bindingId(m)}`;
      const known = this.#materialMaps.get(key);
      if (known !== undefined && (known.length !== maps.length || known.some((h, i) => h !== maps[i]))) this.#groups.delete(key);
      this.#materialMaps.set(key, maps);
      return this.#group(key, () => device.createBindGroup({
        layout: this.#layouts['material'],
        entries: [
          { binding: 0, resource: { buffer: this.#buffers.get('materials')!, size: floatsOf(MATERIAL_FIELDS) * 4 } },
          ...maps.flatMap((h, i) => [{ binding: 1 + i * 2, resource: h.view }, { binding: 2 + i * 2, resource: h.sampler }]),
        ],
      }));
    };
    /** Back faces are culled; a mirror's view is reflected, so there its front faces are. */
    let backFace: 'back' | 'front' = 'back';
    const meshPipeline = (item: MeshItem, targetFormats: string[], blend: boolean, wire: boolean): unknown => this.#scenePipeline({
      pass: 'mesh', variant: { skinned: item.skinned, mrt: targetFormats.length > 1 }, targets: targetFormats,
      blend: !blend ? false : transmissive(item.material) ? 'premultiplied' : 'alpha',
      cull: item.material.doubleSided || wire ? 'none' : backFace, topology: wire ? 'line-list' : 'triangle-list',
      depthWrite: !blend, depthCompare: 'less-equal',
    });
    const imageGroup = (image: GpuTextureHandle): unknown => {
      let group = this.#imageGroups.get(image);
      if (group === undefined) {
        group = device.createBindGroup({ layout: this.#layouts['image'], entries: [{ binding: 0, resource: image.view }, { binding: 1, resource: image.sampler }] });
        this.#imageGroups.set(image, group);
      }
      return group;
    };
    const drawBillboards = (pass: GpuRenderPass, vp: ViewPlan, items: readonly BillboardItem[], overlay: boolean): void => {
      pass.setPipeline(this.#scenePipeline({
        pass: 'billboard', variant: { overlay }, targets: [overlay ? LDR : HDR], blend: 'alpha', cull: 'none', topology: 'triangle-list',
        depthWrite: false, depthCompare: 'less-equal',
      }));
      pass.setBindGroup(0, frameGroup, frameOffset(vp));
      for (const item of items) {
        pass.setBindGroup(1, imageGroup(handle(item.texture)));
        pass.setVertexBuffer(0, billboards, item.first * BILLBOARD_INSTANCE_FLOATS * 4);
        pass.draw(6, item.count);
      }
    };
    const drawLines = (pass: GpuRenderPass, vp: ViewPlan, range: { first: number; count: number }, overlay: boolean): void => {
      if (range.count === 0) return;
      pass.setPipeline(this.#scenePipeline({
        pass: 'line', variant: { overlay }, targets: [overlay ? LDR : HDR], blend: 'alpha', cull: 'none', topology: 'triangle-list',
        depthWrite: false, depthCompare: 'less-equal',
      }));
      pass.setBindGroup(0, frameGroup, frameOffset(vp));
      pass.setVertexBuffer(0, lines);
      pass.draw(range.count, 1, range.first);
    };
    const fullscreen = (target: GpuTexture, clear: boolean, pass: PostPass, variant: PostVariant, vp: ViewPlan, own: unknown, format: string, additive = false, scale = 1): void => {
      const p = encoder.beginRenderPass({ colorAttachments: [colorAttachment(target, clear)] });
      viewport(p, vp.viewport, scale);
      p.setPipeline(this.#postPipeline(pass, variant, format, additive));
      p.setBindGroup(0, frameGroup, frameOffset(vp));
      p.setBindGroup(1, own);
      p.draw(3);
      p.end();
    };
    const whole = (target: GpuTextureView, pass: PostPass, variant: PostVariant, own: unknown, format: string, additive = false): void => {
      const p = encoder.beginRenderPass({ colorAttachments: [{ view: target, loadOp: additive ? 'load' : 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
      p.setPipeline(this.#postPipeline(pass, variant, format, additive));
      p.setBindGroup(0, own);
      p.setBindGroup(1, this.#group(`postFrame|${this.#resources}`, () => device.createBindGroup({
        layout: this.#layouts['postFrame'], entries: [{ binding: 0, resource: { buffer: this.#buffers.get('frames')!, size: floatsOf(FRAME_FIELDS) * 4 } }],
      })), [0]);
      p.draw(3);
      p.end();
    };
    const sampled = (t: GpuTexture): GpuTextureView => t.createView();
    const lin = this.#linearSampler;

    visitPasses(plan, {
      environment: () => {},
      shadows: (tiles: readonly ShadowTile[]) => {
        for (const atlas of ['sun', 'local'] as const) {
          const mine = tiles.filter((t) => t.atlas === atlas);
          const map = this.#atlas[atlas];
          if (mine.length === 0 || map === null) continue;
          const pass = encoder.beginRenderPass({
            colorAttachments: [],
            depthStencilAttachment: { view: map.createView(), depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 1 },
          });
          const casterGroup = this.#group(`caster|${this.#resources}`, () => device.createBindGroup({
            layout: this.#layouts['caster'],
            entries: [
              { binding: 0, resource: { buffer: this.#buffers.get('casters')!, size: floatsOf(CASTER_FIELDS) * 4 } },
              { binding: 1, resource: { buffer: this.#buffers.get('palette')! } },
            ],
          }));
          for (const tile of mine) {
            pass.setViewport(tile.x, tile.y, tile.size, tile.size, 0, 1);
            pass.setScissorRect(tile.x, tile.y, tile.size, tile.size);
            pass.setBindGroup(0, casterGroup, [tile.slot * CASTER_SLOT * 4]);
            const casterPipeline = (skinned: boolean): unknown => this.#scenePipeline({
              pass: 'caster', variant: { skinned }, targets: [], blend: false, cull: 'back', topology: 'triangle-list', depthWrite: true, depthCompare: 'less-equal',
            });
            for (const item of tile.casters) {
              pass.setPipeline(casterPipeline(item.skinned));
              drawMesh(pass, item, 'position', false);
            }
            if (tile.terrain !== null) {
              pass.setPipeline(casterPipeline(false));
              drawTerrainChunks(pass, tile.terrain, true, false);
            }
          }
          pass.end();
        }
      },
      scene: (vp, first) => {
        backFace = vp.mirrored ? 'front' : 'back';
        const formats = f.gbuffer ? [HDR, HDR] : [HDR];
        const pass = encoder.beginRenderPass({
          colorAttachments: [colorAttachment(targets.hdr[0], first), ...(f.gbuffer ? [colorAttachment(targets.gbuf, first)] : [])],
          depthStencilAttachment: depthAttachment(first),
        });
        viewport(pass, vp.viewport);
        pass.setBindGroup(0, frameGroup, frameOffset(vp));
        pass.setPipeline(this.#scenePipeline({
          pass: 'sky', variant: { mrt: f.gbuffer }, targets: formats, blend: false, cull: 'none', topology: 'triangle-list', depthWrite: false, depthCompare: 'always',
        }));
        pass.setBindGroup(1, imageGroup(handle(plan.environment.skybox?.texture ?? null)));
        pass.draw(3);
        const wire = f.wireframe;
        if (vp.terrain !== null) {
          pass.setPipeline(this.#scenePipeline({
            pass: 'terrain', variant: { mrt: f.gbuffer }, targets: formats, blend: false, cull: wire ? 'none' : backFace,
            topology: wire ? 'line-list' : 'triangle-list', depthWrite: true, depthCompare: 'less-equal',
          }));
          const terrain = vp.terrain;
          // One bind group per terrain block (palette and level): its slot, the terrain arrays and its four detail textures.
          const arrays = (resources.terrain ?? this.#emptyTerrainArrays()) as { albedo: GpuTextureHandle; normal: GpuTextureHandle; splat?: GpuTextureHandle | null };
          const groups = new Map<number, unknown>();
          for (const tile of terrain.tiles) {
            let group = groups.get(tile.uniformSlot);
            if (group === undefined) {
              const details = tile.textures.map((t) => handle(t));
              group = device.createBindGroup({
                layout: this.#layouts['terrain'],
                entries: [
                  { binding: 0, resource: { buffer: this.#buffers.get('materials')!, size: floatsOf(TERRAIN_FIELDS) * 4 } },
                  { binding: 1, resource: arrays.albedo.view },
                  { binding: 2, resource: arrays.normal.view },
                  ...details.map((h, i) => ({ binding: i + 3, resource: h.view })),
                  { binding: 7, resource: arrays.albedo.sampler },
                  { binding: 8, resource: (arrays.splat ?? this.#white).view },
                ],
              });
              groups.set(tile.uniformSlot, group);
            }
            pass.setBindGroup(1, group, [tile.uniformSlot * MATERIAL_SLOT * 4]);
            drawTerrainTile(pass, terrain, tile.geometry, false, wire);
          }
        }
        for (const item of vp.opaque) {
          pass.setPipeline(meshPipeline(item, formats, false, wire));
          pass.setBindGroup(1, materialGroup(item), [item.materialSlot * MATERIAL_SLOT * 4]);
          drawMesh(pass, item, 'mesh', wire);
        }
        const far = impostorFrame?.views[plan.views.indexOf(vp)] ?? [];
        if (far.length > 0 && impostorBuffers !== null && !wire) {
          pass.setPipeline(this.#impostorPipeline(formats));
          for (const item of far) {
            const atlas = this.#atlases3d.get(item.source.id)!;
            atlas.used = this.#frameCount;
            const views = atlas.group as { albedo: GpuTextureView; normal: GpuTextureView; sampler: unknown };
            pass.setBindGroup(1, this.#group(`impostor|${item.source.id}|${this.#resources}`, () => device.createBindGroup({
              layout: this.#layouts['impostor'],
              entries: [
                { binding: 0, resource: { buffer: impostorBuffers!.blocks, size: floatsOf(IMPOSTOR_FIELDS) * 4 } },
                { binding: 1, resource: views.albedo }, { binding: 2, resource: views.normal }, { binding: 3, resource: views.sampler },
              ],
            })), [item.slot * IMPOSTOR_SLOT * 4]);
            pass.setVertexBuffer(0, impostorBuffers.instances, item.first * IMPOSTOR_INSTANCE_FLOATS * 4);
            pass.draw(6, item.count);
          }
        }
        pass.end();
        if (plan.occlusion !== null && plan.occlusion.slot === vp.frameSlot) this.#reduceDepth(encoder, plan.occlusion, targets.depth);
      },
      ao: (vp) => {
        const s = targets.aoScale;
        const variant = { scale: s, samples: s === 2 ? 8 : 12 };
        fullscreen(targets.ao[0], false, 'ao', variant, vp,
          this.#postGroup('ao', `${v}`, [sampled(targets.depth), sampled(targets.gbuf)]), 'r8unorm', false, s);
        fullscreen(targets.ao[1], false, 'aoBlur', { scale: s }, vp,
          this.#postGroup('aoBlur', `${v}`, [sampled(targets.ao[0]), sampled(targets.depth), lin]), 'r8unorm', false, s);
      },
      reflections: (vp) => {
        fullscreen(targets.ssr, false, 'reflections', {}, vp,
          this.#postGroup('reflections', `${v}`, [sampled(targets.depth), sampled(targets.gbuf), sampled(targets.hdr[0]), lin]), HDR);
      },
      resolve: (vp) => {
        const ao = f.ao === 'off' ? this.#white.view : sampled(targets.ao[1]);
        const ssr = f.reflections ? sampled(targets.ssr) : this.#black.view;
        fullscreen(targets.hdr[1], false, 'resolve', {}, vp,
          this.#postGroup('resolve', `${v}|${f.ao}|${f.reflections}`, [sampled(targets.hdr[0]), ao, ssr, sampled(targets.gbuf), sampled(targets.depth), lin]), HDR);
      },
      decals: (vp) => {
        const range = plan.decals!.views[vp.frameSlot]!;
        const images = resources.decals as GpuTextureHandle | null;
        if (images === null || decalBuffer === null) return;
        const pass = encoder.beginRenderPass({ colorAttachments: [colorAttachment(current, false)] });
        viewport(pass, vp.viewport);
        pass.setPipeline(this.#decalPipeline(vp.mirrored));
        pass.setBindGroup(0, frameGroup, frameOffset(vp));
        pass.setBindGroup(1, this.#group(`decals|${v}|${this.#resources}|${this.#decalArrayId(images)}`, () => device.createBindGroup({
          layout: this.#layouts['decals'],
          entries: [{ binding: 0, resource: sampled(targets.depth) }, { binding: 1, resource: images.view }, { binding: 2, resource: images.sampler }],
        })));
        pass.setVertexBuffer(0, decalBuffer, range.first * DECAL_FLOATS * 4);
        pass.draw(36, range.count);
        pass.end();
      },
      target: (t) => {
        const made = this.#renderTarget(t.id, t.width, t.height);
        (encoder as unknown as { copyTextureToTexture(a: Desc, b: Desc, size: readonly number[]): void })
          .copyTextureToTexture({ texture: targets.ldr }, { texture: made.handle.texture }, [t.width, t.height]);
        this.#generateMips(made.handle.texture, 'rgba8unorm-srgb', made.levels, 0, encoder);
      },
      nature: (vp) => this.#nature.draw(encoder, {
        plan: plan.nature!, view: vp.frameSlot, viewport: vp.viewport, color: current, depth: targets.depth, cube: this.#env!.cube, width: plan.width, height: plan.height,
      }),
      transparent: (vp) => {
        backFace = vp.mirrored ? 'front' : 'back';
        const pass = encoder.beginRenderPass({ colorAttachments: [colorAttachment(current, false)], depthStencilAttachment: depthAttachment(false) });
        viewport(pass, vp.viewport);
        const meshes = (items: readonly MeshItem[], blend: boolean): void => {
          for (const item of items) {
            pass.setPipeline(meshPipeline(item, [HDR], blend, f.wireframe));
            pass.setBindGroup(1, materialGroup(item), [item.materialSlot * MATERIAL_SLOT * 4]);
            drawMesh(pass, item, 'mesh', f.wireframe);
          }
        };
        // The viewmodel layer's opaque surfaces first (their overlay depth is in front of the world's), then the world's blended ones.
        const overlay = vp.overlaySlot === null ? frameOffset(vp) : [vp.overlaySlot * FRAME_SLOT * 4];
        if (vp.viewmodel.length > 0) {
          pass.setBindGroup(0, frameGroup, overlay);
          meshes(vp.viewmodel, false);
        }
        pass.setBindGroup(0, frameGroup, frameOffset(vp));
        meshes(vp.transparent, true);
        if (vp.billboards.length > 0) drawBillboards(pass, vp, vp.billboards, false);
        drawLines(pass, vp, vp.lines, false);
        if (vp.viewmodelTransparent.length > 0) {
          pass.setBindGroup(0, frameGroup, overlay);
          meshes(vp.viewmodelTransparent, true);
        }
        pass.end();
        if (plan.vfx !== null) {
          this.#vfx.draw(encoder, {
            plan: plan.vfx, frameGroup, frameOffset: frameOffset(vp), color: current, depth: targets.depth,
            enter: (p) => viewport(p, vp.viewport), image: (t) => handle(t),
          });
        }
      },
      volumetric: (vp) => {
        fullscreen(current, false, 'volumetric', { samples: 24 }, vp, this.#postGroup('volumetric', `${v}`, [sampled(targets.depth)]), HDR, true);
      },
      fogOfWar: (vp) => {
        const fog = vp.fog!;
        let known = this.#fogTextures.get(vp.frameSlot);
        if (known === undefined || known.key !== fog.key) {
          if (known !== undefined && (known.width !== fog.width || known.height !== fog.height)) known.texture.destroy();
          const texture = known !== undefined && known.width === fog.width && known.height === fog.height
            ? known.texture
            : device.createTexture({ size: [fog.width, fog.height], format: 'r8unorm', usage: TEXTURE.TEXTURE_BINDING | TEXTURE.COPY_DST });
          const row = Math.ceil(fog.width / 256) * 256;
          const padded = new Uint8Array(row * fog.height);
          for (let y = 0; y < fog.height; y++) padded.set(fog.texels.subarray(y * fog.width, (y + 1) * fog.width), y * row);
          device.queue.writeTexture({ texture }, padded, { bytesPerRow: row }, { width: fog.width, height: fog.height });
          known = { key: fog.key, width: fog.width, height: fog.height, texture, id: (known?.texture === texture ? known.id : ++this.#fogIds) };
          this.#fogTextures.set(vp.frameSlot, known);
        }
        fullscreen(current, false, 'fogOfWar', {}, vp, this.#postGroup('fogOfWar', `${v}|${known.id}`, [sampled(targets.depth), known.texture.createView(), lin]), HDR, true);
      },
      depthOfField: (vp) => this.#dof.draw(encoder, {
        plan: vp.depthOfField!, slot: vp.frameSlot, viewport: vp.viewport, color: current, depth: targets.depth, width: plan.width, height: plan.height,
      }),
      godRays: (vp) => {
        fullscreen(current, false, 'godRays', { samples: plan.quality.level === 'high' ? 40 : 24 }, vp,
          this.#postGroup('godRays', `${v}`, [sampled(targets.depth)]), HDR, true);
      },
      outlines: (vp, first) => {
        const pass = encoder.beginRenderPass({ colorAttachments: [colorAttachment(targets.mask, first)], depthStencilAttachment: depthAttachment(false, true) });
        viewport(pass, vp.viewport);
        pass.setBindGroup(0, frameGroup, frameOffset(vp));
        const outlineGroup = this.#group(`outline|${this.#resources}`, () => device.createBindGroup({
          layout: this.#layouts['outline'],
          entries: [{ binding: 0, resource: { buffer: this.#buffers.get('materials')!, size: floatsOf(OUTLINE_FIELDS) * 4 } }],
        }));
        for (const o of vp.outlines) {
          pass.setPipeline(this.#scenePipeline({
            pass: 'outline', variant: { skinned: o.item.skinned }, targets: [HDR], blend: false, cull: 'none', topology: 'triangle-list',
            depthWrite: false, depthCompare: o.throughWalls ? 'always' : 'less-equal',
          }));
          pass.setBindGroup(1, outlineGroup, [o.slot * MATERIAL_SLOT * 4]);
          drawMesh(pass, o.item, 'position', false);
        }
        pass.end();
      },
      bloom: (levels) => {
        const chain = targets.bloom.slice(0, levels);
        whole(sampled(chain[0]!), 'bloomPrefilter', {}, this.#postGroup('bloomPrefilter', `${v}|${f.resolve}`, [sampled(current), lin]), HDR);
        for (let i = 1; i < chain.length; i++) {
          whole(sampled(chain[i]!), 'bloomDown', {}, this.#postGroup('bloomDown', `${v}|${i}`, [sampled(chain[i - 1]!), lin]), HDR);
        }
        for (let i = chain.length - 1; i > 0; i--) {
          whole(sampled(chain[i - 1]!), 'bloomUp', {}, this.#postGroup('bloomUp', `${v}|${i}`, [sampled(chain[i]!), lin]), HDR, true);
        }
      },
      final: (vp, first) => {
        const bloom = f.bloomLevels > 0 ? sampled(targets.bloom[0]!) : this.#black.view;
        const gbuf = f.gbuffer ? sampled(targets.gbuf) : this.#black.view;
        const mask = f.outlines ? sampled(targets.mask) : this.#black.view;
        fullscreen(targets.ldr, first, 'final', {}, vp, this.#postGroup('final', `${v}|${f.resolve}|${f.bloomLevels > 0}|${f.gbuffer}|${f.outlines}`,
          [sampled(current), bloom, sampled(targets.depth), gbuf, mask, lin]), LDR);
      },
      overlay: (vp) => {
        const pass = encoder.beginRenderPass({ colorAttachments: [colorAttachment(targets.ldr, false)], depthStencilAttachment: depthAttachment(false, true) });
        viewport(pass, vp.viewport);
        if (vp.overlayBillboards.length > 0) drawBillboards(pass, vp, vp.overlayBillboards, true);
        drawLines(pass, vp, vp.overlayLines, true);
        pass.end();
      },
      present: () => {
        if (capture !== undefined) return;
        whole(this.#context.getCurrentTexture().createView(), 'present', { fxaa: f.fxaa }, this.#postGroup('present', `${v}`, [sampled(targets.ldr), lin]), this.#format);
      },
    });
    let read: GpuBuffer | null = null;
    const bytesPerRow = Math.ceil((plan.width * 4) / 256) * 256;
    if (capture !== undefined && encoder.copyTextureToBuffer !== undefined) {
      read = device.createBuffer({ size: bytesPerRow * plan.height, usage: BUFFER.MAP_READ | BUFFER.COPY_DST });
      encoder.copyTextureToBuffer({ texture: targets.ldr }, { buffer: read, bytesPerRow }, [plan.width, plan.height]);
    }
    device.queue.submit([encoder.finish()]);
    for (const r of this.#afterSubmit) r.destroy();
    this.#afterSubmit = [];
    if (read !== null && capture !== undefined) {
      const buffer = read;
      void buffer.mapAsync!(MAP_READ).then(() => {
        const bytes = new Uint8Array(buffer.getMappedRange!());
        const pixels = new Uint8Array(plan.width * plan.height * 4);
        for (let y = 0; y < plan.height; y++) pixels.set(bytes.subarray(y * bytesPerRow, y * bytesPerRow + plan.width * 4), y * plan.width * 4);
        buffer.unmap!();
        buffer.destroy();
        capture(pixels);
      });
    }
    this.#mapDepth();
    this.#geometry.endFrame();
    this.#edges.endFrame();
    this.#frameCount++;
    this.#dropIdleAtlases();
  }

  dispose(): void {
    this.#nature.dispose();
    this.#vfx.dispose();
    this.#dof.dispose();
    for (const r of this.#readbacks) {
      r.texture.destroy();
      r.buffer.destroy();
      r.params.destroy();
    }
    for (const id of [...this.#renderTargets.keys()]) this.dropTarget(id);
    for (const atlas of this.#atlases3d.values()) {
      atlas.albedo.destroy();
      atlas.normal.destroy();
    }
    this.#geometry.clear();
    this.#edges.clear();
    for (const buffer of this.#buffers.values()) buffer.destroy();
    for (const t of this.#targetSets.values()) for (const x of [...t.hdr, t.gbuf, t.depth, ...t.ao, t.ssr, t.mask, t.ldr, ...t.bloom]) x.destroy();
    this.#atlas.sun?.destroy();
    this.#atlas.local?.destroy();
    if (this.#data !== null) for (const x of [this.#data.lights, this.#data.grid, this.#data.items]) x.destroy();
    this.#env?.sky.destroy();
    this.#env?.cube.destroy();
    this.#dummyDepth.destroy();
    this.#white.texture.destroy();
    this.#black.texture.destroy();
  }
}

/** WebGPU only: one mip level from the one above it (WebGL2 uses generateMipmap). */
export const WGSL_MIPMAP = `
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var sourceSampler: sampler;

struct VertexOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex fn vs(@builtin(vertex_index) index: u32) -> VertexOut {
  var corners = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  var out: VertexOut;
  out.clip = vec4<f32>(corners[index], 0.0, 1.0);
  out.uv = vec2<f32>(corners[index].x * 0.5 + 0.5, 0.5 - corners[index].y * 0.5);
  return out;
}

@fragment fn fs(in: VertexOut) -> @location(0) vec4<f32> {
  return textureSample(source, sourceSampler, in.uv);
}
`;
