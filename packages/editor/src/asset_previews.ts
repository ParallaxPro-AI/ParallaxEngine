/**
 * Thumbnails and names for the Files tab:
 *
 *   audio     a waveform: the file decoded (decodeAudioData) and its peak envelope drawn
 *   images    the image itself
 *   models    a portrait: the runtime's render3d `portrait` (capture.ts) of the model alone in
 *             a studio, read back from the GPU. Only a model the game has loaded can be drawn
 *             (one placed in the open scene, or a prefab's); the others keep their icon.
 *   names     hosted assets' catalog names, asked of `parallax edit` (`/__parallax__/asset-names`)
 *   library   the Asset Library's model pieces, before any add: the piece's model document
 *             (`/__parallax__/library-model/<id>.json`) built here and drawn by the same
 *             `portrait` (null without a 3D renderer: a 2D game keeps the icons)
 *
 * Every result is cached per reference (failures too), so re-rendering the panel or opening
 * a group again costs nothing; portraits are drawn one at a time.
 */

import { isRemoteAsset, remoteAssetUrl } from '@parallax/runtime/core';
import { buildCodeModel, parseModelDocument } from '@parallax/runtime/resource';
import type { ModelAsset } from '@parallax/runtime/resource';
import type { Editor } from './editor.js';
import { serverUrl } from './paths.js';

/** Where the browser fetches a reference: a hosted URL as is, a project file from the server. */
export function assetUrl(ref: string): string {
  if (isRemoteAsset(ref)) return remoteAssetUrl(ref) ?? ref;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(ref)) return ref;
  return serverUrl(`project/${ref.replace(/^\/+/, '')}`);
}

// ── Waveforms ─────────────────────────────────────────────────────────────────

const waves = new Map<string, Promise<string | null>>();
let audioContext: BaseAudioContext | null | undefined;

function decoder(): BaseAudioContext | null {
  if (audioContext !== undefined) return audioContext;
  try {
    // An offline context decodes without asking for the speakers (no autoplay prompt).
    const Offline = globalThis.OfflineAudioContext;
    audioContext = Offline !== undefined ? new Offline(1, 1, 44100) : null;
  } catch {
    audioContext = null;
  }
  return audioContext;
}

/** Peak envelope: the loudest |sample| per bucket, normalized (a silent clip stays flat). */
export function waveformPeaks(samples: Float32Array, buckets: number): Float32Array {
  const out = new Float32Array(buckets);
  const per = Math.max(1, Math.floor(samples.length / buckets));
  for (let b = 0; b < buckets; b++) {
    let peak = 0;
    const end = Math.min((b + 1) * per, samples.length);
    for (let i = b * per; i < end; i++) peak = Math.max(peak, Math.abs(samples[i]!));
    out[b] = peak;
  }
  let max = 0;
  for (const v of out) max = Math.max(max, v);
  if (max > 0.001) for (let i = 0; i < out.length; i++) out[i] = out[i]! / max;
  return out;
}

function drawWave(env: Float32Array, width: number, height: number): string | null {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return null;
  ctx.fillStyle = '#69bbf3';
  const bar = width / env.length;
  for (let i = 0; i < env.length; i++) {
    // At least a pixel: a quiet moment reads as a thin line, not a hole.
    const h = Math.max(1, env[i]! * (height - 2));
    ctx.fillRect(i * bar, (height - h) / 2, Math.max(bar - 0.5, 0.5), h);
  }
  return canvas.toDataURL('image/png');
}

/** An audio file's waveform as a PNG data URL (null: it can't be fetched or decoded). */
export function waveform(ref: string, width = 192, height = 96): Promise<string | null> {
  const key = `${ref}|${width}x${height}`;
  let job = waves.get(key);
  if (job === undefined) {
    job = (async () => {
      const ctx = decoder();
      if (ctx === null) return null;
      try {
        const response = await fetch(assetUrl(ref));
        if (!response.ok) return null;
        const buffer = await ctx.decodeAudioData(await response.arrayBuffer());
        return drawWave(waveformPeaks(buffer.getChannelData(0), Math.round(width / 2)), width, height);
      } catch {
        return null;
      }
    })();
    waves.set(key, job);
  }
  return job;
}

