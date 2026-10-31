/** Physics data checks over real examples (read-only): auto_runner (physics2d) and the FPS (physics3d). */

import { beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { Diagnostic } from '@parallax/runtime/core';
import { checkFiles } from './check.js';
import type { Declarations } from './declarations.js';
import { runExtract } from './extract.js';
import { directoryFiles, memoryFiles } from './files.js';

interface Example {
  files: Record<string, string>;
  declarations: Declarations;
}

function load(name: string): Example {
  const dir = fileURLToPath(new URL(`../../../examples/${name}`, import.meta.url));
  const tree = directoryFiles(dir);
  const files: Record<string, string> = {};
  for (const path of tree.all()) if (!/\.(png|glb|ogg|mp3|wav)$/.test(path)) files[path] = tree.read(path);
  const extracted = runExtract(dir);
  if (!extracted.ok) throw new Error(extracted.diagnostic.message);
  return { files, declarations: extracted.declarations };
}

let runner2d: Example;
let fps: Example;

beforeAll(() => {
  runner2d = load('auto_runner');
  fps = load('fps_shooter');
});

function codes(example: Example, prefab: string, components: Record<string, unknown>): string[] {
  const path = `prefabs/${prefab}.prefab.json`;
  const doc = JSON.parse(example.files[path]!) as { components: Record<string, unknown> };
  Object.assign(doc.components, components);
  const found: readonly Diagnostic[] = checkFiles(memoryFiles({ ...example.files, [path]: JSON.stringify(doc) }), example.declarations, { assetFiles: false }).diagnostics;
  return found.filter((d) => /^PP31[89]/.test(d.code)).map((d) => `${d.code} ${d.pointer ?? ''}`);
}

describe('physics checks', () => {
  it('accepts well-formed joints in both dimensions', () => {
    expect(codes(runner2d, 'runner', { joint: { kind: 'hinge', limits: [-30, 30], motor_speed: 90 } })).toEqual([]);
    expect(codes(fps, 'crate', { joint: { kind: 'ball' } })).toEqual([]);
  });

  it('refuses 3D-only data in a 2D game, backwards limits and motors on joints that have nothing to drive', () => {
    expect(codes(runner2d, 'runner', { joint: { kind: 'ball' }, ragdoll: {} })).toEqual(['PP3187 /components/joint/kind', 'PP3194 /components/ragdoll']);
    expect(codes(fps, 'crate', { joint: { kind: 'hinge', limits: [10, -10] } })).toEqual(['PP3185 /components/joint/limits']);
    expect(codes(fps, 'crate', { joint: { kind: 'rope', limits: [0, 1], motor_speed: 3 } })).toEqual(['PP3186 /components/joint', 'PP3185 /components/joint/limits']);
  });

  it('points a placement\'s finding at its components (/entities/N/components/<component>)', () => {
    const path = 'scenes/zz_test/scene.json';
    const scene = { entities: [{ prefab: 'crate', components: { joint: { kind: 'hinge', limits: [10, -10] } } }] };
    const found = checkFiles(memoryFiles({ ...fps.files, [path]: JSON.stringify(scene) }), fps.declarations, { assetFiles: false }).diagnostics;
    expect(found.filter((d) => d.code === 'PP3185').map((d) => `${d.path} ${d.pointer}`)).toEqual([`${path} /entities/0/components/joint/limits`]);
  });
});
