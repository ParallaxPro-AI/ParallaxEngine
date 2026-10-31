/**
 * The WebGL2 backend: the same targets, passes and order as the WebGPU backend
 * (webgpu.ts), through framebuffer objects. RGBA16F color targets need
 * EXT_color_buffer_float (or EXT_color_buffer_half_float); depth is a DEPTH_COMPONENT32F
 * texture the screen-space passes read with `texelFetch`; shadow atlases are
 * DEPTH_COMPONENT32F sampled through `sampler2DShadow`. Uniform blocks are std140 buffers
 * bound by range (one slot per view, material, shadow tile and environment face — the same
 * slots WebGPU binds with dynamic offsets). Bone palettes are an RGBA32F texture; light
 * and cluster data are RGBA32F / RG32UI / R32UI textures; texture mips come from
 * `generateMipmap`.
 *
 * WebGL2 has no base-instance draw, so instance attributes are re-pointed at each draw's
 * first record. Texture units are fixed per sampler name (`GLSL_UNITS`).
 */

import { fail } from '../../../core/index.js';
import type { Geometry3d, Texture3d, Wrap } from '../../../core/index.js';
import { GeometryCache, NO_RESOURCES } from './backend.js';
import type { Backend3d, BackendTexture, CompressionFamily, FrameResources, TextureArrayOptions, TextureDesc, TextureImage } from './backend.js';
import type { BlockFormat, Ktx2Image } from './ktx2.js';
import { environmentMips } from './ibl.js';
import {
  BILLBOARD_INSTANCE_FLOATS, CASTER_FIELDS, CASTER_SLOT, DATA_ROW, FRAME_FIELDS, FRAME_SLOT, floatsOf, LINE_VERTEX_FLOATS, LOCATION as L,
  MATERIAL_FIELDS, MATERIAL_SLOT, MESH_INSTANCE_FLOATS, OUTLINE_FIELDS, PALETTE_ROW_JOINTS, TERRAIN_FIELDS, transmissive, UNIFORM_ALIGN,
} from './layout.js';
import { visitPasses } from './plan.js';
import type { BillboardItem, EnvironmentPlan, FramePlan, MeshItem, OcclusionPlan, TerrainItem, TextureRef, ViewPlan } from './plan.js';
import { GLSL_HIZ } from './occlusion.js';
import type { DepthGrid } from './occlusion.js';
import { ENV_FIELDS, ENV_SLOT, glslPost } from './post_shaders.js';
import type { PostPass, PostVariant } from './post_shaders.js';
import { GLSL_HEADER, GLSL_UNITS, glsl } from './shaders.js';
import type { ScenePass, SceneVariant } from './shaders.js';
import { prefilterSamples } from './webgpu.js';
import { edgeIndices } from './wireframe.js';
import { NatureWebGl2 } from './sky_webgl2.js';
import { VfxWebGl2 } from './vfx_webgl2.js';
import { DofWebGl2 } from './dof_webgl2.js';
import { DECAL_FLOATS, glslDecal } from './decals.js';
import { BAKE_FIELDS, BAKE_SLOT, glslBake, glslImpostor, IMPOSTOR_FIELDS, IMPOSTOR_INSTANCE_FLOATS, IMPOSTOR_SLOT, packBake } from './impostors.js';
import type { ImpostorFrame } from './impostors.js';
import type { NaturePlan } from './sky_plan.js';

type GL = WebGL2RenderingContext;

interface GlTextureHandle extends BackendTexture {
  readonly backend: 'webgl2';
  readonly texture: WebGLTexture;
}

interface GlGeometry {
  readonly vao: WebGLVertexArrayObject;
  readonly buffers: readonly WebGLBuffer[];
  /** Points the bound VAO's vertex attributes at this geometry's buffers. */
  readonly attributes: () => void;
  readonly indexType: number;
  readonly indexCount: number;
  readonly vertexCount: number;
  /** The vertex color buffer (null: the geometry has none). */
  readonly colors: WebGLBuffer | null;
}

interface GlEdges {
  readonly vao: WebGLVertexArrayObject;
  readonly index: WebGLBuffer;
  readonly count: number;
}

/** Uniform block binding points. */
const BLOCK = { Frame: 0, Material: 1, Terrain: 1, Outline: 1, Impostor: 1, Shadows: 2, Caster: 3, Env: 4, Bake: 6 } as const;

/**
 * The unit textures are created and configured on, which no program samples: binding a
 * new texture on a sampled unit would replace what a draw reads there.
 */
const SETUP_UNIT = Math.max(...Object.values(GLSL_UNITS)) + 1;

interface Targets {
  readonly width: number;
  readonly height: number;
  readonly aoScale: number;
  readonly hdr: readonly [WebGLTexture, WebGLTexture];
  readonly gbuf: WebGLTexture;
  readonly depth: WebGLTexture;
  readonly ao: readonly [WebGLTexture, WebGLTexture];
  readonly ssr: WebGLTexture;
  readonly mask: WebGLTexture;
  readonly ldr: WebGLTexture;
  readonly bloom: readonly { texture: WebGLTexture; width: number; height: number }[];
  readonly framebuffers: Map<string, WebGLFramebuffer>;
}

export class WebGl2Backend implements Backend3d {
  readonly kind = 'webgl2';
  readonly #gl: GL;
  readonly #programs = new Map<string, WebGLProgram>();
  readonly #geometry: GeometryCache<GlGeometry>;
  readonly #edges: GeometryCache<GlEdges>;
  readonly #ubo: Record<'frame' | 'material' | 'shadows' | 'caster' | 'env', WebGLBuffer>;
  readonly #instances: WebGLBuffer;
  readonly #billboards: WebGLBuffer;
  readonly #lines: WebGLBuffer;
  readonly #recordVao: WebGLVertexArrayObject;
  readonly #palette: WebGLTexture;
  #paletteRows = 0;
  readonly #white: WebGLTexture;
  readonly #black: WebGLTexture;
  readonly #dummyShadow: WebGLTexture;
  /** Render targets by use: the screen's, and a capture's (photos and portraits draw at their own size). */
  readonly #targetSets = new Map<'screen' | 'capture', Targets>();
  #atlas: { sun: { texture: WebGLTexture; framebuffer: WebGLFramebuffer; size: number } | null; local: { texture: WebGLTexture; framebuffer: WebGLFramebuffer; size: number } | null } = { sun: null, local: null };
  #data: { lights: WebGLTexture; grid: WebGLTexture; items: WebGLTexture; rows: [number, number, number] } | null = null;
  #env: { key: string; size: number; sky: WebGLTexture; cube: WebGLTexture } | null = null;
  readonly #nature: NatureWebGl2;
  /** Effect particles and ribbons (vfx.ts). */
  readonly #vfx: VfxWebGl2;
  readonly #dof: DofWebGl2;
  #hiz: { texture: WebGLTexture; framebuffer: WebGLFramebuffer; width: number; height: number } | null = null;
  readonly #pending: { buffer: WebGLBuffer; sync: WebGLSync; plan: OcclusionPlan }[] = [];
  #depthReady: DepthGrid | null = null;
  /** Fog-of-war cell textures by view slot, with the key they hold. */
  readonly #fogTextures = new Map<number, { key: string; texture: WebGLTexture }>();
  /** Offscreen views' render targets (camera feeds, mirrors), by id. */
  readonly #renderTargets = new Map<string, { texture: WebGLTexture; framebuffer: WebGLFramebuffer; width: number; height: number }>();
  /** Baked impostor atlases by source id, and the frame each was last drawn. */
  readonly #atlases3d = new Map<string, { albedo: WebGLTexture; normal: WebGLTexture; used: number }>();
  readonly #impostorUbo: WebGLBuffer;
  readonly #decals: WebGLBuffer;
  readonly #impostorInstances: WebGLBuffer;
  #frameCount = 0;

