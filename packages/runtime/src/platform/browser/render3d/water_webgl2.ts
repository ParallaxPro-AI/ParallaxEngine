/**
 * Water on WebGL2 — the same passes as water_webgpu.ts: copy the scene (color, and depth
 * packed into RGBA8), the underwater view, then the surfaces with depth test and write.
 * Called by NatureWebGl2 with the view's nature slot bound at NATURE_BLOCK.
 */

import type { Geometry3d } from '../../../core/index.js';
import { linkNature, UNITS, WATER_BLOCK } from './sky_webgl2_link.js';
import type { NatureTargetsGl } from './sky_webgl2_link.js';
import { NATURE_FIELDS, NATURE_SLOT, WATER_BLOCK_FLOATS } from './sky_plan.js';
import type { NaturePlan } from './sky_plan.js';
import { offsetOf } from './layout.js';
import { GLSL_WATER_COPY, glslSurface, glslUnderwater } from './water_shaders.js';
import { gridMesh } from './water_webgpu.js';

type GL = WebGL2RenderingContext;

interface Copies {
  readonly width: number;
  readonly height: number;
  readonly color: WebGLTexture;
  readonly depth: WebGLTexture;
  readonly framebuffer: WebGLFramebuffer;
}

interface Ribbon {
  readonly vao: WebGLVertexArrayObject;
  readonly buffers: WebGLBuffer[];
  readonly count: number;
  used: boolean;
}

export class WaterWebGl2 {
  readonly #gl: GL;
  readonly #programs = new Map<string, WebGLProgram>();
  readonly #water: WebGLBuffer;
  readonly #grid: { vao: WebGLVertexArrayObject; buffers: WebGLBuffer[]; count: number };
  readonly #ribbons = new Map<string, Ribbon>();
  #copies: Copies | null = null;
  #surfaceTarget: { color: WebGLTexture; depth: WebGLTexture; framebuffer: WebGLFramebuffer } | null = null;
  #underTarget: { color: WebGLTexture; framebuffer: WebGLFramebuffer } | null = null;
  #uploaded: NaturePlan | null = null;

