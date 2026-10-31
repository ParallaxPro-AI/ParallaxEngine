/**
 * The outdoors (sdk/parallax/water.pyi, weather.pyi, the environment block in
 * __init__.pyi), read with the runtime's own parsers so check and the game agree:
 *
 *   - each scene's "environment" block, as the environment plugin reads it (PP3220/PP3221/PP3222);
 *   - its "weather" value, as the weather plugin reads it (PP3380), its "sounds" exist (PP2063), and that the game lists
 *     weather() when a scene names one (PP3227);
 *   - every water_body in a prefab, prefab child or scene placement: the rules across fields
 *     (a lake's size, a river's points, wave presets; PP3370);
 *   - every buoyancy: it needs a rigidbody and a collider on the same entity (PP3371).
 */

import { closestMatch, ParallaxError } from '@parallax/runtime/core';
import { readEnvironmentSpec } from '@parallax/runtime/plugins/environment';
import { waterBodyProblems } from '@parallax/runtime/plugins/water';
import { weatherOverrides, weatherProblems } from '@parallax/runtime/plugins/weather';
import { resolvePrefab } from '@parallax/runtime/resource';
import type { JsonObject } from '@parallax/runtime/resource';
import type { CheckContext } from './context.js';

function suggestSound(handle: string, known: readonly string[]): string {
  const guess = closestMatch(handle, known);
  return guess === undefined ? `Add assets/${handle}.<ogg|mp3>.` : `Did you mean "${guess}"?`;
}

function suggestImage(path: string, known: readonly string[]): string {
  const guess = closestMatch(path.replace(/^assets\//, '').replace(/\.[a-z0-9]+$/i, ''), known);
  return guess === undefined ? 'Add the panorama under assets/images/, or use a hosted image URL.' : `Did you mean "assets/${guess}…"?`;
}

type Components = Readonly<Record<string, JsonObject>>;

function pointerTo(base: string, ...parts: (string | number)[]): string {
  return [base, ...parts.map((p) => String(p).replace(/~/g, '~0').replace(/\//g, '~1'))].join('/');
}

function entity(ctx: CheckContext, components: Components, path: string, at: string): void {
  const body = components['water_body'];
  if (body !== undefined) {
    for (const p of waterBodyProblems(body)) {
      ctx.report('PP3370', `water_body: ${p.message}`, { path, pointer: `${pointerTo(at, 'components', 'water_body')}${p.pointer}`, fix: p.fix });
    }
  }
  if (components['buoyancy'] !== undefined && (components['rigidbody'] === undefined || components['collider'] === undefined)) {
    ctx.report('PP3371', 'buoyancy needs a rigidbody and a collider on the same entity (the water pushes the body, shaped by the collider)', {
      path, pointer: pointerTo(at, 'components', 'buoyancy'), fix: 'Add "rigidbody": {"mass": ...} and a "collider" (a box around the hull works best).',
    });
  }
}

function resolved(ctx: CheckContext, id: string | undefined): Components {
  if (id === undefined) return {};
  try {
    return resolvePrefab(ctx.project, id).components;
  } catch {
    return {}; // an unknown base or a cycle: data_checks reports it
  }
}

function merge(base: Components, over: Components): Record<string, JsonObject> {
  const out: Record<string, JsonObject> = { ...base };
  for (const [id, fields] of Object.entries(over)) out[id] = { ...(base[id] ?? {}), ...fields };
  return out;
}

const WATCHED = ['water_body', 'buoyancy', 'rigidbody', 'collider'];

export function checkNature(ctx: CheckContext): void {
  for (const scene of ctx.project.scenes.values()) {
    if (scene.environment === undefined) continue;
    try {
      const skybox = readEnvironmentSpec(scene).skybox;
      const missing = skybox === null ? undefined : ctx.missingAsset('asset/images', skybox.texture);
      if (skybox !== null && missing !== undefined) {
        ctx.report('PP2063', `Scene "${scene.id}" skybox: ${missing.message ?? `no image "${skybox.texture}"`}`, {
          path: scene.path, pointer: '/environment/skybox', fix: missing.fix ?? suggestImage(skybox.texture, missing.known),
        });
      }
    } catch (e) {
      if (!(e instanceof ParallaxError)) throw e;
      ctx.out.push(e.diagnostic);
    }
    const weather = scene.environment['weather'];
    if (weather === undefined) continue;
    if (!ctx.plugins.has('weather')) {
      ctx.report('PP3227', `Scene "${scene.id}" names a weather, but the game doesn't use the weather plugin`, {
        path: scene.path, pointer: '/environment/weather', fix: 'Add weather() to Game(plugins=[...]), or remove "weather".',
      });
    }
    const problems = weatherProblems(weather);
    for (const p of problems) {
      ctx.report('PP3380', `Scene "${scene.id}" weather: ${p.message}`, { path: scene.path, pointer: `/environment/weather${p.pointer}`, fix: p.fix });
    }
    for (const o of weatherOverrides(scene.environment, scene.plugins['wind'])) {
      ctx.report('PP3382', `Scene "${scene.id}": ${o.what} is set, but the scene's weather owns it and replaces the value`, {
        severity: 'warning', path: scene.path, pointer: o.pointer,
        fix: `Remove ${o.what}, or set "${o.key}" in the weather block ({"preset": ..., "${o.key}": ...}) instead.`,
      });
    }
    const sounds = typeof weather === 'object' && weather !== null && !Array.isArray(weather) ? (weather as JsonObject)['sounds'] : undefined;
    if (problems.length > 0 || typeof sounds !== 'object' || sounds === null) continue;
    for (const [key, written] of Object.entries(sounds as JsonObject)) {
      const handle = written as string;
      const missing = ctx.missingAsset('asset/sfx', handle);
      if (missing?.message !== undefined) {
        ctx.report('PP2063', `Scene "${scene.id}" weather: ${missing.message}`, { path: scene.path, pointer: `/environment/weather/sounds/${key}`, fix: missing.fix! });
      } else if (missing !== undefined) {
        ctx.report('PP2063', `Scene "${scene.id}" weather: unknown sound "${written as string}"`, {
          path: scene.path, pointer: `/environment/weather/sounds/${key}`, fix: suggestSound(handle, missing.known),
        });
      }
    }
  }
  for (const prefab of ctx.project.prefabs.values()) {
    const own = resolved(ctx, prefab.id);
    if (own['water_body'] !== undefined || own['buoyancy'] !== undefined) entity(ctx, own, prefab.path, '');
    prefab.children.forEach((child, i) => {
      if (!WATCHED.some((c) => child.components[c] !== undefined)) return;
      const merged = merge(resolved(ctx, child.prefab), child.components);
      if (merged['water_body'] !== undefined || merged['buoyancy'] !== undefined) entity(ctx, merged, prefab.path, `/children/${i}`);
    });
  }
  for (const scene of ctx.project.scenes.values()) {
    scene.entities.forEach((placed, i) => {
      if (!WATCHED.some((c) => placed.components[c] !== undefined)) return;
      const merged = merge(resolved(ctx, placed.prefab), placed.components);
      if (merged['water_body'] !== undefined || merged['buoyancy'] !== undefined) {
        entity(ctx, merged, placed.origin.path, placed.origin.pointer ?? `/entities/${i}`);
      }
    });
  }
}
