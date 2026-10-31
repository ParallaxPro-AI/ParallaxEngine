/**
 * The outdoors on WebGL2 — the same passes as sky_webgpu.ts. It keeps to its own objects:
 * uniform binding points 5 (nature) and 6 (water), texture units 6 (the environment cube,
 * which the backend binds there too) and 7–10, its own framebuffers and vertex arrays, and
 * it leaves no program, vertex array or framebuffer bound. Every pass the backend draws
 * afterwards sets the state and binds the textures it uses.
 */

import { floatsOf, offsetOf } from './layout.js';
import { NATURE_FIELDS, NATURE_SLOT, faceSlot } from './sky_plan.js';
import type { CloudMode, NaturePlan } from './sky_plan.js';
import { glslSky } from './sky_shaders.js';
import { linkNature, NATURE_BLOCK, UNITS } from './sky_webgl2_link.js';
import type { NatureTargetsGl } from './sky_webgl2_link.js';
import { WaterWebGl2 } from './water_webgl2.js';

export type { NatureTargetsGl } from './sky_webgl2_link.js';

type GL = WebGL2RenderingContext;

/** Where a view's far-fade end sits in its nature slot (0: no fade pass). */
const VIEW_FADE_END = offsetOf(NATURE_FIELDS, 'viewFade') + 1;

export class NatureWebGl2 {
  readonly #gl: GL;
  readonly #programs = new Map<string, WebGLProgram>();
  readonly #uniforms: WebGLBuffer;
  readonly #vao: WebGLVertexArrayObject;
  readonly #blackCube: WebGLTexture;
  readonly #noCover: WebGLTexture;
  readonly #water: WaterWebGl2;
  #cover: { texture: WebGLTexture; size: number; version: number } | null = null;
  readonly #framebuffers = new Map<WebGLTexture, WebGLFramebuffer>();
  #uploaded: NaturePlan | null = null;