  constructor(gl: GL) {
    this.#gl = gl;
    this.#water = gl.createBuffer()!;
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.#water);
    gl.bufferData(gl.UNIFORM_BUFFER, WATER_BLOCK_FLOATS * 4, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.UNIFORM_BUFFER, null);
    const grid = gridMesh();
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const vertices = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vertices);
    gl.bufferData(gl.ARRAY_BUFFER, grid.vertices, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
    const indices = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indices);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, grid.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this.#grid = { vao, buffers: [vertices, indices], count: grid.indices.length };
  }

  #program(kind: 'copy' | 'under' | 'grid' | 'ribbon'): WebGLProgram {
    let p = this.#programs.get(kind);
    if (p === undefined) {
      const source = kind === 'copy' ? GLSL_WATER_COPY : kind === 'under' ? glslUnderwater() : glslSurface(kind === 'ribbon');
      const samplers: Readonly<Record<string, number>> = kind === 'copy'
        ? { color: UNITS.sceneCopy, depth: UNITS.depth }
        : { sceneCopy: UNITS.sceneCopy, depthCopy: UNITS.depthCopy, envCube: UNITS.cube };
      p = linkNature(this.#gl, `water ${kind}`, source, samplers);
      this.#programs.set(kind, p);
    }
    return p;
  }

  #texture(width: number, height: number, internal: number): WebGLTexture {
    const gl = this.#gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, internal, width, height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return t;
  }

  #framebuffer(colors: readonly WebGLTexture[], depth: WebGLTexture | null): WebGLFramebuffer {
    const gl = this.#gl;
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    colors.forEach((c, i) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, c, 0));
    if (depth !== null) gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depth, 0);
    return fb;
  }

  #copiesFor(width: number, height: number): Copies {
    const gl = this.#gl;
    const c = this.#copies;
    if (c !== null && c.width === width && c.height === height) return c;
    if (c !== null) {
      gl.deleteTexture(c.color);
      gl.deleteTexture(c.depth);
      gl.deleteFramebuffer(c.framebuffer);
    }
    const color = this.#texture(width, height, gl.RGBA16F);
    const depth = this.#texture(width, height, gl.RGBA8);
    this.#copies = { width, height, color, depth, framebuffer: this.#framebuffer([color, depth], null) };
    return this.#copies;
  }

  #ribbon(g: Geometry3d): Ribbon {
    const gl = this.#gl;
    let r = this.#ribbons.get(g.id);
    if (r === undefined) {
      const vao = gl.createVertexArray()!;
      gl.bindVertexArray(vao);
      const attribute = (location: number, data: Float32Array, size: number): WebGLBuffer => {
        const b = gl.createBuffer()!;
        gl.bindBuffer(gl.ARRAY_BUFFER, b);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(location);
        gl.vertexAttribPointer(location, size, gl.FLOAT, false, size * 4, 0);
        return b;
      };
      const position = attribute(0, g.positions, 3);
      const flow = attribute(1, g.colors!, 4);
      const index = gl.createBuffer()!;
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, index);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, g.indices instanceof Uint32Array ? g.indices : Uint32Array.from(g.indices), gl.STATIC_DRAW);
      gl.bindVertexArray(null);
      r = { vao, buffers: [position, flow, index], count: g.indices.length, used: true };
      this.#ribbons.set(g.id, r);
    }
    r.used = true;
    return r;
  }

  #bind(unit: number, texture: WebGLTexture, target: number = this.#gl.TEXTURE_2D): void {
    this.#gl.activeTexture(this.#gl.TEXTURE0 + unit);
    this.#gl.bindTexture(target, texture);
  }

  draw(t: NatureTargetsGl, fullscreen: WebGLVertexArrayObject): void {
    const gl = this.#gl;
    const plan = t.plan;
    if (this.#uploaded !== plan) {
      gl.bindBuffer(gl.UNIFORM_BUFFER, this.#water);
      gl.bufferSubData(gl.UNIFORM_BUFFER, 0, plan.waterBlock);
      gl.bindBuffer(gl.UNIFORM_BUFFER, null);
      for (const r of this.#ribbons.values()) r.used = false;
      this.#uploaded = plan;
    }
    gl.bindBufferBase(gl.UNIFORM_BUFFER, WATER_BLOCK, this.#water);
    const vp = t.viewport;
    const y = t.height - vp.y - vp.height;
    const area = (): void => {
      gl.viewport(vp.x, y, vp.width, vp.height);
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(Math.floor(vp.x), Math.floor(y), Math.max(1, Math.ceil(vp.width)), Math.max(1, Math.ceil(vp.height)));
    };
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.DEPTH_TEST);

    // 1. Copy the scene and its depth.
    const copies = this.#copiesFor(t.width, t.height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, copies.framebuffer);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    area();
    gl.useProgram(this.#program('copy'));
    this.#bind(UNITS.sceneCopy, t.color);
    this.#bind(UNITS.depth, t.depth);
    gl.bindVertexArray(fullscreen);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.#bind(UNITS.sceneCopy, copies.color);
    this.#bind(UNITS.depthCopy, copies.depth);
    this.#bind(UNITS.cube, t.cube, gl.TEXTURE_CUBE_MAP);

    // 2. Under the surface: everything through water.
    if (plan.uniforms[t.view * NATURE_SLOT + offsetOf(NATURE_FIELDS, 'waterAt')]! >= 0) {
      if (this.#underTarget?.color !== t.color) {
        if (this.#underTarget !== null) gl.deleteFramebuffer(this.#underTarget.framebuffer);
        this.#underTarget = { color: t.color, framebuffer: this.#framebuffer([t.color], null) };
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.#underTarget.framebuffer);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
      area();
      gl.useProgram(this.#program('under'));
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    // 3. The surfaces.
    if (this.#surfaceTarget?.color !== t.color || this.#surfaceTarget.depth !== t.depth) {
      if (this.#surfaceTarget !== null) gl.deleteFramebuffer(this.#surfaceTarget.framebuffer);
      this.#surfaceTarget = { color: t.color, depth: t.depth, framebuffer: this.#framebuffer([t.color], t.depth) };
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.#surfaceTarget.framebuffer);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    area();
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    plan.bodies.forEach((body, i) => {
      const ribbon = body.ribbon !== null;
      const program = this.#program(ribbon ? 'ribbon' : 'grid');
      gl.useProgram(program);
      gl.uniform1i(gl.getUniformLocation(program, 'uBody'), i);
      if (ribbon) {
        const r = this.#ribbon(body.ribbon!);
        gl.bindVertexArray(r.vao);
        gl.drawElements(gl.TRIANGLES, r.count, gl.UNSIGNED_INT, 0);
      } else {
        gl.bindVertexArray(this.#grid.vao);
        gl.drawElements(gl.TRIANGLES, this.#grid.count, gl.UNSIGNED_INT, 0);
      }
    });
    gl.disable(gl.DEPTH_TEST);
    if (t.view === plan.views - 1) {
      for (const [id, r] of this.#ribbons) {
        if (r.used) continue;
        gl.deleteVertexArray(r.vao);
        for (const b of r.buffers) gl.deleteBuffer(b);
        this.#ribbons.delete(id);
      }
    }
  }

  dispose(): void {
    const gl = this.#gl;
    for (const p of this.#programs.values()) gl.deleteProgram(p);
    gl.deleteBuffer(this.#water);
    gl.deleteVertexArray(this.#grid.vao);
    for (const b of this.#grid.buffers) gl.deleteBuffer(b);
    for (const r of this.#ribbons.values()) {
      gl.deleteVertexArray(r.vao);
      for (const b of r.buffers) gl.deleteBuffer(b);
    }
    if (this.#copies !== null) {
      gl.deleteTexture(this.#copies.color);
      gl.deleteTexture(this.#copies.depth);
      gl.deleteFramebuffer(this.#copies.framebuffer);
    }
    if (this.#surfaceTarget !== null) gl.deleteFramebuffer(this.#surfaceTarget.framebuffer);
    if (this.#underTarget !== null) gl.deleteFramebuffer(this.#underTarget.framebuffer);
  }
}