// ── Model portraits ───────────────────────────────────────────────────────────

interface PortraitEngine {
  portrait(subject: { readonly model: string } | { readonly asset: ModelAsset }, options: { width: number; height: number; yaw: number; pitch: number; background: null }): Promise<{ width: number; height: number; pixels: Uint8Array }>;
}

const portraits = new Map<string, Promise<string | null>>();
let queue: Promise<unknown> = Promise.resolve();

function engineOf(editor: Editor): PortraitEngine | undefined {
  // The running game's 3D renderer (absent in a 2D game); the session's runtime follows hot reloads.
  return (editor.session.runtime as { readonly render3d?: PortraitEngine }).render3d;
}

function toDataUrl(width: number, height: number, pixels: Uint8Array): string | null {
  // Nothing drawn (every pixel transparent): the model's files weren't ready yet.
  let drawn = false;
  for (let i = 3; i < pixels.length && !drawn; i += 4) drawn = pixels[i]! > 8;
  if (!drawn) return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return null;
  const data = new Uint8ClampedArray(width * height * 4);
  data.set(pixels.subarray(0, data.length));
  ctx.putImageData(new ImageData(data, width, height), 0, 0);
  return canvas.toDataURL('image/png');
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

function capture(engine: PortraitEngine, model: string | ModelAsset, size: number): Promise<string | null> {
  const run = async (): Promise<string | null> => {
    try {
      const shot = await engine.portrait(typeof model === 'string' ? { model } : { asset: model }, { width: size, height: size, yaw: 25, pitch: 15, background: null });
      return toDataUrl(shot.width, shot.height, shot.pixels);
    } catch {
      return null;
    }
  };
  // One at a time: each is a draw and a GPU read-back.
  const job = queue.then(run, run);
  queue = job;
  return job;
}

/**
 * A model's portrait as a PNG data URL, or null (no 3D renderer, or the model isn't loaded).
 * The first capture asks for the model's textures; one taken before they arrive draws blank
 * and is retried a few times. A failure is forgotten, so a model placed later gets its turn.
 */
export function portrait(editor: Editor, model: string, size = 128): Promise<string | null> {
  const key = `${model}|${size}`;
  let job = portraits.get(key);
  if (job === undefined) {
    const engine = engineOf(editor);
    if (engine === undefined) return Promise.resolve(null);
    job = (async () => {
      for (let attempt = 0; attempt < 4; attempt++) {
        if (attempt > 0) await sleep(700 * attempt);
        const url = await capture(engine, model, size);
        if (url !== null) return url;
      }
      return null;
    })();
    portraits.set(key, job);
    void job.then((url) => { if (url === null) portraits.delete(key); });
  }
  return job;
}

/**
 * The same portrait again once the model's textures have had time to load (the first one may
 * show it untextured): taken a moment after the first, cached, null when that failed.
 */
export function settledPortrait(editor: Editor, model: string, size = 128): Promise<string | null> {
  const key = `${model}|${size}|settled`;
  let job = portraits.get(key);
  if (job === undefined) {
    const engine = engineOf(editor);
    if (engine === undefined) return Promise.resolve(null);
    job = portrait(editor, model, size).then(async (first) => {
      if (first === null) return null;
      await sleep(1500);
      return await capture(engine, model, size) ?? first;
    });
    portraits.set(key, job);
  }
  return job;
}

// ── Library model portraits ───────────────────────────────────────────────────

/** Where the Asset Library's model piece `id` serves its model document. */
export function libraryModelUrl(id: string): string {
  return serverUrl(`/__parallax__/library-model/${encodeURIComponent(id)}.json`);
}

/** A library model document's text, built as the runtime builds a project's (null: it has errors). */
export function buildLibraryModel(id: string, text: string): ModelAsset | null {
  const parsed = parseModelDocument(`assets/models/${id}.model.json`, text);
  if (parsed.document === undefined || parsed.diagnostics.some((d) => d.severity === 'error')) return null;
  return buildCodeModel(parsed.document);
}

/** Piece `id`'s model, fetched and built (null: no such model, or it can't be read). Not kept: only its portraits are. */
async function libraryModel(id: string): Promise<ModelAsset | null> {
  try {
    const response = await fetch(libraryModelUrl(id), { headers: { Accept: 'application/json' } });
    return response.ok ? buildLibraryModel(id, await response.text()) : null;
  } catch {
    return null;
  }
}

/**
 * The portrait of the Asset Library's model piece `id` (not in the project yet) as a PNG data
 * URL, or null: no 3D renderer (nothing is fetched then), no model document, or nothing drawn.
 * Cached per piece and size; a null is forgotten so a later draw tries again.
 */
export function libraryPortrait(editor: Editor, id: string, size = 128): Promise<string | null> {
  const key = `library:${id}|${size}`;
  let job = portraits.get(key);
  if (job === undefined) {
    if (engineOf(editor) === undefined) return Promise.resolve(null);
    job = libraryModel(id).then(async (model) => {
      if (model === null) return null;
      // As `portrait`: a capture before its materials are ready draws blank, so a few tries.
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) await sleep(500 * attempt);
        // The renderer of the moment: a hot reload may have replaced the one asked first.
        const engine = engineOf(editor);
        if (engine === undefined) return null;
        const url = await capture(engine, model, size);
        if (url !== null) return url;
      }
      return null;
    });
    portraits.set(key, job);
    void job.then((url) => { if (url === null) portraits.delete(key); });
  }
  return job;
}

