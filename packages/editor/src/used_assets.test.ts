import { describe, expect, it } from 'vitest';
import { fileStem, replaceOps, scanUsedAssets } from './used_assets.js';
import { wantsMobile } from './mobile.js';
import { waveformPeaks } from './asset_previews.js';

const R2 = 'https://r2.parallaxpro.ai/assets';
const BOOM = `${R2}/audio_sfx/fd/d0/${'a'.repeat(64)}.ogg`;
const MUSIC = `${R2}/audio_music/2a/fd/${'b'.repeat(64)}.mp3`;
const BUSH = `${R2}/model_static/f0/6d/${'c'.repeat(64)}.glb`;
const GRASS = `${R2}/image_texture/42/93/${'d'.repeat(64)}.jpg`;

function files(map: Record<string, unknown>): { list(): string[]; read(path: string): string } {
  const text = Object.fromEntries(Object.entries(map).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  return { list: () => Object.keys(text), read: (path) => text[path]! };
}

describe('used assets', () => {
  const project = files({
    'assets/audio.json': { [MUSIC]: { volume: 0.3 } },
    'assets/models/crate.model.json': { parts: [{ material: { albedo_map: GRASS } }] },
    'config/sounds.json': { cannon: BOOM },
    'prefabs/bush.prefab.json': { components: { model: { model: BUSH } } },
    'prefabs/crate.prefab.json': { components: { model: { model: 'assets/models/crate.model.json' } } },
    'scenes/arena/scene.json': { music: MUSIC, terrain: { texture: GRASS }, entities: [{ prefab: 'bush' }] },
    'build/out.json': { cannon: `${R2}/audio_sfx/00/00/${'e'.repeat(64)}.ogg` },
    'game/main.py': `play("${BOOM}")`,
  });
  const used = scanUsedAssets(project);
  const byRef = new Map(used.map((a) => [a.ref, a]));

  it('finds models, textures and sounds wherever the project names them (not in build output)', () => {
    expect(used.map((a) => `${a.kind}:${a.ref.split('/').pop()!.slice(0, 6)}`).sort()).toEqual([
      'audio:aaaaaa', 'audio:bbbbbb', 'models:cccccc', 'models:crate.', 'textures:dddddd',
    ]);
  });

  it('names each after where it is used, since a hosted URL is a hash', () => {
    expect(byRef.get(BOOM)?.name).toBe('cannon');
    expect(byRef.get(BUSH)?.name).toBe('bush');
    expect(byRef.get(MUSIC)?.name).toBe('arena music');
    expect(byRef.get(GRASS)?.name).toBe('crate albedo map');
    expect(byRef.get('assets/models/crate.model.json')?.name).toBe('crate');
  });

  it('lists every file that uses an asset', () => {
    expect(byRef.get(BOOM)?.usedIn).toEqual(['config/sounds.json', 'game/main.py']);
    expect(byRef.get(MUSIC)?.usedIn).toEqual(['scenes/arena/scene.json', 'assets/audio.json']);
    expect(byRef.get('assets/models/crate.model.json')?.usedIn).toEqual(['prefabs/crate.prefab.json']);
  });

  it('takes a file\'s own id as its stem', () => {
    expect(fileStem('prefabs/crate.prefab.json')).toBe('crate');
    expect(fileStem('scenes/arena/scene.json')).toBe('arena');
  });
});

describe('replace ops', () => {
  it('replaces every string equal to the asset, nested anywhere', () => {
    expect(replaceOps({ music: 'a.mp3', list: ['a.mp3', 'b'], deep: { x: { y: 'a.mp3' } } }, 'a.mp3', 'c.mp3')).toEqual([
      { op: 'replace', pointer: '/music', value: 'c.mp3' },
      { op: 'replace', pointer: '/list/0', value: 'c.mp3' },
      { op: 'replace', pointer: '/deep/x/y', value: 'c.mp3' },
    ]);
  });

  it('renames a key that is the asset (per-file defaults), keeping its value', () => {
    expect(replaceOps({ 'https://x/a.mp3': { volume: 0.3 } }, 'https://x/a.mp3', 'https://x/c.mp3')).toEqual([
      { op: 'remove', pointer: '/https:~1~1x~1a.mp3' },
      { op: 'add', pointer: '/https:~1~1x~1c.mp3', value: { volume: 0.3 } },
    ]);
  });

  it('is empty for a document that doesn\'t use it', () => {
    expect(replaceOps({ a: 'b' }, 'x', 'y')).toEqual([]);
  });
});

describe('the phone layout rule', () => {
  it('is a touch-primary device or a window too narrow for the columns', () => {
    expect(wantsMobile({ width: 390, touch: true, coarse: true })).toBe(true);
    expect(wantsMobile({ width: 1024, touch: true, coarse: true })).toBe(true); // a tablet
    expect(wantsMobile({ width: 1440, touch: true, coarse: false })).toBe(false); // a touchscreen laptop
    expect(wantsMobile({ width: 690, touch: false, coarse: false })).toBe(true); // a narrow window
    expect(wantsMobile({ width: 1440, touch: false, coarse: false })).toBe(false);
  });
});

describe('waveform peaks', () => {
  it('takes the loudest sample per bucket, normalized', () => {
    const peaks = waveformPeaks(Float32Array.from([0.1, -0.5, 0.2, 0.25, 0, 0]), 3);
    expect([...peaks].map((v) => Number(v.toFixed(2)))).toEqual([1, 0.5, 0]);
  });

  it('leaves silence flat', () => {
    expect([...waveformPeaks(new Float32Array(8), 4)]).toEqual([0, 0, 0, 0]);
  });
});