  constructor(gl: GL) {
    this.#gl = gl;
    this.#uniforms = gl.createBuffer()!;
    this.#vao = gl.createVertexArray()!;
    this.#blackCube = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, this.#blackCube);
    gl.texStorage2D(gl.TEXTURE_CUBE_MAP, 1, gl.RGBA8, 1, 1);
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, null);
    this.#noCover = this.#floatTexture(1);
    this.#water = new WaterWebGl2(gl);
  }

  #floatTexture(size: number): WebGLTexture {
    const gl = this.#gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32F, size, size);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return t;
  }

  #program(face: boolean | 'fade', quality: number, clouds: CloudMode): WebGLProgram {
    const key = `${face === 'fade' ? 'fade' : face ? 'face' : 'composite'}|${quality}|${clouds}`;
    let p = this.#programs.get(key);
    if (p === undefined) {
      p = linkNature(this.#gl, `nature ${key}`, glslSky(quality, face, clouds), { depthTexture: UNITS.depth, envCube: UNITS.cube, coverTexture: UNITS.cover });
      this.#programs.set(key, p);
    }
    return p;
  }

  #upload(plan: NaturePlan): void {
    if (this.#uploaded === plan) return;
    const gl = this.#gl;
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.#uniforms);
    gl.bufferData(gl.UNIFORM_BUFFER, plan.uniforms, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.UNIFORM_BUFFER, null);
    const cover = plan.cover;
    if (cover !== null) {
      if (this.#cover === null || this.#cover.size !== cover.size) {
        if (this.#cover !== null) gl.deleteTexture(this.#cover.texture);
        this.#cover = { texture: this.#floatTexture(cover.size), size: cover.size, version: -1 };
      }
      if (this.#cover.version !== cover.version) {
        gl.bindTexture(gl.TEXTURE_2D, this.#cover.texture);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, cover.size, cover.size, gl.RED, gl.FLOAT, cover.heights);
        gl.bindTexture(gl.TEXTURE_2D, null);
        this.#cover.version = cover.version;
      }
    }
    this.#uploaded = plan;
  }

  #bindSlot(slot: number): void {
    this.#gl.bindBufferRange(this.#gl.UNIFORM_BUFFER, NATURE_BLOCK, this.#uniforms, slot * NATURE_SLOT * 4, floatsOf(NATURE_FIELDS) * 4);
  }

  #bind(unit: number, texture: WebGLTexture, target: number = this.#gl.TEXTURE_2D): void {
    this.#gl.activeTexture(this.#gl.TEXTURE0 + unit);
    this.#gl.bindTexture(target, texture);
  }

  /** Render one face of the environment cube into the framebuffer the backend has bound (level 0 of `texture`). */
  environmentFace(texture: WebGLTexture, face: number, size: number, plan: NaturePlan): void {
    const gl = this.#gl;
    this.#upload(plan);
    const vao = gl.getParameter(gl.VERTEX_ARRAY_BINDING) as WebGLVertexArrayObject | null;
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_CUBE_MAP_POSITIVE_X + face, texture, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.viewport(0, 0, size, size);
    gl.useProgram(this.#program(true, plan.quality, plan.clouds));
    this.#bindSlot(faceSlot(plan, face));
    this.#bind(UNITS.cube, this.#blackCube, gl.TEXTURE_CUBE_MAP);
    this.#bind(UNITS.depth, this.#noCover);
    this.#bind(UNITS.cover, this.#cover?.texture ?? this.#noCover);
    gl.bindVertexArray(this.#vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(vao);
  }

  /** A framebuffer drawing into one color texture. */
  #target(color: WebGLTexture): WebGLFramebuffer {
    const gl = this.#gl;
    let fb = this.#framebuffers.get(color);
    if (fb === undefined) {
      // The backend's targets were replaced (a resize): framebuffers over the old ones go.
      if (this.#framebuffers.size >= 4) {
        for (const old of this.#framebuffers.values()) gl.deleteFramebuffer(old);
        this.#framebuffers.clear();
      }
      fb = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, color, 0);
      this.#framebuffers.set(color, fb);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    return fb;
  }

  draw(t: NatureTargetsGl): void {
    const gl = this.#gl;
    const plan = t.plan;
    this.#upload(plan);
    const vp = t.viewport;
    const y = t.height - vp.y - vp.height;
    // The composite before the water, the far fade after it (over the surfaces' depth): dst·k + add.
    const fullscreen = (fade: boolean): void => {
      this.#target(t.color);
      gl.viewport(vp.x, y, vp.width, vp.height);
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(Math.floor(vp.x), Math.floor(y), Math.max(1, Math.ceil(vp.width)), Math.max(1, Math.ceil(vp.height)));
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFuncSeparate(gl.ONE, gl.SRC_ALPHA, gl.ZERO, gl.ONE);
      gl.useProgram(this.#program(fade ? 'fade' : false, plan.quality, plan.clouds));
      this.#bindSlot(t.view);
      this.#bind(UNITS.cube, t.cube, gl.TEXTURE_CUBE_MAP);
      this.#bind(UNITS.depth, t.depth);
      this.#bind(UNITS.cover, plan.cover !== null && this.#cover !== null ? this.#cover.texture : this.#noCover);
      gl.bindVertexArray(this.#vao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.disable(gl.BLEND);
    };
    if (plan.sky !== null || plan.nature.weather !== null) fullscreen(false);
    if (plan.bodies.length > 0) {
      this.#bindSlot(t.view);
      this.#water.draw(t, this.#vao);
    }
    if (plan.uniforms[t.view * NATURE_SLOT + VIEW_FADE_END]! > 0) fullscreen(true);
    gl.bindVertexArray(null);
    gl.useProgram(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  dispose(): void {
    const gl = this.#gl;
    for (const p of this.#programs.values()) gl.deleteProgram(p);
    for (const fb of this.#framebuffers.values()) gl.deleteFramebuffer(fb);
    gl.deleteBuffer(this.#uniforms);
    gl.deleteVertexArray(this.#vao);
    gl.deleteTexture(this.#blackCube);
    gl.deleteTexture(this.#noCover);
    if (this.#cover !== null) gl.deleteTexture(this.#cover.texture);
    this.#water.dispose();
  }
}