/** The model a prefab draws (its first `model` component's file), if any. */
export function prefabModel(editor: Editor, path: string): string | undefined {
  let doc: unknown;
  try {
    doc = editor.documents.json(path);
  } catch {
    return undefined;
  }
  const visit = (node: unknown): string | undefined => {
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = visit(item);
        if (found !== undefined) return found;
      }
      return undefined;
    }
    if (typeof node !== 'object' || node === null) return undefined;
    const model = (node as { components?: { model?: { model?: unknown } } }).components?.model?.model;
    if (typeof model === 'string') return model;
    for (const value of Object.values(node)) {
      const found = visit(value);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return visit(doc);
}

// ── Catalog names ─────────────────────────────────────────────────────────────

const names = new Map<string, string | null>();
let asking: Promise<void> | undefined;

/**
 * The catalog names of hosted assets, learned from `parallax edit` (which asks the asset
 * store). Resolves with whether anything new was learned; a page served elsewhere learns none.
 */
export async function learnNames(refs: readonly string[]): Promise<boolean> {
  const wanted = [...new Set(refs.filter((r) => isRemoteAsset(r) && !names.has(r)))];
  if (wanted.length === 0) return false;
  await asking;
  for (const ref of wanted) names.set(ref, null);
  let learned = false;
  asking = (async () => {
    try {
      const response = await fetch(serverUrl('/__parallax__/asset-names'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths: wanted }),
      });
      if (!response.ok) return;
      const body = await response.json() as { names?: Record<string, string> };
      for (const [ref, name] of Object.entries(body.names ?? {})) {
        // Some catalog entries are named by their hash: the derived name says more.
        if (/^[0-9a-f]{16,}$/i.test(name.trim())) continue;
        names.set(ref, name);
        learned = true;
      }
    } catch {
      // Offline: the derived names stay.
    }
  })();
  await asking;
  return learned;
}

/** The catalog's name for a hosted asset, once learned. */
export function catalogName(ref: string): string | undefined {
  return names.get(ref) ?? undefined;
}
