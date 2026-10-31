/**
 * The `environment` service: the scene's look resolved for this frame, provided by the
 * environment plugin (core: in every game). Renderers call `resolve()` in the kernel's
 * 'render' hook — after EnvironmentZone weights (visuals, 'ui' hook) are final — and draw
 * from it: render3d the sky, sun, ambient, fog and post settings; render2d the `clear`
 * colour behind cameras whose `background` is None, and `ambient` under its 2D lights.
 *
 * Resolution order: the scene's "environment" block → runtime changes
 * (`ctx.environment.fog/sky/post/time_of_day`, blended over their `seconds`) → the day cycle
 * (time of day drives the sun direction unless the block fixes `sun.direction`; with
 * `day_length > 0` it also dims the sun, sky and ambient at night) → every
 * EnvironmentZone, in spawn order, lerping each override it sets by its `__weight__`.
 *
 * The sky. The "atmosphere" preset is physically based: `atmosphere` holds the scattering
 * model its palette came from (render3d draws the same model per pixel); other presets are
 * palettes (`atmosphere` null). Clouds drift with their own wind (`clouds.offset` is the
 * drift so far); a weather plugin, when present, adds cover, greys the sky, thickens the fog
 * and flashes it with lightning (`flash`).
 *
 * `persist()` / `load()` are for the save plugin (SaveData.environment): the run-lifetime
 * state — time of day, day count, day length and the fog/sky/post overrides.
 */

import type { Atmosphere3d, Color, Vec3 } from '../../core/index.js';
import type { Json, JsonObject } from '../../resource/index.js';
import { serviceKey } from '../kernel/index.js';
import type { ServiceKey } from '../kernel/index.js';

/**
 * The looks a scene's `"post": {"preset": ...}` (or `ctx.environment.post(preset)`) may
 * name. Each is a bundle of post settings (environment plugin, `post.ts`); fields the scene
 * sets win over its preset's.
 */
export const POST_PRESET_NAMES = [
  'cyberpunk_neon', 'warm', 'cool', 'noir', 'vintage', 'vivid', 'cinematic', 'horror', 'dreamy', 'retro', 'comic', 'toon',
  'underwater', 'night_vision',
] as const;
export type PostPresetName = (typeof POST_PRESET_NAMES)[number];

/**
 * Post-processing settings, fully resolved (defaults ← preset ← scene ← runtime). Field
 * meanings follow the scene keys in `post` (snake_case there): see the environment plugin's
 * `POST_FIELDS`. Renderers draw what their quality allows.
 */
export interface PostSettings {
  readonly preset: string | null;
  readonly exposure: number;
  readonly bloom: number;
  readonly bloomThreshold: number;
  readonly saturation: number;
  readonly contrast: number;
  readonly tint: Color;
  /** White balance, -1 (cool) .. 1 (warm). */
  readonly temperature: number;
  /** 0..1 film grain. */
  readonly grain: number;
  readonly vignette: number;
  readonly chromaticAberration: number;
  readonly pixelate: number;
  readonly posterize: number;
  readonly toon: number;
  readonly edges: number;
  readonly edgeColor: Color;
  readonly ambientOcclusion: number;
  readonly reflections: boolean;
  readonly godRays: number;
  readonly mode: 'standard' | 'wireframe';
  readonly wireColor: Color | null;
  readonly wireBackground: Color | null;
  readonly antialias: boolean;
}

export interface ResolvedFog {
  /** Exponential fog density per meter (0: none). */
  readonly density: number;
  /** Linear fog start and end in meters, or null when the fog is exponential only. */
  readonly near: number | null;
  readonly far: number | null;
  readonly color: Color;
  /** 0..1: sunlight scattered by the fog toward the camera (light shafts). */
  readonly volumetric: number;
  /** Exponential fog: 1/meters the density falls with height above `height` (0 or absent: uniform). */
  readonly heightFalloff?: number;
  /** World y where the density is `density`. */
  readonly height?: number;
}

