/**
 * What the WebGL2 outdoor passes share (sky_webgl2.ts, water_webgl2.ts): their uniform
 * binding points and texture units, what a view's pass draws into, and linking a program
 * with its blocks and samplers bound to them.
 */

import { fail } from '../../../core/index.js';
import type { NaturePlan } from './sky_plan.js';

type GL = WebGL2RenderingContext;

/** Uniform binding points and texture units this code uses. */
export const NATURE_BLOCK = 5;
export const WATER_BLOCK = 6;
export const UNITS = { cube: 6, depth: 7, cover: 8, sceneCopy: 9, depthCopy: 10 } as const;

export interface NatureTargetsGl {
  readonly plan: NaturePlan;
  readonly view: number;
  readonly viewport: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly color: WebGLTexture;
  readonly depth: WebGLTexture;
  readonly cube: WebGLTexture;
  readonly width: number;
  readonly height: number;
}

/** Compile and link a program, binding its blocks and samplers to our points and units. */
export function linkNature(gl: GL, key: string, source: { vertex: string; fragment: string }, samplers: Readonly<Record<string, number>>): WebGLProgram {
  const shader = (type: number, text: string): WebGLShader => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, text);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      fail('PP9813', `render3d's ${key} shader didn't compile: ${gl.getShaderInfoLog(s) ?? ''}`, { fix: 'This is an engine bug; report it with the browser and GPU.' });
    }
    return s;
  };
  const program = gl.createProgram()!;
  gl.attachShader(program, shader(gl.VERTEX_SHADER, source.vertex));
  gl.attachShader(program, shader(gl.FRAGMENT_SHADER, source.fragment));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    fail('PP9813', `render3d's ${key} program didn't link: ${gl.getProgramInfoLog(program) ?? ''}`, { fix: 'This is an engine bug; report it with the browser and GPU.' });
  }
  const nature = gl.getUniformBlockIndex(program, 'Nature');
  if (nature !== gl.INVALID_INDEX) gl.uniformBlockBinding(program, nature, NATURE_BLOCK);
  const water = gl.getUniformBlockIndex(program, 'Water');
  if (water !== gl.INVALID_INDEX) gl.uniformBlockBinding(program, water, WATER_BLOCK);
  gl.useProgram(program);
  for (const [name, unit] of Object.entries(samplers)) {
    const at = gl.getUniformLocation(program, name);
    if (at !== null) gl.uniform1i(at, unit);
  }
  gl.useProgram(null);
  return program;
}