  constructor(gl: GL) {
    this.#gl = gl;
    const align = gl.getParameter(gl.UNIFORM_BUFFER_OFFSET_ALIGNMENT) as number;
    if (UNIFORM_ALIGN % align !== 0) {
      fail('PP9805', `This WebGL2 device aligns uniform buffers to ${align} bytes; render3d's slots are ${UNIFORM_ALIGN}`, {
        fix: 'Use a browser with WebGPU, or report the device.',
      });
    }
    if (gl.getExtension('EXT_color_buffer_float') === null && gl.getExtension('EXT_color_buffer_half_float') === null) {
      fail('PP9810', 'This WebGL2 device cannot render to floating-point targets (no EXT_color_buffer_float), which the HDR pipeline needs', {
        fix: 'Use a browser with WebGPU, or update the GPU driver.',
      });
    }
    const buffer = (): WebGLBuffer => gl.createBuffer()!;
    this.#ubo = { frame: buffer(), material: buffer(), shadows: buffer(), caster: buffer(), env: buffer() };
    this.#instances = buffer();
    this.#billboards = buffer();
    this.#lines = buffer();
    this.#recordVao = gl.createVertexArray()!;
    this.#palette = gl.createTexture()!;
    this.#geometry = new GeometryCache<GlGeometry>((g: Geometry3d) => this.#upload(g), (g) => {
      gl.deleteVertexArray(g.vao);
      for (const b of g.buffers) gl.deleteBuffer(b);
    }, 600, (gpu: GlGeometry, g: Geometry3d) => {
      // Dynamic geometry: same vertex and index counts → rewrite positions, normals and colors in place.
      if (g.positions.length / 3 !== gpu.vertexCount || g.indices.length !== gpu.indexCount || (g.colors === null) !== (gpu.colors === null)) return false;
      gl.bindBuffer(gl.ARRAY_BUFFER, gpu.buffers[0]!);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, g.positions);
      gl.bindBuffer(gl.ARRAY_BUFFER, gpu.buffers[1]!);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, g.normals);
      if (g.colors !== null && gpu.colors !== null) {
        gl.bindBuffer(gl.ARRAY_BUFFER, gpu.colors);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, g.colors);
      }
      return true;
    });
    this.#edges = new GeometryCache<GlEdges>((g: Geometry3d) => this.#uploadEdges(g), (e) => {
      gl.deleteVertexArray(e.vao);
      gl.deleteBuffer(e.index);
    });
    const pixel = (rgba: number[]): WebGLTexture => {
      const t = gl.createTexture()!;
      gl.activeTexture(gl.TEXTURE0 + SETUP_UNIT);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(rgba));
      return t;
    };
    this.#white = pixel([255, 255, 255, 255]);
    this.#black = pixel([0, 0, 0, 0]);
    this.#dummyShadow = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.#dummyShadow);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT32F, 1, 1, 0, gl.DEPTH_COMPONENT, gl.FLOAT, null);
    this.#depthSampling(this.#dummyShadow, true);
    gl.frontFace(gl.CW);
    this.#nature = new NatureWebGl2(gl);
    this.#vfx = new VfxWebGl2(gl, (key, source) => this.#link(key, source));
    this.#dof = new DofWebGl2(gl);
    this.#impostorUbo = gl.createBuffer()!;
    this.#decals = gl.createBuffer()!;
    this.#impostorInstances = gl.createBuffer()!;
  }

  // ── Impostors ────────────────────────────────────────────────────────────────

  /** Bake every source the frame draws that has no atlas yet (impostors.ts); the projection's y is flipped so rows read as WebGPU's. */
  #bakeImpostors(frame: ImpostorFrame, handle: (ref: Texture3d | null) => WebGLTexture): void {
    const gl = this.#gl;
    for (const source of frame.sources) {
      if (this.#atlases3d.has(source.id)) continue;
      const size = source.frames * source.frameSize;
      const color = (internal: number): WebGLTexture => this.#colorTexture(size, size, internal);
      const albedo = color(gl.SRGB8_ALPHA8);
      const normal = color(gl.RGBA8);
      const depth = gl.createRenderbuffer()!;
      gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT32F, size, size);
      const fb = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, albedo, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, normal, 0);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      gl.disable(gl.SCISSOR_TEST);
      gl.colorMask(true, true, true, true);
      gl.depthMask(true);
      gl.clearColor(0, 0, 0, 0);
      gl.clearDepth(1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.disable(gl.BLEND);
      gl.disable(gl.CULL_FACE);
      const ubo = gl.createBuffer()!;
      gl.bindBuffer(gl.UNIFORM_BUFFER, ubo);
      gl.bufferData(gl.UNIFORM_BUFFER, packBake(source, true), gl.STATIC_DRAW);
      gl.useProgram(this.#link('impostor-bake', glslBake()));
      gl.enable(gl.SCISSOR_TEST);
      const fs = source.frameSize;
      for (let f = 0; f < source.frames * source.frames; f++) {
        const x = (f % source.frames) * fs;
        const y = Math.floor(f / source.frames) * fs;
        gl.viewport(x, y, fs, fs);
        gl.scissor(x, y, fs, fs);
        source.parts.forEach((part, p) => {
          gl.bindBufferRange(gl.UNIFORM_BUFFER, BLOCK.Bake, ubo, (f * source.parts.length + p) * BAKE_SLOT * 4, floatsOf(BAKE_FIELDS) * 4);
          this.#bind(GLSL_UNITS.baseTexture, handle(part.material.baseColorTexture));
          const g = this.#geometry.get(part.geometry);
          gl.bindVertexArray(g.vao);
          gl.drawElements(gl.TRIANGLES, g.indexCount, g.indexType, 0);
        });
      }
      gl.bindVertexArray(null);
      gl.disable(gl.SCISSOR_TEST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fb);
      gl.deleteRenderbuffer(depth);
      gl.deleteBuffer(ubo);
      this.#atlases3d.set(source.id, { albedo, normal, used: this.#frameCount });
    }
  }

  // ── Resources ─────────────────────────────────────────────────────────────────

  createTexture(image: TextureImage, desc: TextureDesc): BackendTexture {
    const gl = this.#gl;
    const texture = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE0 + SETUP_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.texImage2D(gl.TEXTURE_2D, 0, desc.colorSpace === 'srgb' ? gl.SRGB8_ALPHA8 : gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, image as TexImageSource);
    gl.generateMipmap(gl.TEXTURE_2D);
    const wrap = (w: Wrap): number => (w === 'repeat' ? gl.REPEAT : w === 'clamp' ? gl.CLAMP_TO_EDGE : gl.MIRRORED_REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap(desc.wrapU));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap(desc.wrapV));
    const nearest = desc.filter === 'nearest';
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, nearest ? gl.NEAREST : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, nearest ? gl.NEAREST_MIPMAP_NEAREST : gl.LINEAR_MIPMAP_LINEAR);
    const handle: GlTextureHandle = { backend: 'webgl2', texture };
    return handle;
  }

  destroyTexture(texture: BackendTexture): void {
    this.#gl.deleteTexture((texture as GlTextureHandle).texture);
  }

  // ── Hi-Z depth read-back (occlusion.ts) ──────────────────────────────────────

  takeDepth(): DepthGrid | null {
    const grid = this.#depthReady;
    this.#depthReady = null;
    return grid;
  }

  /** Reduce the view's depth to the occlusion grid and start an asynchronous read (a pixel-pack buffer and a fence). */
  #reduceDepth(o: OcclusionPlan, depth: WebGLTexture): void {
    if (this.#pending.length >= 2) return;
    const gl = this.#gl;
    let r = this.#hiz;
    if (r === null || r.width !== o.width || r.height !== o.height) {
      if (r !== null) {
        gl.deleteTexture(r.texture);
        gl.deleteFramebuffer(r.framebuffer);
      }
      const texture = this.#colorTexture(o.width, o.height, gl.RGBA32F);
      const framebuffer = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      r = { texture, framebuffer, width: o.width, height: o.height };
      this.#hiz = r;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, r.framebuffer);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.viewport(0, 0, o.width, o.height);
    const program = this.#link('hiz', GLSL_HIZ);
    gl.useProgram(program);
    gl.uniform4f(gl.getUniformLocation(program, 'reduceParams'), o.block, Math.floor(o.viewport.x), Math.floor(o.viewport.y), o.height);
    this.#bind(GLSL_UNITS.depthTexture, depth);
    gl.bindVertexArray(this.#recordVao);
    for (let i = 0; i < 5; i++) gl.disableVertexAttribArray(i);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const buffer = gl.createBuffer()!;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, o.width * o.height * 16, gl.STREAM_READ);
    gl.readPixels(0, 0, o.width, o.height, gl.RGBA, gl.FLOAT, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (sync === null) {
      gl.deleteBuffer(buffer);
      return;
    }
    this.#pending.push({ buffer, sync, plan: o });
  }

  /** Reads whose fence has passed become the newest grid (rows flipped: GL reads bottom-up). */
  #pollDepth(): void {
    const gl = this.#gl;
    while (this.#pending.length > 0) {
      const p = this.#pending[0]!;
      const status = gl.clientWaitSync(p.sync, 0, 0);
      if (status !== gl.ALREADY_SIGNALED && status !== gl.CONDITION_SATISFIED) return;
      this.#pending.shift();
      gl.deleteSync(p.sync);
      const o = p.plan;
      const raw = new Float32Array(o.width * o.height * 4);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, p.buffer);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, raw);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      gl.deleteBuffer(p.buffer);
      const depths = new Float32Array(o.width * o.height);
      for (let y = 0; y < o.height; y++) {
        for (let x = 0; x < o.width; x++) depths[(o.height - 1 - y) * o.width + x] = raw[(y * o.width + x) * 4]!;
      }
      this.#depthReady = { width: o.width, height: o.height, depths, viewProjection: o.viewProjection, camera: o.camera, position: o.position, forward: o.forward };
    }
  }

  /** The compression extensions this context has, by family (sRGB variants included where the family needs a second one). */
  #extensions = new Map<string, boolean>();

  #has(name: string): boolean {
    let known = this.#extensions.get(name);
    if (known === undefined) this.#extensions.set(name, (known = this.#gl.getExtension(name) !== null));
    return known;
  }

  get compressed(): readonly CompressionFamily[] {
    const families: CompressionFamily[] = [];
    if (this.#has('WEBGL_compressed_texture_s3tc') && this.#has('WEBGL_compressed_texture_s3tc_srgb')) families.push('bc');
    if (this.#has('WEBGL_compressed_texture_astc')) families.push('astc');
    if (this.#has('WEBGL_compressed_texture_etc')) families.push('etc2');
    return families;
  }

  createCompressedTexture(image: Ktx2Image, format: BlockFormat, desc: TextureDesc): BackendTexture | null {
    const srgb = desc.colorSpace === 'srgb';
    if (!this.#has(format.webgl.extension) || (srgb && !this.#has(format.webgl.srgbExtension))) return null;
    const gl = this.#gl;
    const texture = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE0 + SETUP_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    const internal = srgb ? format.webgl.srgb : format.webgl.unorm;
    image.levels.forEach((bytes, level) => {
      gl.compressedTexImage2D(gl.TEXTURE_2D, level, internal, Math.max(1, image.width >> level), Math.max(1, image.height >> level), 0, bytes);
    });
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, image.levels.length - 1);
    const wrap = (w: Wrap): number => (w === 'repeat' ? gl.REPEAT : w === 'clamp' ? gl.CLAMP_TO_EDGE : gl.MIRRORED_REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap(desc.wrapU));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap(desc.wrapV));
    const nearest = desc.filter === 'nearest';
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, nearest ? gl.NEAREST : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, nearest ? gl.NEAREST_MIPMAP_NEAREST : image.levels.length > 1 ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    const handle: GlTextureHandle = { backend: 'webgl2', texture };
    return handle;
  }

  createTextureArray(images: readonly TextureImage[], size: number, options: TextureArrayOptions = {}): BackendTexture {
    const gl = this.#gl;
    const texture = gl.createTexture()!;
    const levels = Math.floor(Math.log2(size)) + 1;
    gl.activeTexture(gl.TEXTURE0 + SETUP_UNIT);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, levels, options.colorSpace === 'linear' ? gl.RGBA8 : gl.SRGB8_ALPHA8, size, size, Math.max(1, images.length));
    images.forEach((image, i) => gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, i, size, size, 1, gl.RGBA, gl.UNSIGNED_BYTE, image as TexImageSource));
    gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const address = options.wrap === 'repeat' ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, address);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, address);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
    const handle: GlTextureHandle = { backend: 'webgl2', texture };
    return handle;
  }

  target(id: string): BackendTexture | null {
    const t = this.#renderTargets.get(id);
    return t === undefined ? null : { backend: 'webgl2', texture: t.texture } as GlTextureHandle;
  }

  dropTarget(id: string): void {
    const t = this.#renderTargets.get(id);
    if (t === undefined) return;
    this.#gl.deleteTexture(t.texture);
    this.#gl.deleteFramebuffer(t.framebuffer);
    this.#renderTargets.delete(id);
  }

  /**
   * An offscreen view's image (the LDR target's bottom-left `width` × `height`, display
   * values) into its render target: rows flipped so its first row is the image's top (as
   * images upload), linearized so the sRGB target stores the same display values, mipmapped.
   */
  #copyToTarget(id: string, width: number, height: number, source: WebGLTexture): void {
    const gl = this.#gl;
    let t = this.#renderTargets.get(id);
    if (t === undefined || t.width !== width || t.height !== height) {
      if (t !== undefined) this.dropTarget(id);
      const texture = gl.createTexture()!;
      gl.activeTexture(gl.TEXTURE0 + SETUP_UNIT);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texStorage2D(gl.TEXTURE_2D, Math.floor(Math.log2(Math.max(width, height))) + 1, gl.SRGB8_ALPHA8, width, height);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const framebuffer = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      t = { texture, framebuffer, width, height };
      this.#renderTargets.set(id, t);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.framebuffer);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.viewport(0, 0, width, height);
    const program = this.#link('target-copy', TARGET_COPY);
    gl.useProgram(program);
    gl.uniform1i(gl.getUniformLocation(program, 'sourceHeight'), height);
    this.#bind(GLSL_UNITS.sourceTexture, source);
    gl.bindVertexArray(this.#recordVao);
    for (let i = 0; i < 5; i++) gl.disableVertexAttribArray(i);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.#bind(SETUP_UNIT, t.texture);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /** Depth texture sampling: compared (shadow atlases) or raw (the scene depth). */
  #depthSampling(texture: WebGLTexture, compare: boolean): void {
    const gl = this.#gl;
    gl.activeTexture(gl.TEXTURE0 + SETUP_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, compare ? gl.LINEAR : gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, compare ? gl.LINEAR : gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, compare ? gl.COMPARE_REF_TO_TEXTURE : gl.NONE);
    if (compare) gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LESS);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  #upload(g: Geometry3d): GlGeometry {
    const gl = this.#gl;
    const buffers: WebGLBuffer[] = [];
    const attrs: { location: number; buffer: WebGLBuffer; size: number; integer: boolean }[] = [];
    const attribute = (location: number, data: Float32Array | Uint16Array, size: number, integer: boolean): void => {
      const b = gl.createBuffer()!;
      buffers.push(b);
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      attrs.push({ location, buffer: b, size, integer });
    };
    attribute(L.position, g.positions, 3, false);
    attribute(L.normal, g.normals, 3, false);
    attribute(L.uv, g.uvs, 2, false);
    if (g.colors !== null) attribute(L.color, g.colors, 4, false);
    if (g.joints !== null && g.weights !== null) {
      attribute(L.joints, g.joints, 4, true);
      attribute(L.weights, g.weights, 4, false);
    }
    const attributes = (): void => {
      for (const a of attrs) {
        gl.bindBuffer(gl.ARRAY_BUFFER, a.buffer);
        gl.enableVertexAttribArray(a.location);
        if (a.integer) gl.vertexAttribIPointer(a.location, a.size, gl.UNSIGNED_SHORT, 0, 0);
        else gl.vertexAttribPointer(a.location, a.size, gl.FLOAT, false, 0, 0);
      }
      if (g.colors === null) {
        gl.disableVertexAttribArray(L.color);
        gl.vertexAttrib4f(L.color, 1, 1, 1, 1);
      }
    };
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    attributes();
    const index = gl.createBuffer()!;
    buffers.push(index);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, index);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, g.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return {
      vao, buffers, attributes, indexType: g.indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT, indexCount: g.indices.length,
      vertexCount: g.positions.length / 3, colors: g.colors === null ? null : buffers[3]!,
    };
  }

  #uploadEdges(g: Geometry3d): GlEdges {
    const gl = this.#gl;
    const geometry = this.#geometry.get(g);
    const indices = edgeIndices(g);
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    geometry.attributes();
    const index = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, index);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return { vao, index, count: indices.length };
  }

  #link(key: string, source: { vertex: string; fragment: string }): WebGLProgram {
    const known = this.#programs.get(key);
    if (known !== undefined) return known;
    const gl = this.#gl;
    const compile = (type: number, text: string): WebGLShader => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, text);
      gl.compileShader(shader);
      if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) !== true) {
        fail('PP9806', `The ${key} ${type === gl.VERTEX_SHADER ? 'vertex' : 'fragment'} shader did not compile: ${gl.getShaderInfoLog(shader) ?? ''}`, {
          fix: 'This is an engine bug; report it with the browser and GPU.',
        });
      }
      return shader;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, source.vertex));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, source.fragment));
    gl.linkProgram(program);
    if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true) {
      fail('PP9806', `The ${key} program did not link: ${gl.getProgramInfoLog(program) ?? ''}`, { fix: 'This is an engine bug; report it with the browser and GPU.' });
    }
    for (const [name, binding] of Object.entries(BLOCK)) {
      const index = gl.getUniformBlockIndex(program, name);
      if (index !== gl.INVALID_INDEX) gl.uniformBlockBinding(program, index, binding);
    }
    gl.useProgram(program);
    for (const [name, unit] of Object.entries(GLSL_UNITS)) {
      const location = gl.getUniformLocation(program, name);
      if (location !== null) gl.uniform1i(location, unit);
    }
    this.#programs.set(key, program);
    return program;
  }

  #scene(pass: ScenePass, variant: SceneVariant): WebGLProgram {
    return this.#link(`${pass}|${variant.skinned === true}|${variant.mrt === true}|${variant.overlay === true}`, glsl(pass, variant));
  }

  #post(pass: PostPass, variant: PostVariant): WebGLProgram {
    return this.#link(`post|${pass}|${JSON.stringify(variant)}`, glslPost(pass, variant));
  }

  // ── Targets ──────────────────────────────────────────────────────────────────

  #colorTexture(width: number, height: number, internal: number): WebGLTexture {
    const gl = this.#gl;
    const t = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE0 + SETUP_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, internal, Math.max(1, width), Math.max(1, height));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return t;
  }

  #depthTexture(width: number, height: number, compare: boolean): WebGLTexture {
    const gl = this.#gl;
    const t = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE0 + SETUP_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT32F, Math.max(1, width), Math.max(1, height));
    this.#depthSampling(t, compare);
    return t;
  }

  #targetsFor(plan: FramePlan, use: 'screen' | 'capture'): Targets {
    const gl = this.#gl;
    const { width, height } = plan;
    const aoScale = plan.flags.ao === 'half' ? 2 : 1;
    const levels = Math.max(1, plan.quality.bloomLevels);
    const t = this.#targetSets.get(use) ?? null;
    if (t !== null && t.width === width && t.height === height && t.aoScale === aoScale && t.bloom.length === levels) return t;
    if (t !== null) this.#dropTargets(t);
    const hdr = (w: number, h: number): WebGLTexture => this.#colorTexture(w, h, gl.RGBA16F);
    const bloom: { texture: WebGLTexture; width: number; height: number }[] = [];
    for (let i = 0, w = Math.ceil(width / 2), h = Math.ceil(height / 2); i < levels; i++, w = Math.ceil(w / 2), h = Math.ceil(h / 2)) {
      bloom.push({ texture: hdr(w, h), width: w, height: h });
    }
    const aoW = Math.ceil(width / aoScale);
    const aoH = Math.ceil(height / aoScale);
    const made: Targets = {
      width, height, aoScale,
      hdr: [hdr(width, height), hdr(width, height)],
      gbuf: hdr(width, height),
      depth: this.#depthTexture(width, height, false),
      ao: [this.#colorTexture(aoW, aoH, gl.R8), this.#colorTexture(aoW, aoH, gl.R8)],
      ssr: hdr(width, height),
      mask: hdr(width, height),
      ldr: this.#colorTexture(width, height, gl.RGBA8),
      bloom,
      framebuffers: new Map(),
    };
    this.#targetSets.set(use, made);
    return made;
  }

  #dropTargets(t: Targets): void {
    const gl = this.#gl;
    for (const x of [...t.hdr, t.gbuf, t.depth, ...t.ao, t.ssr, t.mask, t.ldr, ...t.bloom.map((b) => b.texture)]) gl.deleteTexture(x);
    for (const fb of t.framebuffers.values()) gl.deleteFramebuffer(fb);
  }

  /** A framebuffer over color textures (in order) and optionally the scene depth. */
  #framebuffer(t: Targets, key: string, colors: readonly WebGLTexture[], depth: boolean): WebGLFramebuffer {
    const gl = this.#gl;
    let fb = t.framebuffers.get(key);
    if (fb === undefined) {
      fb = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      colors.forEach((c, i) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, c, 0));
      if (depth) gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, t.depth, 0);
      gl.drawBuffers(colors.map((_, i) => gl.COLOR_ATTACHMENT0 + i));
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (status !== gl.FRAMEBUFFER_COMPLETE) fail('PP9811', `render3d's ${key} framebuffer is incomplete (0x${Number(status).toString(16)})`, { fix: 'This is an engine bug; report it with the browser and GPU.' });
      t.framebuffers.set(key, fb);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    return fb;
  }

  #atlases(plan: FramePlan): void {
    const gl = this.#gl;
    const make = (current: { texture: WebGLTexture; framebuffer: WebGLFramebuffer; size: number } | null, size: number, used: boolean) => {
      if (!used || (current !== null && current.size === size)) return current;
      if (current !== null) {
        gl.deleteTexture(current.texture);
        gl.deleteFramebuffer(current.framebuffer);
      }
      const texture = this.#depthTexture(size, size, true);
      const framebuffer = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, texture, 0);
      gl.drawBuffers([gl.NONE]);
      gl.readBuffer(gl.NONE);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return { texture, framebuffer, size };
    };
    this.#atlas = {
      sun: make(this.#atlas.sun, plan.sunAtlas, plan.shadowTiles.some((t) => t.atlas === 'sun')),
      local: make(this.#atlas.local, plan.localAtlas, plan.shadowTiles.some((t) => t.atlas === 'local')),
    };
  }

  #dataTextures(plan: FramePlan): void {
    const gl = this.#gl;
    const rows = (n: number, perTexel: number): number => Math.max(1, Math.ceil(n / perTexel / DATA_ROW));
    const want: [number, number, number] = [rows(plan.lights.length, 4), rows(plan.clusters.grid.length, 2), rows(plan.clusters.items.length, 1)];
    const upload = (unit: number, existing: WebGLTexture | undefined, had: number, need: number, internal: number, format: number, type: number, data: ArrayBufferView): WebGLTexture => {
      const t = existing ?? gl.createTexture()!;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      if (existing === undefined || need > had) {
        gl.texImage2D(gl.TEXTURE_2D, 0, internal, DATA_ROW, need, 0, format, type, data);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      } else {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, DATA_ROW, need, format, type, data);
      }
      return t;
    };
    const d = this.#data;
    const grown = (i: number): number => Math.max(want[i]!, d?.rows[i] ?? 0);
    this.#data = {
      lights: upload(GLSL_UNITS.lightData, d?.lights, d?.rows[0] ?? 0, want[0], gl.RGBA32F, gl.RGBA, gl.FLOAT, plan.lights),
      grid: upload(GLSL_UNITS.clusterGrid, d?.grid, d?.rows[1] ?? 0, want[1], gl.RG32UI, gl.RG_INTEGER, gl.UNSIGNED_INT, plan.clusters.grid),
      items: upload(GLSL_UNITS.clusterItems, d?.items, d?.rows[2] ?? 0, want[2], gl.R32UI, gl.RED_INTEGER, gl.UNSIGNED_INT, plan.clusters.items),
      rows: [grown(0), grown(1), grown(2)],
    };
  }

  #uploadPalette(palette: Float32Array): void {
    const gl = this.#gl;
    const joints = palette.length / 16;
    const rows = Math.max(1, Math.ceil(joints / PALETTE_ROW_JOINTS));
    const width = PALETTE_ROW_JOINTS * 4;
    const data = new Float32Array(rows * width * 4);
    data.set(palette);
    gl.activeTexture(gl.TEXTURE0 + GLSL_UNITS.paletteTexture);
    gl.bindTexture(gl.TEXTURE_2D, this.#palette);
    if (rows !== this.#paletteRows) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, rows, 0, gl.RGBA, gl.FLOAT, data);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      this.#paletteRows = rows;
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, rows, gl.RGBA, gl.FLOAT, data);
    }
  }

  #environment(env: EnvironmentPlan, nature: NaturePlan | null, skyImage: WebGLTexture): void {
    if (this.#env !== null && this.#env.key === env.key) return;
    const gl = this.#gl;
    const size = env.size;
    const mips = environmentMips(size);
    if (this.#env === null || this.#env.size !== size) {
      if (this.#env !== null) {
        gl.deleteTexture(this.#env.sky);
        gl.deleteTexture(this.#env.cube);
      }
      const cube = (levels: number): WebGLTexture => {
        const t = gl.createTexture()!;
        gl.activeTexture(gl.TEXTURE0 + SETUP_UNIT);
        gl.bindTexture(gl.TEXTURE_CUBE_MAP, t);
        gl.texStorage2D(gl.TEXTURE_CUBE_MAP, levels, gl.RGBA16F, size, size);
        gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, levels > 1 ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_CUBE_MAP, p, gl.CLAMP_TO_EDGE);
        gl.bindTexture(gl.TEXTURE_CUBE_MAP, null);
        return t;
      };
      this.#env = { key: '', size, sky: cube(1), cube: cube(mips) };
    }
    const target = this.#env;
    const data = new Float32Array(6 * (mips + 1) * ENV_SLOT);
    const slot = (i: number, face: number, roughness: number, faceSize: number): void => {
      const box = env.skybox;
      data.set([
        face, roughness, faceSize, prefilterSamples(size), ...env.zenith, 1, ...env.horizon, 1, box === null ? 0 : 1, box?.turn ?? 0, box?.intensity ?? 1, 0,
      ], i * ENV_SLOT);
    };
    for (let f = 0; f < 6; f++) slot(f, f, 0, size);
    for (let m = 0; m < mips; m++) for (let f = 0; f < 6; f++) slot(6 + m * 6 + f, f, m / Math.max(1, mips - 1), Math.max(1, size >> m));
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.#ubo.env);
    gl.bufferData(gl.UNIFORM_BUFFER, data, gl.DYNAMIC_DRAW);
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.bindVertexArray(this.#recordVao);
    const draw = (texture: WebGLTexture, face: number, level: number, faceSize: number, slotIndex: number): void => {
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_CUBE_MAP_POSITIVE_X + face, texture, level);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
      gl.viewport(0, 0, faceSize, faceSize);
      gl.bindBufferRange(gl.UNIFORM_BUFFER, BLOCK.Env, this.#ubo.env, slotIndex * ENV_SLOT * 4, floatsOf(ENV_FIELDS) * 4);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    gl.useProgram(this.#post('envSky', {}));
    this.#bind(GLSL_UNITS.skyImage, skyImage);
    for (let f = 0; f < 6; f++) {
      // The sky model's faces (sky_webgl2.ts restores the program, VAO and UBO state itself).
      if (nature !== null && nature.sky !== null && env.skybox === null) this.#nature.environmentFace(target.sky, f, size, nature);
      else draw(target.sky, f, 0, size, f);
    }
    gl.useProgram(this.#post('envPrefilter', {}));
    gl.activeTexture(gl.TEXTURE0 + GLSL_UNITS.skyCube);
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, target.sky);
    for (let m = 0; m < mips; m++) for (let f = 0; f < 6; f++) draw(target.cube, f, m, Math.max(1, size >> m), 6 + m * 6 + f);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    target.key = env.key;
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

  #bind(unit: number, texture: WebGLTexture, target: number = this.#gl.TEXTURE_2D): void {
    const gl = this.#gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(target, texture);
  }

  #pointInstances(firstInstance: number): void {
    const gl = this.#gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#instances);
    const locations = [L.model0, L.model1, L.model2, L.model3, L.normal0, L.normal1, L.normal2, L.tint];
    locations.forEach((location, i) => {
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, 4, gl.FLOAT, false, MESH_INSTANCE_FLOATS * 4, firstInstance * MESH_INSTANCE_FLOATS * 4 + i * 16);
      gl.vertexAttribDivisor(location, 1);
    });
  }

  #pointRecords(buffer: WebGLBuffer, floats: number, count: number, first: number, divisor: number): void {
    const gl = this.#gl;
    gl.bindVertexArray(this.#recordVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    for (let i = 0; i < count; i++) {
      gl.enableVertexAttribArray(i);
      gl.vertexAttribPointer(i, 4, gl.FLOAT, false, floats * 4, first * floats * 4 + i * 16);
      gl.vertexAttribDivisor(i, divisor);
    }
    for (let i = count; i < 5; i++) gl.disableVertexAttribArray(i);
  }

  // ── The frame ─────────────────────────────────────────────────────────────────

  render(plan: FramePlan, texture: (ref: TextureRef) => BackendTexture, resources: FrameResources = NO_RESOURCES, capture?: (pixels: Uint8Array) => void): void {
    const gl = this.#gl;
    this.#pollDepth();
    const f = plan.flags;
    const handle = (ref: TextureRef | null | undefined): WebGLTexture => (ref === null || ref === undefined ? this.#white : (texture(ref) as GlTextureHandle).texture);
    const upload = (target: number, buffer: WebGLBuffer, data: Float32Array): void => {
      gl.bindBuffer(target, buffer);
      gl.bufferData(target, data, gl.DYNAMIC_DRAW);
    };
    upload(gl.UNIFORM_BUFFER, this.#ubo.frame, plan.frames);
    upload(gl.UNIFORM_BUFFER, this.#ubo.material, plan.materials);
    upload(gl.UNIFORM_BUFFER, this.#ubo.shadows, plan.shadowBlock);
    upload(gl.UNIFORM_BUFFER, this.#ubo.caster, plan.casters);
    upload(gl.ARRAY_BUFFER, this.#instances, plan.instances);
    upload(gl.ARRAY_BUFFER, this.#billboards, plan.billboards);
    upload(gl.ARRAY_BUFFER, this.#lines, plan.lines);
    this.#uploadPalette(plan.palette);
    this.#atlases(plan);
    this.#dataTextures(plan);
    this.#environment(plan.environment, plan.nature, handle(plan.environment.skybox?.texture ?? null));
    if (plan.decals !== null) upload(gl.ARRAY_BUFFER, this.#decals, plan.decals.records);
    const impostorFrame = plan.impostors;
    if (impostorFrame !== null) {
      this.#bakeImpostors(impostorFrame, (ref) => handle(ref));
      upload(gl.UNIFORM_BUFFER, this.#impostorUbo, impostorFrame.blocks);
      upload(gl.ARRAY_BUFFER, this.#impostorInstances, impostorFrame.instances.length > 0 ? impostorFrame.instances : new Float32Array(IMPOSTOR_INSTANCE_FLOATS));
    }
    const t = this.#targetsFor(plan, capture === undefined ? 'screen' : 'capture');
    const current = t.hdr[f.resolve ? 1 : 0];
    const currentKey = f.resolve ? 'hdr1' : 'hdr0';
    gl.bindBufferBase(gl.UNIFORM_BUFFER, BLOCK.Shadows, this.#ubo.shadows);

    const bindFrame = (slot: number): void => gl.bindBufferRange(gl.UNIFORM_BUFFER, BLOCK.Frame, this.#ubo.frame, slot * FRAME_SLOT * 4, floatsOf(FRAME_FIELDS) * 4);
    const bindSlot = (slot: number, floats: number): void => gl.bindBufferRange(gl.UNIFORM_BUFFER, BLOCK.Material, this.#ubo.material, slot * MATERIAL_SLOT * 4, floats * 4);
    const state = (depthTest: boolean, depthWrite: boolean, blend: 'none' | 'alpha' | 'premultiplied' | 'add', cull: boolean, depthFunc: number = gl.LEQUAL): void => {
      if (depthTest) gl.enable(gl.DEPTH_TEST); else gl.disable(gl.DEPTH_TEST);
      gl.depthFunc(depthFunc);
      gl.depthMask(depthWrite);
      if (blend === 'none') {
        gl.disable(gl.BLEND);
      } else {
        gl.enable(gl.BLEND);
        if (blend === 'alpha') gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        else if (blend === 'premultiplied') gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        else gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ZERO, gl.ONE);
      }
      if (cull) gl.enable(gl.CULL_FACE); else gl.disable(gl.CULL_FACE);
    };
    /** Viewport and scissor for a view in a target `height` texels tall, `scale` times smaller than the full target. */
    const enterView = (vp: ViewPlan, height: number, scale = 1): void => {
      const x = vp.viewport.x / scale; const w = vp.viewport.width / scale; const h = vp.viewport.height / scale;
      const y = height - vp.viewport.y / scale - h;
      gl.viewport(x, y, w, h);
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(Math.floor(x), Math.floor(y), Math.max(1, Math.ceil(w)), Math.max(1, Math.ceil(h)));
      bindFrame(vp.frameSlot);
    };
    const clear = (color: boolean, depth: boolean): void => {
      gl.disable(gl.SCISSOR_TEST);
      gl.colorMask(true, true, true, true);
      gl.depthMask(true);
      gl.clearColor(0, 0, 0, 0);
      gl.clearDepth(1);
      gl.clear((color ? gl.COLOR_BUFFER_BIT : 0) | (depth ? gl.DEPTH_BUFFER_BIT : 0));
    };
    const frameTextures = (): void => {
      this.#bind(GLSL_UNITS.sunAtlas, this.#atlas.sun?.texture ?? this.#dummyShadow);
      this.#bind(GLSL_UNITS.localAtlas, this.#atlas.local?.texture ?? this.#dummyShadow);
      this.#bind(GLSL_UNITS.paletteTexture, this.#palette);
      this.#bind(GLSL_UNITS.lightData, this.#data!.lights);
      this.#bind(GLSL_UNITS.clusterGrid, this.#data!.grid);
      this.#bind(GLSL_UNITS.clusterItems, this.#data!.items);
      this.#bind(GLSL_UNITS.envCube, this.#env!.cube, gl.TEXTURE_CUBE_MAP);
    };
    const drawGeometry = (geometry: Geometry3d, instance: number, count: number, skinned: boolean, wire: boolean): void => {
      if (skinned && geometry.joints === null) fail('PP9804', `Geometry ${geometry.id} is drawn skinned but has no joints`);
      if (wire) {
        const e = this.#edges.get(geometry);
        gl.bindVertexArray(e.vao);
        this.#pointInstances(instance);
        gl.drawElementsInstanced(gl.LINES, e.count, gl.UNSIGNED_INT, 0, count);
      } else {
        const g = this.#geometry.get(geometry);
        gl.bindVertexArray(g.vao);
        this.#pointInstances(instance);
        gl.drawElementsInstanced(gl.TRIANGLES, g.indexCount, g.indexType, 0, count);
      }
    };
    const drawTerrain = (terrain: TerrainItem, asMesh: boolean, wire: boolean, perTile?: (tile: TerrainItem['tiles'][number]) => void): void => {
      for (const tile of terrain.tiles) {
        const chunk = tile.geometry;
        perTile?.(tile);
        if (asMesh) {
          drawGeometry(chunk, terrain.instance, 1, false, false);
        } else if (wire) {
          const e = this.#edges.get(chunk);
          gl.bindVertexArray(e.vao);
          gl.drawElements(gl.LINES, e.count, gl.UNSIGNED_INT, 0);
        } else {
          const g = this.#geometry.get(chunk);
          gl.bindVertexArray(g.vao);
          gl.drawElements(gl.TRIANGLES, g.indexCount, g.indexType, 0);
        }
      }
    };
    const bindMaterial = (item: MeshItem): void => {
      const m = item.material;
      bindSlot(item.materialSlot, floatsOf(MATERIAL_FIELDS));
      this.#bind(GLSL_UNITS.baseTexture, handle(m.baseColorTexture));
      this.#bind(GLSL_UNITS.surfaceTexture, handle(m.metallicRoughnessTexture));
      this.#bind(GLSL_UNITS.emissiveTexture, handle(m.emissiveTexture));
      this.#bind(GLSL_UNITS.normalTexture, handle(m.normalTexture));
      this.#bind(GLSL_UNITS.occlusionTexture, handle(m.occlusionTexture));
    };
    const drawBillboards = (items: readonly BillboardItem[], overlay: boolean): void => {
      state(true, false, 'alpha', false);
      gl.useProgram(this.#scene('billboard', { overlay }));
      for (const item of items) {
        this.#bind(GLSL_UNITS.image, handle(item.texture));
        this.#pointRecords(this.#billboards, BILLBOARD_INSTANCE_FLOATS, 5, item.first, 1);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, item.count);
      }
    };
    const drawLines = (range: { first: number; count: number }, overlay: boolean): void => {
      if (range.count === 0) return;
      state(true, false, 'alpha', false);
      gl.useProgram(this.#scene('line', { overlay }));
      this.#pointRecords(this.#lines, LINE_VERTEX_FLOATS, 4, 0, 0);
      gl.drawArrays(gl.TRIANGLES, range.first, range.count);
    };
    /** A full-screen pass into the bound framebuffer; `textures` are bound to their units first. */
    const fullscreen = (pass: PostPass, variant: PostVariant, textures: readonly [number, WebGLTexture][], blend: 'none' | 'add' | 'premultiplied' = 'none'): void => {
      state(false, false, blend, false);
      gl.useProgram(this.#post(pass, variant));
      for (const [unit, tex] of textures) this.#bind(unit, tex);
      gl.bindVertexArray(this.#recordVao);
      for (let i = 0; i < 5; i++) gl.disableVertexAttribArray(i);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    const U = GLSL_UNITS;

    visitPasses(plan, {
      environment: () => {},
      shadows: (tiles) => {
        gl.cullFace(gl.BACK);
        // Atlases are render targets now: never bound for sampling while drawn into.
        this.#bind(U.sunAtlas, this.#dummyShadow);
        this.#bind(U.localAtlas, this.#dummyShadow);
        this.#bind(U.paletteTexture, this.#palette);
        for (const atlas of ['sun', 'local'] as const) {
          const mine = tiles.filter((tile) => tile.atlas === atlas);
          const map = this.#atlas[atlas];
          if (mine.length === 0 || map === null) continue;
          gl.bindFramebuffer(gl.FRAMEBUFFER, map.framebuffer);
          clear(false, true);
          state(true, true, 'none', true);
          gl.enable(gl.POLYGON_OFFSET_FILL);
          gl.polygonOffset(2, 2);
          gl.enable(gl.SCISSOR_TEST);
          for (const tile of mine) {
            gl.viewport(tile.x, tile.y, tile.size, tile.size);
            gl.scissor(tile.x, tile.y, tile.size, tile.size);
            gl.bindBufferRange(gl.UNIFORM_BUFFER, BLOCK.Caster, this.#ubo.caster, tile.slot * CASTER_SLOT * 4, floatsOf(CASTER_FIELDS) * 4);
            for (const item of tile.casters) {
              gl.useProgram(this.#scene('caster', { skinned: item.skinned }));
              drawGeometry(item.geometry, item.firstInstance, item.instanceCount, item.skinned, false);
            }
            if (tile.terrain !== null) {
              gl.useProgram(this.#scene('caster', {}));
              drawTerrain(tile.terrain, true, false);
            }
          }
          gl.disable(gl.POLYGON_OFFSET_FILL);
        }
        frameTextures();
      },
      scene: (vp, first) => {
        if (first) frameTextures();
        gl.cullFace(vp.mirrored ? gl.FRONT : gl.BACK);
        this.#framebuffer(t, f.gbuffer ? 'hdr0+gbuf+depth' : 'hdr0+depth', f.gbuffer ? [t.hdr[0], t.gbuf] : [t.hdr[0]], true);
        if (first) clear(true, true);
        enterView(vp, t.height);
        const mrt = f.gbuffer;
        state(false, false, 'none', false);
        gl.useProgram(this.#scene('sky', { mrt }));
        this.#bind(GLSL_UNITS.skyImage, handle(plan.environment.skybox?.texture ?? null));
        gl.bindVertexArray(this.#recordVao);
        for (let i = 0; i < 5; i++) gl.disableVertexAttribArray(i);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        const wire = f.wireframe;
        if (vp.terrain !== null) {
          state(true, true, 'none', !wire);
          gl.useProgram(this.#scene('terrain', { mrt }));
          const arrays = (resources.terrain ?? this.#emptyTerrainArrays()) as { albedo: GlTextureHandle; normal: GlTextureHandle };
          this.#bind(U.terrainAlbedo, arrays.albedo.texture, gl.TEXTURE_2D_ARRAY);
          this.#bind(U.terrainNormal, arrays.normal.texture, gl.TEXTURE_2D_ARRAY);
          this.#bind(U.splatMap, (resources.terrain?.splat as GlTextureHandle | null | undefined)?.texture ?? this.#white);
          let bound = -1;
          drawTerrain(vp.terrain, false, wire, (tile) => {
            if (tile.uniformSlot === bound) return;
            bound = tile.uniformSlot;
            bindSlot(tile.uniformSlot, floatsOf(TERRAIN_FIELDS));
            for (let i = 0; i < 4; i++) this.#bind(U.detail0 + i, handle(tile.textures[i] ?? null));
          });
        }
        for (const item of vp.opaque) {
          state(true, true, 'none', !item.material.doubleSided && !wire);
          gl.useProgram(this.#scene('mesh', { skinned: item.skinned, mrt }));
          bindMaterial(item);
          drawGeometry(item.geometry, item.firstInstance, item.instanceCount, item.skinned, wire);
        }
        const far = impostorFrame?.views[plan.views.indexOf(vp)] ?? [];
        if (far.length > 0 && !wire) {
          state(true, true, 'none', false);
          gl.useProgram(this.#link(`impostor|${mrt}`, glslImpostor(mrt)));
          for (const item of far) {
            const atlas = this.#atlases3d.get(item.source.id)!;
            atlas.used = this.#frameCount;
            gl.bindBufferRange(gl.UNIFORM_BUFFER, BLOCK.Impostor, this.#impostorUbo, item.slot * IMPOSTOR_SLOT * 4, floatsOf(IMPOSTOR_FIELDS) * 4);
            this.#bind(U.albedoAtlas, atlas.albedo);
            this.#bind(U.normalAtlas, atlas.normal);
            this.#pointRecords(this.#impostorInstances, IMPOSTOR_INSTANCE_FLOATS, 2, item.first, 1);
            gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, item.count);
          }
        }
        if (plan.occlusion !== null && plan.occlusion.slot === vp.frameSlot) this.#reduceDepth(plan.occlusion, t.depth);
      },
      ao: (vp) => {
        const s = t.aoScale;
        const aoHeight = Math.ceil(t.height / s);
        this.#framebuffer(t, 'ao0', [t.ao[0]], false);
        enterView(vp, aoHeight, s);
        fullscreen('ao', { scale: s, samples: s === 2 ? 8 : 12 }, [[U.depthTexture, t.depth], [U.gbufTexture, t.gbuf]]);
        this.#framebuffer(t, 'ao1', [t.ao[1]], false);
        enterView(vp, aoHeight, s);
        fullscreen('aoBlur', { scale: s }, [[U.aoTexture, t.ao[0]], [U.depthTexture, t.depth]]);
      },
      reflections: (vp) => {
        this.#framebuffer(t, 'ssr', [t.ssr], false);
        enterView(vp, t.height);
        fullscreen('reflections', {}, [[U.depthTexture, t.depth], [U.gbufTexture, t.gbuf], [U.hdrTexture, t.hdr[0]]]);
      },
      resolve: (vp) => {
        this.#framebuffer(t, 'hdr1', [t.hdr[1]], false);
        enterView(vp, t.height);
        fullscreen('resolve', {}, [
          [U.hdrTexture, t.hdr[0]], [U.aoTexture, f.ao === 'off' ? this.#white : t.ao[1]], [U.ssrTexture, f.reflections ? t.ssr : this.#black],
          [U.gbufTexture, t.gbuf], [U.depthTexture, t.depth],
        ]);
      },
      nature: (vp) => this.#nature.draw({
        plan: plan.nature!, view: vp.frameSlot, viewport: vp.viewport, color: current, depth: t.depth, cube: this.#env!.cube, width: t.width, height: t.height,
      }),
      transparent: (vp) => {
        this.#framebuffer(t, `${currentKey}+depth`, [current], true);
        enterView(vp, t.height);
        gl.cullFace(vp.mirrored ? gl.FRONT : gl.BACK);
        const meshes = (items: readonly MeshItem[], blend: boolean): void => {
          for (const item of items) {
            state(true, !blend, !blend ? 'none' : transmissive(item.material) ? 'premultiplied' : 'alpha', !item.material.doubleSided && !f.wireframe);
            gl.useProgram(this.#scene('mesh', { skinned: item.skinned }));
            bindMaterial(item);
            drawGeometry(item.geometry, item.firstInstance, item.instanceCount, item.skinned, f.wireframe);
          }
        };
        // The viewmodel layer's opaque surfaces first (their overlay depth is in front of the world's), then the world's blended ones.
        const overlay = vp.overlaySlot ?? vp.frameSlot;
        if (vp.viewmodel.length > 0) {
          bindFrame(overlay);
          meshes(vp.viewmodel, false);
          bindFrame(vp.frameSlot);
        }
        meshes(vp.transparent, true);
        if (vp.billboards.length > 0) drawBillboards(vp.billboards, false);
        drawLines(vp.lines, false);
        if (vp.viewmodelTransparent.length > 0) {
          bindFrame(overlay);
          meshes(vp.viewmodelTransparent, true);
          bindFrame(vp.frameSlot);
        }
        gl.cullFace(gl.BACK);
        if (plan.vfx !== null) {
          // Color only: the shaders read the scene's depth, which can't be attached at the same time.
          this.#framebuffer(t, currentKey, [current], false);
          enterView(vp, t.height);
          this.#vfx.draw({ plan: plan.vfx, depth: t.depth, image: (ref) => handle(ref) });
        }
      },
      decals: (vp) => {
        const images = resources.decals as GlTextureHandle | null;
        if (images === null) return;
        const range = plan.decals!.views[vp.frameSlot]!;
        this.#framebuffer(t, currentKey, [current], false);
        enterView(vp, t.height);
        state(false, false, 'alpha', true);
        gl.cullFace(vp.mirrored ? gl.BACK : gl.FRONT);
        gl.useProgram(this.#link('decals', glslDecal()));
        this.#bind(U.depthTexture, t.depth);
        this.#bind(U.decalImages, images.texture, gl.TEXTURE_2D_ARRAY);
        this.#pointRecords(this.#decals, DECAL_FLOATS, 10, range.first, 1);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 36, range.count);
        gl.cullFace(gl.BACK);
      },
      target: (target) => this.#copyToTarget(target.id, target.width, target.height, t.ldr),
      volumetric: (vp) => {
        this.#framebuffer(t, currentKey, [current], false);
        enterView(vp, t.height);
        fullscreen('volumetric', { samples: 24 }, [[U.depthTexture, t.depth]], 'add');
      },
      fogOfWar: (vp) => {
        const fog = vp.fog!;
        let known = this.#fogTextures.get(vp.frameSlot);
        if (known === undefined || known.key !== fog.key) {
          const texture = known?.texture ?? gl.createTexture()!;
          gl.activeTexture(gl.TEXTURE0 + SETUP_UNIT);
          gl.bindTexture(gl.TEXTURE_2D, texture);
          gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, fog.width, fog.height, 0, gl.RED, gl.UNSIGNED_BYTE, fog.texels);
          gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          known = { key: fog.key, texture };
          this.#fogTextures.set(vp.frameSlot, known);
        }
        this.#framebuffer(t, currentKey, [current], false);
        enterView(vp, t.height);
        fullscreen('fogOfWar', {}, [[U.depthTexture, t.depth], [U.fogTexture, known.texture]], 'premultiplied');
      },
      depthOfField: (vp) => this.#dof.draw({
        plan: vp.depthOfField!, viewport: vp.viewport, color: current, depth: t.depth, width: t.width, height: t.height,
      }),
      godRays: (vp) => {
        this.#framebuffer(t, currentKey, [current], false);
        enterView(vp, t.height);
        fullscreen('godRays', { samples: plan.quality.level === 'high' ? 40 : 24 }, [[U.depthTexture, t.depth]], 'add');
      },
      outlines: (vp, first) => {
        this.#framebuffer(t, 'mask+depth', [t.mask], true);
        if (first) clear(true, false);
        enterView(vp, t.height);
        gl.enable(gl.POLYGON_OFFSET_FILL);
        gl.polygonOffset(-1, -4);
        for (const o of vp.outlines) {
          state(true, false, 'none', false, o.throughWalls ? gl.ALWAYS : gl.LEQUAL);
          gl.useProgram(this.#scene('outline', { skinned: o.item.skinned }));
          bindSlot(o.slot, floatsOf(OUTLINE_FIELDS));
          drawGeometry(o.item.geometry, o.item.firstInstance, o.item.instanceCount, o.item.skinned, false);
        }
        gl.disable(gl.POLYGON_OFFSET_FILL);
      },
      bloom: (levels) => {
        bindFrame(0);
        const chain = t.bloom.slice(0, levels);
        const into = (i: number): void => {
          this.#framebuffer(t, `bloom${i}`, [chain[i]!.texture], false);
          gl.disable(gl.SCISSOR_TEST);
          gl.viewport(0, 0, chain[i]!.width, chain[i]!.height);
        };
        into(0);
        fullscreen('bloomPrefilter', {}, [[U.sourceTexture, current]]);
        for (let i = 1; i < chain.length; i++) {
          into(i);
          fullscreen('bloomDown', {}, [[U.sourceTexture, chain[i - 1]!.texture]]);
        }
        for (let i = chain.length - 1; i > 0; i--) {
          into(i - 1);
          fullscreen('bloomUp', {}, [[U.sourceTexture, chain[i]!.texture]], 'add');
        }
      },
      final: (vp, first) => {
        this.#framebuffer(t, 'ldr', [t.ldr], false);
        if (first) clear(true, false);
        enterView(vp, t.height);
        fullscreen('final', {}, [
          [U.hdrTexture, current], [U.bloomTexture, f.bloomLevels > 0 ? t.bloom[0]!.texture : this.#black], [U.depthTexture, t.depth],
          [U.gbufTexture, f.gbuffer ? t.gbuf : this.#black], [U.maskTexture, f.outlines ? t.mask : this.#black],
        ]);
      },
      overlay: (vp) => {
        this.#framebuffer(t, 'ldr+depth', [t.ldr], true);
        enterView(vp, t.height);
        if (vp.overlayBillboards.length > 0) drawBillboards(vp.overlayBillboards, true);
        drawLines(vp.overlayLines, true);
      },
      present: () => {
        if (capture !== undefined) {
          // A capture: the finished image, read back top row first.
          this.#framebuffer(t, 'ldr', [t.ldr], false);
          const raw = new Uint8Array(plan.width * plan.height * 4);
          gl.readPixels(0, 0, plan.width, plan.height, gl.RGBA, gl.UNSIGNED_BYTE, raw);
          const pixels = new Uint8Array(raw.length);
          const row = plan.width * 4;
          for (let y = 0; y < plan.height; y++) pixels.set(raw.subarray((plan.height - 1 - y) * row, (plan.height - y) * row), y * row);
          capture(pixels);
          return;
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.disable(gl.SCISSOR_TEST);
        gl.viewport(0, 0, plan.output.width, plan.output.height);
        bindFrame(0);
        fullscreen('present', { fxaa: f.fxaa }, [[U.sourceTexture, t.ldr]]);
      },
    });
    gl.bindVertexArray(null);
    this.#geometry.endFrame();
    this.#edges.endFrame();
    this.#frameCount++;
    for (const [id, atlas] of this.#atlases3d) {
      if (this.#frameCount - atlas.used > 600) {
        gl.deleteTexture(atlas.albedo);
        gl.deleteTexture(atlas.normal);
        this.#atlases3d.delete(id);
      }
    }
  }

  dispose(): void {
    const gl = this.#gl;
    this.#nature.dispose();
    this.#vfx.dispose();
    this.#dof.dispose();
    for (const atlas of this.#atlases3d.values()) {
      gl.deleteTexture(atlas.albedo);
      gl.deleteTexture(atlas.normal);
    }
    gl.deleteBuffer(this.#impostorUbo);
    gl.deleteBuffer(this.#decals);
    for (const id of [...this.#renderTargets.keys()]) this.dropTarget(id);
    gl.deleteBuffer(this.#impostorInstances);
    this.#edges.clear();
    this.#geometry.clear();
    for (const b of [...Object.values(this.#ubo), this.#instances, this.#billboards, this.#lines]) gl.deleteBuffer(b);
    gl.deleteVertexArray(this.#recordVao);
    for (const x of [this.#palette, this.#white, this.#black, this.#dummyShadow]) gl.deleteTexture(x);
    for (const t of this.#targetSets.values()) this.#dropTargets(t);
    for (const a of [this.#atlas.sun, this.#atlas.local]) {
      if (a === null) continue;
      gl.deleteTexture(a.texture);
      gl.deleteFramebuffer(a.framebuffer);
    }
    if (this.#data !== null) for (const x of [this.#data.lights, this.#data.grid, this.#data.items]) gl.deleteTexture(x);
    if (this.#env !== null) {
      gl.deleteTexture(this.#env.sky);
      gl.deleteTexture(this.#env.cube);
    }
    for (const p of this.#programs.values()) gl.deleteProgram(p);
  }
}

/** An offscreen view's image into its render target (see `#copyToTarget`). */
const TARGET_COPY = {
  vertex: `${GLSL_HEADER}
void main() {
  vec2 corners[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  gl_Position = vec4(corners[gl_VertexID], 0.0, 1.0);
}
`,
  fragment: `${GLSL_HEADER}
uniform sampler2D sourceTexture;
uniform int sourceHeight;
out vec4 fragColor;
void main() {
  vec4 c = texelFetch(sourceTexture, ivec2(int(gl_FragCoord.x), sourceHeight - 1 - int(gl_FragCoord.y)), 0);
  vec3 x = clamp(c.rgb, vec3(0.0), vec3(1.0));
  fragColor = vec4(mix(pow((x + vec3(0.055)) / 1.055, vec3(2.4)), x / 12.92, vec3(lessThanEqual(x, vec3(0.04045)))), 1.0);
}
`,
};
