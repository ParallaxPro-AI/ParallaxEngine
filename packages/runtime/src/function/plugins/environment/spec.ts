/**
 * The scene's `"environment"` block, checked and normalized (every key optional):
 *
 *   {
 *     "sky": "clear_day",                 a preset (SKY_PRESETS)
 *     "time_of_day": 14.5,                hours, 0–24 (default 12)
 *     "day_length": 720,                  real seconds per in-game day; 0: time stands still (default)
 *     "fog": {"density": 0.01, "color": "#a0b0c0"}   exponential, or
 *            {"near": 20, "far": 80, "color": [r, g, b]}  linear (meters); no "fog": none
 *            "volumetric": 0.6                 0..1, sunlight scattered by the fog (light shafts)
 *            "height_falloff": 0.08, "height": 0   exponential fog thinning with altitude: density
 *                                         is at world y `height` and falls by e every
 *                                         1/height_falloff meters above it (ground mist, valleys)
 *     "ambient": "#404858",               default: the sky preset's
 *     "sun": {"direction": [x, y, z], "color": "#ffe0b8", "intensity": 1.2, "shadow_distance": 250}
 *                                         direction: the way the light travels; default: from the time of day;
 *                                         shadow_distance: meters from the camera the sun's shadows reach
 *                                         (default: the quality level's, 50 / 100 / 150)
 *     "post": {"preset": "cyberpunk_neon", "bloom": 0.3, "stylize": {"pixelate": 3}, ...}
 *                                         see post.ts (POST_FIELDS)
 *     "debug": {"wireframe": true, "wire_color": "#00ff66", "wire_background": null}
 *                                         a debug view: every mesh and the terrain as triangle edges
 *                                         (wire_color null: each surface's; wire_background null: the sky)
 *     "clouds": {"coverage": 0.4, "density": 0.6, "height": 1500, "thickness": 800,
 *                "scale": 2500, "speed": 6, "direction": 60}
 *                                         a drifting cloud layer (every key optional; height is the base's
 *                                         world y, meters, m/s, direction in compass degrees: 0 drifts
 *                                         toward +z, 90 toward +x)
 *     "atmosphere": {"haze": 1, "sun_size": 1}   the "atmosphere" sky's air: haze 0 (crisp) .. 4 (hazy),
 *                                         sun disc size multiplier
 *     "skybox": "https://r2.parallaxpro.ai/assets/…/sky.jpg" | "assets/images/sky.jpg" |
 *               {"texture": ..., "rotation": 90, "intensity": 1}
 *                                         an equirectangular (2:1) panorama drawn as the sky and
 *                                         lighting reflections, in place of the preset's sky;
 *                                         rotation in compass degrees, intensity a light multiplier
 *     "weather": "rain" | {"preset": "rain", ...}  read by the weather plugin (needs weather()). While
 *                                         active it owns fog density, cloud coverage/density, wind
 *                                         speed/gusts and the sky's mood (check warns on those here,
 *                                         PP3382); "fog" may then give only colour and height shape
 *   }
 *
 * Colours take every authored colour form (parseColor): "#rrggbb", "#rrggbbaa", [r, g, b], [r, g, b, a].
 */

import { closestMatch, COLOR_FORMS, fail, isAssetUrl, parseColor, remoteAssetProblem, remoteAssetUrl, Vec3 } from '../../../core/index.js';
import type { Color } from '../../../core/index.js';
import { handleFormProblem } from '../../../resource/index.js';
import type { Json, JsonObject, SceneDoc } from '../../../resource/index.js';
import { EMPTY_POST, postEntries, postPreset, postValue } from './post.js';
import type { PostField, PostLayer, PostValue } from './post.js';
import { SKY_PRESETS, WEATHER_SKY_NAMES } from './sky.js';
import type { SkyPreset } from './sky.js';

export interface FogSpec {
  readonly density: number;
  readonly near: number | null;
  readonly far: number | null;
  /** null: the sky's horizon colour. */
  readonly color: Color | null;
  /** 0..1: sunlight scattered toward the camera. */
  readonly volumetric: number;
  /** Exponential fog only: 1/meters the density falls off with height (0: uniform). */
  readonly heightFalloff: number;
  /** World y where the density is `density` (with a falloff). */
  readonly height: number;
}

export interface CloudSpec {
  readonly coverage: number;
  readonly density: number;
  readonly height: number;
  readonly thickness: number;
  readonly scale: number;
  readonly speed: number;
  /** Compass degrees the clouds drift toward (0: +z, 90: +x). */
  readonly direction: number;
}

