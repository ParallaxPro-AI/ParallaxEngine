/**
 * Effect particles and ribbons on WebGL2 (vfx.ts). The backend binds a color-only
 * framebuffer over the HDR target, the view's viewport and its frame block; the scene's
 * depth is sampled (a texture can't be attached and sampled at once), so there is no depth
 * test here — the shaders drop what the scene hides.
 */

import { GLSL_UNITS } from './shaders.js';
import { glslParticles, glslRibbons, RIBBON_VERTEX_FLOATS, VFX_INSTANCE_FLOATS } from './vfx.js';
import type { VfxPlan } from './vfx.js';

type GL = WebGL2RenderingContext;

export interface VfxDrawGl {
  readonly plan: VfxPlan;
  readonly depth: WebGLTexture;
  /** A batch's image (null: white). */
  readonly image: (texture: VfxPlan['particles'][number]['texture']) => WebGLTexture;
}

export class VfxWebGl2 {
  readonly #gl: GL;
  readonly #link: (key: string, source: { vertex: string; fragment: string }) => WebGLProgram;
  readonly #instances: WebGLBuffer;
  readonly #ribbons: WebGLBuffer;
  readonly #vao: WebGLVertexArrayObject;
  #uploaded: VfxPlan | null = null;

  constructor(gl: GL, link: (key: string, source: { vertex: string; fragment: string }) => WebGLProgram) {
    this.#gl = gl;
    this.#link = link;
    this.#instances = gl.createBuffer()!;
    this.#ribbons = gl.createBuffer()!;
    this.#vao = gl.createVertexArray()!;
  }

  draw(d: VfxDrawGl): void {
    const gl = this.#gl;
    const plan = d.plan;
    if (this.#uploaded !== plan) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.#instances);
      gl.bufferData(gl.ARRAY_BUFFER, plan.instances, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.#ribbons);
      gl.bufferData(gl.ARRAY_BUFFER, plan.ribbonVertices, gl.DYNAMIC_DRAW);
      this.#uploaded = plan;
    }
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0 + GLSL_UNITS.depthTexture);
    gl.bindTexture(gl.TEXTURE_2D, d.depth);
    gl.bindVertexArray(this.#vao);
    for (const blend of ['alpha', 'additive'] as const) {
      const additive = blend === 'additive';
      if (additive) gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ZERO, gl.ONE);
      else gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      const items = plan.particles.filter((p) => p.blend === blend);
      if (items.length > 0) {
        gl.useProgram(this.#link(`vfx-particles|${blend}`, glslParticles(additive)));
        for (const item of items) {
          gl.activeTexture(gl.TEXTURE0 + GLSL_UNITS.image);
          gl.bindTexture(gl.TEXTURE_2D, d.image(item.texture));
          this.#records(this.#instances, VFX_INSTANCE_FLOATS, 5, item.first, 1);
          gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, item.count);
        }
      }
      const range = plan.ribbons[blend];
      if (range.count > 0) {
        gl.useProgram(this.#link(`vfx-ribbons|${blend}`, glslRibbons(additive)));
        this.#records(this.#ribbons, RIBBON_VERTEX_FLOATS, 4, 0, 0);
        gl.drawArrays(gl.TRIANGLES, range.first, range.count);
      }
    }
    gl.bindVertexArray(null);
    gl.depthMask(true);
  }

  dispose(): void {
    const gl = this.#gl;
    gl.deleteBuffer(this.#instances);
    gl.deleteBuffer(this.#ribbons);
    gl.deleteVertexArray(this.#vao);
  }

  /** Point attributes 0..count-1 at consecutive vec4s of `floats`-float records, from record `first`. */
  #records(buffer: WebGLBuffer, floats: number, count: number, first: number, divisor: number): void {
    const gl = this.#gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    for (let i = 0; i < 5; i++) {
      if (i >= count) {
        gl.disableVertexAttribArray(i);
        continue;
      }
      gl.enableVertexAttribArray(i);
      gl.vertexAttribPointer(i, 4, gl.FLOAT, false, floats * 4, first * floats * 4 + i * 16);
      gl.vertexAttribDivisor(i, divisor);
    }
  }
}
