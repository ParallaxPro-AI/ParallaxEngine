/**
 * `parallax build --bundle` over a copy of the fixture with a sound, a music track and a
 * model added: what it packs, that the runtime's reader gets every byte back (eager and by
 * range), that the same project packs to the same names, stale-bundle recovery, and a
 * headless boot from the bundles.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { directoryFiles } from '@parallax/check';
import { BundleReader } from '@parallax/runtime/resource';
import { MemoryBundles } from '@parallax/runtime/platform';
import { buildProject } from './build.js';
import type { BuildResult } from './build.js';
import { loadGame } from './bundle.js';
import { packProject } from './pack.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/drop', import.meta.url));
let root: string;
let project: string;
let build: BuildResult;

const bytes = (n: number, seed: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed * 7) & 255);
const EXTRA: Record<string, Uint8Array> = {
  'assets/sfx/thud.ogg': bytes(3000, 1),
  'assets/music/theme.ogg': bytes(9000, 2),
  'assets/models/crate.bin': new Uint8Array(4096),
};

function bundleFiles(dir: string): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const walk = (rel: string): void => {
    for (const entry of readdirSync(`${dir}/${rel}`, { withFileTypes: true })) {
      const path = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(path); else out.set(path, readFileSync(`${dir}/${path}`));
    }
  };
  walk('');
  return out;
}

beforeAll(() => {
  root = mkdtempSync(`${tmpdir()}/parallax-pack-`);
  project = `${root}/project`;
  const tree = directoryFiles(FIXTURE);
  for (const path of tree.all()) {
    mkdirSync(`${project}/${path.split('/').slice(0, -1).join('/')}`, { recursive: true });
    writeFileSync(`${project}/${path}`, tree.bytes(path));
  }
  for (const [path, data] of Object.entries(EXTRA)) {
    mkdirSync(`${project}/${path.split('/').slice(0, -1).join('/')}`, { recursive: true });
    writeFileSync(`${project}/${path}`, data);
  }
  build = buildProject(project, { bundle: true, assetFiles: false });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('packProject', () => {
  it('packs data and images eagerly, models and sounds lazily, music loose; never Python or tests', () => {
    expect(build.errors).toBe(0);
    const pack = build.bundles!;
    expect(pack.groups.map((g) => [g.group, g.files, pack.index.bundles[g.group]!.eager])).toEqual([
      ['data', 4, true], ['images', 1, true], ['models', 1, false], ['sfx', 1, false],
    ]);
    const paths = Object.keys(pack.index.files);
    expect(paths.some((p) => p.endsWith('.py') || p.startsWith('tests/') || p.startsWith('build/'))).toBe(false);
    expect(pack.index.files['assets/music/theme.ogg']).toMatchObject({ url: expect.stringMatching(/^assets\/music\/[0-9a-f]{64}\.ogg$/) });
    // The zeroed model compresses; already-compressed kinds (ogg, png) are stored as they are.
    expect(pack.index.files['assets/models/crate.bin']).toMatchObject({ encoding: 'gzip' });
    expect(pack.index.files['assets/sfx/thud.ogg']).toMatchObject({ encoding: 'identity' });
    const models = pack.groups.find((g) => g.group === 'models')!;
    expect(models.packed).toBeLessThan(models.raw / 10);
  });

  it('packs the same project to the same bytes and names', () => {
    const again = packProject(project, `${root}/again`);
    expect(again.index).toEqual(build.bundles!.index);
    for (const g of again.groups) expect(readFileSync(`${root}/again/${g.file}`)).toEqual(readFileSync(`${build.buildDir}/bundles/${g.file}`));
  });

  it('reads every file back through the runtime reader: eager with progress, lazy by one range each', async () => {
    const transport = new MemoryBundles(bundleFiles(`${build.buildDir}/bundles`));
    const reader = await BundleReader.open(transport);
    const progress: number[] = [];
    await reader.loadEager((p) => progress.push(p.loaded / p.total));
    expect(progress.at(-1)).toBe(1);
    const tree = directoryFiles(project);
    expect(reader.projectFiles().read('scenes/main/scene.json')).toBe(tree.read('scenes/main/scene.json'));
    expect(reader.unpacked('assets/images/dot.png')).toEqual(new Uint8Array(tree.bytes('assets/images/dot.png')));
    const before = transport.requests.length;
    expect(await reader.read('assets/sfx/thud.ogg')).toEqual(EXTRA['assets/sfx/thud.ogg']);
    expect(await reader.read('assets/models/crate.bin')).toEqual(EXTRA['assets/models/crate.bin']);
    expect(await reader.read('assets/music/theme.ogg')).toEqual(EXTRA['assets/music/theme.ogg']);
    expect(transport.requests.slice(before).map((r) => r.split(' ')[0])).toEqual(['range', 'range', 'whole']);
    expect(reader.streamUrl('assets/music/theme.ogg')).toMatch(/^memory:assets\/music\//);
    expect(() => reader.projectFiles().read('assets/sfx/thud.ogg')).toThrow(/PP9541/);
  });

  it('recovers from a redeploy: adopts the new index while booting, refuses changed files once running', async () => {
    const files = bundleFiles(`${build.buildDir}/bundles`);
    const transport = new MemoryBundles(files);
    const booting = await BundleReader.open(transport);
    // A redeploy lands between reading the index and fetching the bundles: the old data bundle is gone.
    const data = booting.index.bundles['data']!.file;
    const moved = `data.0000000000000000.ppk`;
    const index = JSON.parse(new TextDecoder().decode(files.get('bundles.json')!)) as { bundles: Record<string, { file: string }> };
    index.bundles['data']!.file = moved;
    transport.replace(new Map([[data, null], [moved, files.get(data)!], ['bundles.json', new TextEncoder().encode(JSON.stringify(index))]]));
    await booting.loadEager();
    expect(booting.stats.refreshes).toBe(1);
    expect(booting.index.bundles['data']!.file).toBe(moved);

    // Running: a redeploy changed thud.ogg (new hash) and renamed its bundle.
    let stale = 0;
    const sfx = booting.index.bundles['sfx']!.file;
    const changed = JSON.parse(new TextDecoder().decode(files.get('bundles.json')!)) as { files: Record<string, { hash: string }>; bundles: Record<string, { file: string }> };
    changed.files['assets/sfx/thud.ogg']!.hash = 'f'.repeat(64);
    changed.bundles['sfx']!.file = 'sfx.1111111111111111.ppk';
    const t3 = new MemoryBundles(files);
    const r3 = await BundleReader.open(t3, { onStale: () => { stale++; } });
    await r3.loadEager();
    r3.commit();
    t3.replace(new Map([[sfx, null], ['sfx.1111111111111111.ppk', files.get(sfx)!], ['bundles.json', new TextEncoder().encode(JSON.stringify(changed))]]));
    await expect(r3.read('assets/sfx/thud.ogg')).rejects.toThrow(/PP9542.*updated while it was running/s);
    expect(stale).toBe(1);
    // An unchanged file moved to a new bundle is still served (same hash = same bytes).
    const sameHash = JSON.parse(new TextDecoder().decode(files.get('bundles.json')!)) as { bundles: Record<string, { file: string }> };
    sameHash.bundles['models']!.file = 'models.2222222222222222.ppk';
    const t4 = new MemoryBundles(files);
    const r4 = await BundleReader.open(t4);
    await r4.loadEager();
    r4.commit();
    const models = r4.index.bundles['models']!.file;
    t4.replace(new Map([[models, null], ['models.2222222222222222.ppk', files.get(models)!], ['bundles.json', new TextEncoder().encode(JSON.stringify(sameHash))]]));
    expect(await r4.read('assets/models/crate.bin')).toEqual(EXTRA['assets/models/crate.bin']);
  });

  it('a damaged entry (hash mismatch) is detected', async () => {
    const files = bundleFiles(`${build.buildDir}/bundles`);
    const sfx = JSON.parse(new TextDecoder().decode(files.get('bundles.json')!)).bundles.sfx.file as string;
    const damaged = files.get(sfx)!.slice();
    damaged[10] = damaged[10]! ^ 0xff;
    const reader = await BundleReader.open(new MemoryBundles(new Map([...files, [sfx, damaged]])));
    await reader.loadEager();
    await expect(reader.read('assets/sfx/thud.ogg')).rejects.toThrow(/PP9542/);
  });

  it('boots headless from the bundles', async () => {
    const reader = await BundleReader.open(new MemoryBundles(bundleFiles(`${build.buildDir}/bundles`)));
    await reader.loadEager();
    const loaded = await loadGame(build.buildDir);
    const game = await loaded.bootHeadless({ entry: loaded.entry, files: reader.projectFiles() });
    game.frames(60);
    expect(game.runtime.kernel.time.frame).toBe(60);
    const ball = [...game.runtime.kernel.world.live()].find((r) => r.placedId === 'ball')!;
    expect(ball.transform.position.y).toBeLessThan(5);
  });
});