/** A panorama sky: an equirectangular image (a project file or a hosted asset URL). */
export interface SkyboxSpec {
  /** An image handle (`images/sky`) or canonical hosted URL. */
  readonly texture: string;
  /** Compass degrees the panorama is turned (its center column faces +z at 0, +x at 90). */
  readonly rotation: number;
  /** Multiplier on the image's light (1: as authored). */
  readonly intensity: number;
}

export const DEFAULT_CLOUDS: CloudSpec = { coverage: 0.4, density: 0.6, height: 1500, thickness: 800, scale: 2500, speed: 6, direction: 60 };

export interface EnvironmentSpec {
  readonly sky: SkyPreset;
  readonly timeOfDay: number;
  readonly dayLength: number;
  readonly fog: FogSpec;
  readonly ambient: Color | null;
  readonly sunDirection: Vec3 | null;
  readonly sunColor: Color | null;
  readonly sunIntensity: number | null;
  /** Meters from the camera the sun's shadow cascades reach; null/absent: the quality level's. */
  readonly sunShadowDistance?: number | null;
  readonly post: PostLayer;
  /** The scene's cloud layer; null: none (weather may still bring clouds). */
  readonly clouds: CloudSpec | null;
  /** The "atmosphere" sky's haze multiplier and sun disc size multiplier. */
  readonly haze: number;
  readonly sunSize: number;
  /** The raw "weather" value, for the weather plugin (undefined: none). */
  readonly weather: Json | undefined;
  /** A panorama drawn as the sky (null: the preset's sky). */
  readonly skybox: SkyboxSpec | null;
  /** The "debug" block's view (null/absent: the normal view). */
  readonly debug?: DebugViewSpec | null;
}

/** A debug view over the scene's look: every mesh and the terrain drawn as triangle edges. */
export interface DebugViewSpec {
  readonly wireframe: boolean;
  /** Wireframe lines (null: each surface's color). */
  readonly wireColor: Color | null;
  /** Behind the wireframe (null: the sky). */
  readonly wireBackground: Color | null;
}

const KEYS = ['sky', 'time_of_day', 'day_length', 'fog', 'ambient', 'sun', 'post', 'clouds', 'atmosphere', 'weather', 'skybox', 'debug'] as const;
const DEBUG_KEYS = ['wireframe', 'wire_color', 'wire_background'] as const;
const SKYBOX_KEYS = ['texture', 'rotation', 'intensity'] as const;
const CLOUD_KEYS = ['coverage', 'density', 'height', 'thickness', 'scale', 'speed', 'direction'] as const;
const ATMOSPHERE_KEYS = ['haze', 'sun_size'] as const;
const FOG_KEYS = ['density', 'near', 'far', 'color', 'volumetric', 'height_falloff', 'height'] as const;
const SUN_KEYS = ['direction', 'color', 'intensity', 'shadow_distance'] as const;

export const NO_FOG: FogSpec = { density: 0, near: null, far: null, color: null, volumetric: 0, heightFalloff: 0, height: 0 };

export const DEFAULT_ENVIRONMENT: EnvironmentSpec = {
  sky: 'clear_day', timeOfDay: 12, dayLength: 0, fog: NO_FOG, ambient: null,
  sunDirection: null, sunColor: null, sunIntensity: null, post: EMPTY_POST, clouds: null, haze: 1, sunSize: 1, weather: undefined, skybox: null,
};

/** A cloud setting's own checks (data and `ctx.environment.clouds`): the problem, or undefined. */
export function cloudProblem(c: CloudSpec): { key: string; message: string } | undefined {
  const unit = (key: string, v: number): { key: string; message: string } | undefined =>
    (v >= 0 && v <= 1 ? undefined : { key, message: `clouds ${key} is ${v}; it must be 0 to 1` });
  const positive = (key: string, v: number): { key: string; message: string } | undefined =>
    (v > 0 ? undefined : { key, message: `clouds ${key} is ${v}; it must be above 0` });
  return unit('coverage', c.coverage) ?? unit('density', c.density) ?? positive('height', c.height) ?? positive('thickness', c.thickness)
    ?? positive('scale', c.scale) ?? (c.speed >= 0 ? undefined : { key: 'speed', message: `clouds speed is ${c.speed}; it can't be negative` });
}