export interface ResolvedClouds {
  /** 0..1 of the sky covered. */
  readonly coverage: number;
  /** 0..1 optical thickness. */
  readonly density: number;
  /** World y of the layer's base, and its thickness (meters). */
  readonly base: number;
  readonly thickness: number;
  /** Meters across one cloud cell. */
  readonly scale: number;
  /** Meters drifted so far along x and z. */
  readonly offsetX: number;
  readonly offsetZ: number;
  /** 0..1: storm-dark undersides. */
  readonly darkness: number;
}

export interface ResolvedEnvironment {
  /** The kernel frame this was resolved for. */
  readonly frame: number;
  /** Sky preset name (while a `sky(..., seconds=)` change blends, the target preset). */
  readonly sky: string;
  /** Sky gradient: straight up, and at the horizon (preset, transition, day cycle, zone tints applied). */
  readonly zenith: Color;
  readonly horizon: Color;
  /** One colour for a flat background (2D clears): the horizon colour. */
  readonly clear: Color;
  /** Unit vector the sunlight travels along (pointing down when the sun is up). */
  readonly sunDirection: Vec3;
  readonly sunColor: Color;
  /** Multiplier on `sunColor` (0 at night with a day cycle, or when the block sets 0). */
  readonly sunIntensity: number;
  /** Meters from the camera the sun's shadows reach (the block's `sun.shadow_distance`); null/absent: the quality level's. */
  readonly shadowDistance?: number | null;
  readonly ambient: Color;
  readonly fog: ResolvedFog;
  /** Post-processing (preset expanded, scene and runtime fields applied). */
  readonly post: PostSettings;
  /** Hours in [0, 24). */
  readonly timeOfDay: number;
  /** Days elapsed since the run started. */
  readonly day: number;
  readonly isNight: boolean;
  /** 0 by day .. 1 at night, easing over dawn and dusk (time of day); absent: `isNight` as 0 or 1. */
  readonly night?: number;
  /** Unit vector toward the sun, also below the horizon (night): what the sky's scattering follows. */
  readonly toSun: Vec3;
  /** The "atmosphere" preset's scattering model; null for palette presets. */
  readonly atmosphere: Atmosphere3d | null;
  /** The cloud layer (the scene's "clouds", runtime changes and weather); null: a cloudless sky. */
  readonly clouds: ResolvedClouds | null;
  /** 0..1: stars showing. */
  readonly stars: number;
  /** Lightning's flash, 0 (none) and up (weather). */
  readonly flash: number;
  /** A panorama drawn as the sky (image path or hosted URL, compass degrees, light multiplier); absent or null: none. */
  readonly skybox?: { readonly texture: string; readonly rotation: number; readonly intensity: number } | null;
}

export interface EnvironmentService {
  /** The look for the current frame (cached per frame). */
  resolve(): ResolvedEnvironment;
  /** Run-lifetime state as JSON, for save slots. */
  persist(): JsonObject;
  /** Put back what `persist` returned (after the scene loaded). */
  load(state: Json): void;
  /**
   * A transient grade over the resolved post settings (cinematic grade tracks): `look` is a
   * scene "post" block (`{"preset": "noir", "vignette": 0.5}`) blended in at `weight` 0..1;
   * null clears it. Not saved or synced: its owner sets it again every frame it wants it.
   */
  grade?(look: JsonObject | null, weight: number): void;
}

export const ENVIRONMENT_SERVICE: ServiceKey<EnvironmentService> = serviceKey<EnvironmentService>(
  'environment', 'The environment plugin is core: build the game through createRuntime, which includes it.',
);

/**
 * How much of a Light's intensity shines now, 0..1, by its `when` field: "always" 1, "night"
 * the environment's `night` (fading over dusk and dawn), "day" the rest. No environment: day.
 */
export function lightShare(when: unknown, environment: Pick<ResolvedEnvironment, 'isNight' | 'night'> | undefined): number {
  if (when !== 'night' && when !== 'day') return 1;
  const night = environment === undefined ? 0 : environment.night ?? (environment.isNight ? 1 : 0);
  return when === 'night' ? night : 1 - night;
}
