/**
 * Outdoor data checks over a real example (read-only): pirate_sailing's bay scene and
 * prefabs with environment, weather, water bodies and buoyancy broken one rule at a time.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { Diagnostic } from '@parallax/runtime/core';
import { checkFiles } from './check.js';
import type { Declarations } from './declarations.js';
import { runExtract } from './extract.js';
import { directoryFiles, memoryFiles } from './files.js';

const DIR = fileURLToPath(new URL('../../../examples/pirate_sailing', import.meta.url));
const SCENE = 'scenes/bay/scene.json';

let files: Record<string, string>;
let declarations: Declarations;

beforeAll(() => {
  const tree = directoryFiles(DIR);
  files = {};
  for (const path of tree.all()) if (!/\.(png|glb|ogg|mp3|wav)$/.test(path)) files[path] = tree.read(path);
  const extracted = runExtract(DIR);
  if (!extracted.ok) throw new Error(extracted.diagnostic.message);
  declarations = extracted.declarations;
});

/** The example's declarations without one plugin. */
function without(plugin: string): Declarations {
  const decl = structuredClone(declarations);
  return { ...decl, game: { ...decl.game!, plugins: decl.game!.plugins.filter((p) => p.id !== plugin) } };
}

function check(environment: Record<string, unknown>, prefabs: Record<string, unknown> = {}, decl: Declarations = declarations): string[] {
  const scene = JSON.parse(files[SCENE]!) as { environment: Record<string, unknown> };
  Object.assign(scene.environment, environment);
  const extra = Object.fromEntries(Object.entries(prefabs).map(([id, p]) => [`prefabs/${id}.prefab.json`, JSON.stringify(p)]));
  const found: readonly Diagnostic[] = checkFiles(memoryFiles({ ...files, ...extra, [SCENE]: JSON.stringify(scene) }), decl, { assetFiles: false }).diagnostics;
  // Only the edited files: other scenes' own blocks report too once a plugin is dropped.
  const edited = new Set([SCENE, ...Object.keys(extra)]);
  return found.filter((d) => /^PP(322\d|337[01]|3380|2063)$/.test(d.code) && (d.path === undefined || edited.has(d.path))).map((d) => `${d.code} ${d.pointer ?? ''}`);
}

describe('nature checks', () => {
  it('accepts the example as it is, and an atmosphere sky with clouds', () => {
    expect(check({})).toEqual([]);
    expect(check({ sky: 'atmosphere', clouds: { coverage: 0.5 }, atmosphere: { haze: 2 } })).toEqual([]);
  });

  it('reads the environment block as the runtime does', () => {
    expect(check({ clouds: { coverage: 3 } })).toEqual(['PP3220 /environment/clouds/coverage']);
    expect(check({ sky: 'stormy' })).toEqual(['PP3221 /environment/sky']);
  });

  it('a weather needs the weather plugin and a preset it knows', () => {
    expect(check({ weather: 'rain' }, {}, without('weather'))).toEqual(['PP3227 /environment/weather']);
    expect(check({ weather: 'rain' })).toEqual([]);
    expect(check({ weather: { preset: 'rian' } }, {}, without('weather'))).toEqual(['PP3227 /environment/weather', 'PP3380 /environment/weather/preset']);
    expect(check({ weather: { preset: 'rian' } })).toEqual(['PP3380 /environment/weather/preset']);
  });

  it('a weather owns wind speed/gusts, cloud cover and fog density: scene values it replaces warn (PP3382)', () => {
    const owned = (environment: Record<string, unknown>): string[] => {
      const scene = JSON.parse(files[SCENE]!) as { environment: Record<string, unknown> };
      Object.assign(scene.environment, environment);
      return checkFiles(memoryFiles({ ...files, [SCENE]: JSON.stringify(scene) }), declarations, { assetFiles: false }).diagnostics
        .filter((d) => d.code === 'PP3382' && d.path === SCENE).map((d) => `${d.severity} ${d.pointer ?? ''}`);
    };
    // The bay blows its own wind ("speed": 11, "gusts": 0.2): fine without a weather.
    expect(owned({})).toEqual([]);
    expect(owned({ weather: 'rain', clouds: { coverage: 0.4, density: 0.7 }, fog: { density: 0.01 } })).toEqual([
      'warning /environment/clouds/coverage', 'warning /environment/fog/density', 'warning /wind/gusts', 'warning /wind/speed',
    ]);
    // Under a weather, "fog" may give only its colour and shape.
    expect(check({ weather: 'rain', fog: { color: '#808890', height_falloff: 0.05 } })).toEqual([]);
    // Grey skies are weather, not sky presets.
    expect(check({ sky: 'storm' })).toEqual(['PP3221 /environment/sky']);
  });

  it("the weather's sounds are sfx the game names (PP3380 for a bad key, PP2063 for another folder)", () => {
    const sounds = (weather: unknown): string[] => check({ weather }).filter((d) => !d.startsWith('PP3227'));
    expect(sounds({ preset: 'rain', sounds: { rain: 'sfx/rain_loop', thunder: 'sfx/thunder' } })).toEqual([]);
    expect(sounds({ preset: 'rain', sounds: { thuner: 'sfx/thunder' } })).toEqual(['PP3380 /environment/weather/sounds/thuner']);
    expect(sounds({ preset: 'rain', sounds: { rain: 'music/storm' } })).toEqual(['PP2063 /environment/weather/sounds/rain']);
    expect(check({}, { pond: { components: { water_body: { kind: 'pool', area: { center: [0, 0], size: [4, 4] }, splash_sound: 'music/storm' } } } }))
      .toEqual(['PP2063 /components/water_body/splash_sound']);
  });

  it('water bodies and buoyancy keep their rules across fields', () => {
    expect(check({}, {
      pond: { components: { water_body: { kind: 'lake' } } },
      creek: { components: { water_body: { kind: 'river', points: [[0, 0, 0]] } } },
      raft: { components: { buoyancy: {} } },
    })).toEqual([
      'PP3370 /components/water_body/points', 'PP3370 /components/water_body/area', 'PP3371 /components/buoyancy',
    ]);
  });
});