/** A fog setting's own checks (data and `ctx.environment.fog`): PP3222 with `where`. */
export function checkFog(fog: FogSpec, where: string): void {
  if (fog.density < 0) fail('PP3222', `${where}: fog density can't be negative`, { fix: 'Use 0 for no fog.' });
  if ((fog.near === null) !== (fog.far === null)) {
    fail('PP3222', `${where}: linear fog needs both near and far`, { fix: 'Give near and far in meters (near < far).' });
  }
  if (fog.near !== null && fog.far !== null && !(fog.near >= 0 && fog.near < fog.far)) {
    fail('PP3222', `${where}: fog near ${fog.near} must be at least 0 and less than far ${fog.far}`, { fix: 'Make near < far.' });
  }
  if (fog.density > 0 && fog.near !== null) {
    fail('PP3222', `${where}: fog is either exponential (density) or linear (near/far), not both`, { fix: 'Keep one of them.' });
  }
  if (!(fog.volumetric >= 0 && fog.volumetric <= 1)) {
    fail('PP3222', `${where}: fog volumetric is ${fog.volumetric}; it must be 0 to 1`, { fix: 'Use 0 for plain fog, up to 1 for strong light shafts.' });
  }
  if (!(fog.heightFalloff >= 0 && fog.heightFalloff <= 10) || !Number.isFinite(fog.height)) {
    fail('PP3222', `${where}: fog height_falloff is ${fog.heightFalloff}; it must be 0 to 10 (per meter)`, { fix: 'Use 0 for uniform fog; 0.02 to 0.3 for ground mist.' });
  }
  if (fog.heightFalloff > 0 && fog.near !== null) {
    fail('PP3222', `${where}: height_falloff thins exponential fog; linear (near/far) fog has no height`, { fix: 'Give "density" instead of near/far, or remove height_falloff.' });
  }
}

class BlockReader {
  readonly #scene: SceneDoc;

  constructor(scene: SceneDoc) {
    this.#scene = scene;
  }

