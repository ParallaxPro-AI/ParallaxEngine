import { describe, expect, it } from 'vitest';
import type { BundleIndex } from '../resource/index.js';
import { fullscreenControl, playFiles } from './play.js';
import type { BuildManifest } from './modules.js';

describe('playFiles: what the play boot can fetch (offline exports)', () => {
  const manifest: BuildManifest = {
    entry: 'game/main.js',
    modules: [
      { source: 'game/main.py', output: 'game/main.js' },
      { source: 'game/ball.py', output: 'game/ball.js' },
      { source: 'migrations/v2.py', output: 'migrations/v2.js' },
      { source: 'tests/test_ball.py', output: 'tests/test_ball.js' },
      { source: 'game/broken.py', output: null },
    ],
  };
  const index: BundleIndex = {
    format: 'parallax.bundles', version: 1,
    bundles: {
      data: { file: 'data.1a.ppk', size: 10, eager: true },
      models: { file: 'models.2b.ppk', size: 99, eager: false },
    },
    files: {
      'scenes/main/scene.json': { hash: 'h1', size: 5, bundle: 'data', offset: 0, length: 5, encoding: 'identity' },
      'assets/models/ship.glb': { hash: 'h2', size: 9, bundle: 'models', offset: 0, length: 9, encoding: 'identity' },
      'assets/music/theme.ogg': { hash: 'h3', size: 300, url: 'assets/music/h3' },
      'assets/models/tree.glb': { hash: 'h4', size: 30, url: 'https://cdn.example/assets/models/h4' },
    },
  } as unknown as BundleIndex;

  it('lists the manifest, project module and every non-test module, and every bundle and loose file', () => {
    const files = playFiles(manifest, index);
    expect(files.build).toEqual(['game/ball.js', 'game/main.js', 'manifest.json', 'migrations/v2.js', 'project.js']);
    expect(files.bundles).toEqual(['assets/music/h3', 'bundles.json', 'data.1a.ppk', 'https://cdn.example/assets/models/h4', 'models.2b.ppk']);
  });

  it('refuses a build without an entry', () => {
    expect(() => playFiles({ entry: null, modules: [] }, index)).toThrow(/PP9502|game\/main.py/);
  });
});

describe('fullscreenControl', () => {
  function page(): { doc: EventTarget & Record<string, unknown>; target: Record<string, unknown> } {
    const doc = new EventTarget() as EventTarget & Record<string, unknown>;
    doc['fullscreenElement'] = null;
    const target: Record<string, unknown> = { ownerDocument: doc };
    target['requestFullscreen'] = async () => { doc['fullscreenElement'] = target; doc.dispatchEvent(new Event('fullscreenchange')); };
    doc['exitFullscreen'] = async () => { doc['fullscreenElement'] = null; doc.dispatchEvent(new Event('fullscreenchange')); };
    return { doc, target };
  }

  it('enters and leaves, reporting each change (Escape included)', async () => {
    const { doc, target } = page();
    const changes: boolean[] = [];
    const control = fullscreenControl(target as unknown as HTMLElement, (a) => changes.push(a), () => {});
    expect(await control.toggle()).toBe(true);
    expect(control.active).toBe(true);
    // The player pressed Escape: the browser left fullscreen on its own.
    doc['fullscreenElement'] = null;
    doc.dispatchEvent(new Event('fullscreenchange'));
    expect(control.active).toBe(false);
    expect(await control.toggle()).toBe(true);
    expect(await control.toggle()).toBe(false);
    expect(changes).toEqual([true, false, true, false]);
    control.dispose();
  });

  it('reports a refused request instead of throwing, and uses WebKit\'s prefix when that is all there is', async () => {
    const { doc, target } = page();
    const refused: string[] = [];
    target['requestFullscreen'] = async () => { throw new Error('Permissions check failed'); };
    const control = fullscreenControl(target as unknown as HTMLElement, () => {}, (r) => refused.push(r));
    expect(await control.toggle()).toBe(false);
    expect(refused).toEqual(['Permissions check failed']);
    delete target['requestFullscreen'];
    target['webkitRequestFullscreen'] = () => { doc['webkitFullscreenElement'] = target; };
    doc['fullscreenElement'] = undefined;
    expect(await control.toggle()).toBe(true);
    delete target['webkitRequestFullscreen'];
    doc['webkitFullscreenElement'] = null;
    expect(await control.toggle()).toBe(false);
    expect(refused).toEqual(['Permissions check failed', 'this browser has no fullscreen']);
  });
});
