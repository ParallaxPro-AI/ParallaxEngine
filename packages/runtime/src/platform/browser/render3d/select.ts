/**
 * Choosing the GPU API at startup: WebGPU when `navigator.gpu` gives an adapter, a device
 * and a canvas context; otherwise WebGL2; otherwise PP9807. Nothing is created on the
 * canvas until WebGPU has an adapter and a device, so a failed WebGPU attempt leaves the
 * canvas free for WebGL2.
 */

import { fail } from '../../../core/index.js';
import type { BackendKind, GpuCanvasContext, GpuDevice, GpuLike } from './backend.js';

/** The canvas calls selection makes. */
export interface BackendCanvas {
  getContext(kind: 'webgpu'): unknown;
  getContext(kind: 'webgl2', attributes: WebGLContextAttributes): unknown;
}

export interface BackendEnvironment {
  /** `navigator.gpu`, or undefined where the browser has no WebGPU. */
  readonly gpu: GpuLike | undefined;
  readonly canvas: BackendCanvas;
  /** Force one API (debugging, `?renderer=webgl2`); default: WebGPU first. */
  readonly prefer?: BackendKind;
}

export type Selection =
  | { readonly kind: 'webgpu'; readonly device: GpuDevice; readonly context: GpuCanvasContext; readonly format: string; readonly fallbackReason: null }
  | { readonly kind: 'webgl2'; readonly gl: WebGL2RenderingContext; readonly fallbackReason: string | null };

/** The canvas only receives the present pass: every scene target is an offscreen texture (no MSAA, no depth here). */
export const WEBGL2_ATTRIBUTES: WebGLContextAttributes = {
  alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, powerPreference: 'high-performance',
};

/** WebGPU features render3d asks for when the adapter has them. */
export const COMPRESSION_FEATURES = ['texture-compression-bc', 'texture-compression-etc2', 'texture-compression-astc'] as const;

/** Why WebGPU wasn't used, or the WebGPU objects to draw with. */
async function tryWebGpu(env: BackendEnvironment): Promise<Selection | string> {
  if (env.gpu === undefined) return 'this browser has no WebGPU (navigator.gpu)';
  let adapter;
  try {
    adapter = await env.gpu.requestAdapter({ powerPreference: 'high-performance' });
  } catch (error) {
    return `requestAdapter failed (${String((error as Error)?.message ?? error)})`;
  }
  if (adapter === null) return 'no WebGPU adapter is available';
  let device: GpuDevice;
  try {
    // Texture compression families the adapter has: KTX2 variants upload as is (ktx2.ts).
    const requiredFeatures = COMPRESSION_FEATURES.filter((f) => adapter.features?.has(f) === true);
    device = await adapter.requestDevice(requiredFeatures.length > 0 ? { requiredFeatures } : undefined);
  } catch (error) {
    return `requestDevice failed (${String((error as Error)?.message ?? error)})`;
  }
  const context = env.canvas.getContext('webgpu') as GpuCanvasContext | null;
  if (context === null) {
    device.destroy();
    return 'the canvas has no WebGPU context';
  }
  return { kind: 'webgpu', device, context, format: env.gpu.getPreferredCanvasFormat(), fallbackReason: null };
}

export async function selectBackend(env: BackendEnvironment): Promise<Selection> {
  let reason: string | null = null;
  if (env.prefer !== 'webgl2') {
    const webgpu = await tryWebGpu(env);
    if (typeof webgpu !== 'string') return webgpu;
    reason = webgpu;
    if (env.prefer === 'webgpu') {
      fail('PP9807', `WebGPU was asked for, but ${reason}`, { fix: 'Drop the renderer preference to fall back to WebGL2.' });
    }
  }
  const gl = env.canvas.getContext('webgl2', WEBGL2_ATTRIBUTES) as WebGL2RenderingContext | null;
  if (gl === null) {
    return fail('PP9807', `This browser can draw neither WebGPU${reason === null ? '' : ` (${reason})`} nor WebGL2`, {
      fix: 'Use a current Chrome, Edge, Firefox or Safari, with hardware acceleration enabled.',
    });
  }
  return { kind: 'webgl2', gl, fallbackReason: reason };
}