  fail(pointer: string, message: string, fix: string): never {
    return fail('PP3220', `Scene "${this.#scene.id}" environment: ${message}`, { fix, path: this.#scene.path, pointer: `/environment${pointer}` });
  }

  object(value: Json | undefined, pointer: string, allowed: readonly string[]): JsonObject {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return this.fail(pointer, `${pointer.slice(1)} must be an object`, `Write ${pointer.slice(1)} as {...}.`);
    }
    for (const key of Object.keys(value)) {
      if (allowed.includes(key)) continue;
      const guess = closestMatch(key, allowed);
      this.fail(`${pointer}/${key}`, `unknown key "${key}"`, guess === undefined ? `Keys here: ${allowed.join(', ')}.` : `Did you mean "${guess}"?`);
    }
    return value as JsonObject;
  }

  number(value: Json | undefined, pointer: string, check?: (n: number) => string | undefined): number | null {
    if (value === undefined) return null;
    if (typeof value !== 'number' || !Number.isFinite(value)) return this.fail(pointer, `${pointer.slice(1)} must be a number`, 'Write a number.');
    const problem = check?.(value);
    if (problem !== undefined) this.fail(pointer, `${pointer.slice(1)} ${problem}`, `Change ${pointer.slice(1)}.`);
    return value;
  }

  color(value: Json | undefined, pointer: string): Color | null {
    if (value === undefined) return null;
    return parseColor(value) ?? this.fail(pointer, `${pointer.slice(1)} must be a colour, got ${JSON.stringify(value)}`, `Use ${COLOR_FORMS}.`);
  }
}

export function skyPreset(name: unknown, where: string, init: { path?: string; pointer?: string } = {}): SkyPreset {
  if (typeof name === 'string' && (SKY_PRESETS as readonly string[]).includes(name)) return name as SkyPreset;
  if (typeof name === 'string' && (WEATHER_SKY_NAMES as readonly string[]).includes(name)) {
    return fail('PP3221', `${where}: "${name}" is a weather, not a sky preset`, {
      ...init,
      fix: `Write "weather": "${name}" in the environment block (it greys the sky, brings cloud, fog and wind) and pick a sky for the hour (${SKY_PRESETS.join(', ')}); add weather() to the game's plugins.`,
    });
  }
  const guess = typeof name === 'string' ? closestMatch(name, SKY_PRESETS) : undefined;
  return fail('PP3221', `${where}: unknown sky preset ${JSON.stringify(name)}`, {
    ...init,
    fix: guess === undefined ? `Use one of: ${SKY_PRESETS.join(', ')}.` : `Did you mean "${guess}"?`,
  });
}

/**
 * A skybox image reference checked for form: a project image's handle ("images/sky", the one
 * spelling of an asset; the renderer resolves it to the file), or a hosted image URL
 * (canonical form).
 */
export function skyboxTexture(ref: string, problem: (message: string, fix: string) => never): string {
  if (isAssetUrl(ref)) {
    const wrong = remoteAssetProblem(ref, 'images');
    if (wrong !== undefined) return problem(wrong, 'Use a hosted image (https://r2.parallaxpro.ai/assets/….jpg/.png/.webp) or an image of the game ("images/<name>").');
    return remoteAssetUrl(ref)!;
  }
  const form = handleFormProblem(ref, 'images');
  if (form !== undefined) return problem(`skybox texture ${form.message}`, `Write "${form.handle}".`);
  if (!/^images\/[^/.][^.]*$/.test(ref)) {
    return problem(`skybox texture "${ref}" is not an image of the game`, 'Use an image handle like "images/sky" (a PNG, JPEG or WebP under assets/images/) or a hosted image URL.');
  }
  return ref;
}

const hours = (n: number): string | undefined => (n >= 0 && n <= 24 ? undefined : 'must be between 0 and 24');
const nonNegative = (n: number): string | undefined => (n >= 0 ? undefined : "can't be negative");
/** The sun's shadow reach: past a few kilometers one shadow map's texels are meters wide. */
const shadowReach = (n: number): string | undefined => (n > 0 && n <= 5000 ? undefined : 'must be above 0 and at most 5000 (meters)');

/** The scene's environment (the defaults where it has no block or omits a key). */
export function readEnvironmentSpec(scene: SceneDoc): EnvironmentSpec {
  const block = scene.environment;
  if (block === undefined) return DEFAULT_ENVIRONMENT;
  const r = new BlockReader(scene);
  r.object(block, '', KEYS);

  const sky = block['sky'] === undefined
    ? DEFAULT_ENVIRONMENT.sky
    : skyPreset(block['sky'], `Scene "${scene.id}" environment`, { path: scene.path, pointer: '/environment/sky' });

  let fog = NO_FOG;
  if (block['fog'] !== undefined) {
    const f = r.object(block['fog'], '/fog', FOG_KEYS);
    fog = {
      density: r.number(f['density'], '/fog/density', nonNegative) ?? 0,
      near: r.number(f['near'], '/fog/near'),
      far: r.number(f['far'], '/fog/far'),
      color: r.color(f['color'], '/fog/color'),
      volumetric: r.number(f['volumetric'], '/fog/volumetric') ?? 0,
      heightFalloff: r.number(f['height_falloff'], '/fog/height_falloff') ?? 0,
      height: r.number(f['height'], '/fog/height') ?? 0,
    };
    // Under a weather the density is the weather's: the block may give only colour and shape.
    if (fog.density === 0 && fog.near === null && fog.far === null && block['weather'] === undefined) {
      r.fail('/fog', 'fog needs a density or near and far', 'Add "density": 0.01, or "near" and "far" in meters; remove "fog" for none.');
    }
    try {
      checkFog(fog, 'fog');
    } catch (error) {
      r.fail('/fog', (error as Error).message.split('\n')[0]!.replace(/^PP\d+\s+/, ''), 'Use "density" (optionally with "height_falloff"), or "near" with "far" (near < far).');
    }
  }

  let sunDirection: Vec3 | null = null;
  let sunColor: Color | null = null;
  let sunIntensity: number | null = null;
  let sunShadowDistance: number | null = null;
  if (block['sun'] !== undefined) {
    const s = r.object(block['sun'], '/sun', SUN_KEYS);
    const d = s['direction'];
    if (d !== undefined) {
      if (!Array.isArray(d) || d.length !== 3 || !d.every((n) => typeof n === 'number' && Number.isFinite(n))) {
        r.fail('/sun/direction', 'sun direction must be a list of 3 numbers', 'Write the way the light travels, e.g. [0.4, -0.8, 0.3].');
      }
      const [x, y, z] = d as readonly number[];
      const v = new Vec3(x!, y!, z!);
      if (v.length() === 0) r.fail('/sun/direction', 'sun direction is zero', 'Give a non-zero direction.');
      sunDirection = v.normalized();
    }
    sunColor = r.color(s['color'], '/sun/color');
    sunIntensity = r.number(s['intensity'], '/sun/intensity', nonNegative);
    sunShadowDistance = r.number(s['shadow_distance'], '/sun/shadow_distance', shadowReach);
  }

  let post = EMPTY_POST;
  if (block['post'] !== undefined) {
    // Every key is checked by postEntries (its hints name the groups and the debug block).
    const raw = block['post'];
    const p = r.object(raw, '/post', typeof raw === 'object' && raw !== null ? Object.keys(raw) : []);
    const preset: PostLayer['preset'] = p['preset'] === undefined
      ? null
      : postPreset(p['preset'], (message, fix) => r.fail('/post/preset', message, fix));
    const fields: Partial<Record<PostField, PostValue>> = {};
    for (const [spec, value, path] of postEntries(p, (at, message, fix) => r.fail(`/post/${at}`, message, fix))) {
      const pointer = `/post/${path}`;
      fields[spec.prop] = postValue(spec, value, (v) => r.color(v as Json, pointer), (message, fix) => r.fail(pointer, message, fix));
    }
    post = { preset, fields };
  }

  let debug: DebugViewSpec | null = null;
  if (block['debug'] !== undefined) {
    const d = r.object(block['debug'], '/debug', DEBUG_KEYS);
    const wireframe = d['wireframe'] ?? false;
    if (typeof wireframe !== 'boolean') r.fail('/debug/wireframe', 'debug wireframe must be true or false', 'Write "wireframe": true.');
    const optionalColor = (key: string): Color | null => (d[key] === undefined || d[key] === null ? null : r.color(d[key], `/debug/${key}`));
    debug = { wireframe: wireframe === true, wireColor: optionalColor('wire_color'), wireBackground: optionalColor('wire_background') };
  }

  let clouds: CloudSpec | null = null;
  if (block['clouds'] !== undefined) {
    const c = r.object(block['clouds'], '/clouds', CLOUD_KEYS);
    const d = DEFAULT_CLOUDS;
    clouds = {
      coverage: r.number(c['coverage'], '/clouds/coverage') ?? d.coverage,
      density: r.number(c['density'], '/clouds/density') ?? d.density,
      height: r.number(c['height'], '/clouds/height') ?? d.height,
      thickness: r.number(c['thickness'], '/clouds/thickness') ?? d.thickness,
      scale: r.number(c['scale'], '/clouds/scale') ?? d.scale,
      speed: r.number(c['speed'], '/clouds/speed') ?? d.speed,
      direction: r.number(c['direction'], '/clouds/direction') ?? d.direction,
    };
    const problem = cloudProblem(clouds);
    if (problem !== undefined) r.fail(`/clouds/${problem.key}`, problem.message, `Change clouds ${problem.key}.`);
  }
  let haze = 1;
  let sunSize = 1;
  if (block['atmosphere'] !== undefined) {
    const a = r.object(block['atmosphere'], '/atmosphere', ATMOSPHERE_KEYS);
    haze = r.number(a['haze'], '/atmosphere/haze', (n) => (n >= 0 && n <= 8 ? undefined : 'must be 0 to 8')) ?? 1;
    sunSize = r.number(a['sun_size'], '/atmosphere/sun_size', (n) => (n > 0 && n <= 20 ? undefined : 'must be above 0 and at most 20')) ?? 1;
  }

  let skybox: SkyboxSpec | null = null;
  if (block['skybox'] !== undefined) {
    const raw = block['skybox'];
    const s = typeof raw === 'string' ? { texture: raw } : r.object(raw, '/skybox', SKYBOX_KEYS);
    const pointer = typeof raw === 'string' ? '/skybox' : '/skybox/texture';
    const texture = s['texture'];
    if (typeof texture !== 'string' || texture === '') {
      r.fail(pointer, 'skybox needs a texture', 'Give an equirectangular image: "images/sky" (assets/images/sky.jpg) or a https://r2.parallaxpro.ai/assets/… URL.');
    }
    skybox = {
      texture: skyboxTexture(texture as string, (message, fix) => r.fail(pointer, message, fix)),
      rotation: r.number(s['rotation'], '/skybox/rotation') ?? 0,
      intensity: r.number(s['intensity'], '/skybox/intensity', nonNegative) ?? 1,
    };
  }

  return {
    sky,
    clouds,
    haze,
    sunSize,
    skybox,
    weather: block['weather'],
    timeOfDay: (r.number(block['time_of_day'], '/time_of_day', hours) ?? DEFAULT_ENVIRONMENT.timeOfDay) % 24,
    dayLength: r.number(block['day_length'], '/day_length', nonNegative) ?? 0,
    fog,
    ambient: r.color(block['ambient'], '/ambient'),
    sunDirection,
    sunColor,
    sunIntensity,
    sunShadowDistance,
    post,
    debug,
  };
}
