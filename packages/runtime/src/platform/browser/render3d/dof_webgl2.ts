/**
 * Depth of field on WebGL2 — the same two passes as dof_webgpu.ts: copy the view's HDR
 * rectangle into the pass's own texture, then blur it back into the HDR color. Sets the GL
 * state it needs (the backend sets its own before each of its passes).
 */

import { fail } from '../../../core/index.js';
import { GLSL_DOF_COPY, glslDof } from './dof.js';
import type { DofPlan } from './dof.js';

type GL = WebGL2RenderingContext;

/** Texture units the passes sample on (post units: every backend pass binds its own). */
const COLOR_UNIT = 7;
const DEPTH_UNIT = 11;

export interface DofTargetsGl {
  readonly plan: DofPlan;
  readonly viewport: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly color: WebGLTexture;
  readonly depth: WebGLTexture;
  readonly width: number;
  readonly height: number;
}

interface Program {
  readonly program: WebGLProgram;
  readonly at: Readonly<Record<string, WebGLUniformLocation | null>>;
}

const UNIFORMS = ['inverseViewProjection', 'eye', 'forward', 'viewport', 'targetSize', 'params'] as const;

export class DofWebGl2 {
  readonly #gl: GL;
  readonly #programs = new Map<string, Program>();
  readonly #vao: WebGLVertexArrayObject;
  /** Framebuffers over the HDR textures the pass writes back into, by texture. */
  readonly #framebuffers = new Map<WebGLTexture, WebGLFramebuffer>();
  #copy: { width: number; height: number; texture: WebGLTexture; framebuffer: WebGLFramebuffer } | null = null;

  constructor(gl: GL) {
    this.#gl = gl;
    this.#vao = gl.createVertexArray()!;
  }

  #program(kind: 'copy' | number): Program {
    const key = String(kind);
    let p = this.#programs.get(key);
    if (p !== undefined) return p;
    const gl = this.#gl;
    const source = kind === 'copy' ? GLSL_DOF_COPY : glslDof(kind);
    const shader = (type: number, text: string): WebGLShader => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, text);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        fail('PP9813', `render3d's depth of field shader didn't compile: ${gl.getShaderInfoLog(s) ?? ''}`, { fix: 'This is an engine bug; report it with the browser and GPU.' });
      }
      return s;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, shader(gl.VERTEX_SHADER, source.vertex));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, source.fragment));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      fail('PP9813', `render3d's depth of field program didn't link: ${gl.getProgramInfoLog(program) ?? ''}`, { fix: 'This is an engine bug; report it with the browser and GPU.' });
    }
    gl.useProgram(program);
    const sampler = (name: string, unit: number): void => {
      const at = gl.getUniformLocation(program, name);
      if (at !== null) gl.uniform1i(at, unit);
    };
    sampler('source', COLOR_UNIT);
    sampler('colorTexture', COLOR_UNIT);
    sampler('depthTexture', DEPTH_UNIT);
    const at = Object.fromEntries(UNIFORMS.map((n) => [n, gl.getUniformLocation(program, n)]));
    p = { program, at };
    this.#programs.set(key, p);
    return p;
  }

  #copyFor(width: number, height: number): { texture: WebGLTexture; framebuffer: WebGLFramebuffer } {
    const gl = this.#gl;
    const c = this.#copy;
    if (c !== null && c.width === width && c.height === height) return c;
    if (c !== null) { gl.deleteTexture(c.texture); gl.deleteFramebuffer(c.framebuffer); }
    // A new size: the backend made new HDR targets too, so the old framebuffers over them go.
    for (const fb of this.#framebuffers.values()) gl.deleteFramebuffer(fb);
    this.#framebuffers.clear();
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, width, height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.#copy = { width, height, texture, framebuffer: this.#framebufferOf(texture) };
    return this.#copy;
  }

  #framebufferOf(texture: WebGLTexture): WebGLFramebuffer {
    const gl = this.#gl;
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    return fb;
  }

  #into(texture: WebGLTexture): WebGLFramebuffer {
    let fb = this.#framebuffers.get(texture);
    if (fb === undefined) {
      fb = this.#framebufferOf(texture);
      this.#framebuffers.set(texture, fb);
    }
    return fb;
  }

  draw(t: DofTargetsGl): void {
    const gl = this.#gl;
    const vp = t.viewport;
    const area = (): void => {
      const y = t.height - vp.y - vp.height;
      gl.viewport(vp.x, y, vp.width, vp.height);
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(Math.floor(vp.x), Math.floor(y), Math.max(1, Math.ceil(vp.width)), Math.max(1, Math.ceil(vp.height)));
    };
    const bind = (unit: number, texture: WebGLTexture): void => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, texture);
    };
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.colorMask(true, true, true, true);
    gl.bindVertexArray(this.#vao);

    // 1. The view's rectangle into the copy (the HDR color is never sampled while drawn into).
    const copy = this.#copyFor(t.width, t.height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, copy.framebuffer);
    area();
    gl.useProgram(this.#program('copy').program);
    bind(COLOR_UNIT, t.color);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // 2. Blurred back into the HDR color.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.#into(t.color));
    area();
    const p = this.#program(t.plan.samples);
    gl.useProgram(p.program);
    const u = t.plan.uniforms;
    gl.uniformMatrix4fv(p.at['inverseViewProjection']!, false, u.subarray(0, 16));
    UNIFORMS.slice(1).forEach((name, i) => gl.uniform4fv(p.at[name]!, u.subarray(16 + i * 4, 20 + i * 4)));
    bind(COLOR_UNIT, copy.texture);
    bind(DEPTH_UNIT, t.depth);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  dispose(): void {
    const gl = this.#gl;
    for (const p of this.#programs.values()) gl.deleteProgram(p.program);
    this.#programs.clear();
    for (const fb of this.#framebuffers.values()) gl.deleteFramebuffer(fb);
    this.#framebuffers.clear();
    if (this.#copy !== null) { gl.deleteTexture(this.#copy.texture); gl.deleteFramebuffer(this.#copy.framebuffer); }
    this.#copy = null;
    gl.deleteVertexArray(this.#vao);
  }
}
