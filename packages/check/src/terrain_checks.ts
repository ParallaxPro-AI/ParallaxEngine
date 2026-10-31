/**
 * Scene ground data (sdk/parallax/terrain.pyi, foliage.pyi, wind.pyi): each scene's
 * `"terrain"`, `"foliage"` and `"wind"` blocks read exactly as their plugins read them
 * (the same errors, with pointers), plus what only the whole project can tell:
 *
 *   - a block whose plugin the game doesn't list (PP3209, error: it would be ignored)
 *   - foliage `on` / `avoid` names the scene's terrain doesn't have, or terrain filters
 *     in a scene with no terrain (PP3230)
 *   - texture and model files that aren't in the project (PP3207, when files are checked)
 */

import { closestMatch, isAssetUrl, ParallaxError, remoteAssetProblem } from '@parallax/runtime/core';
import type { SceneDoc } from '@parallax/runtime/resource';
import { readTerrainSpec } from '@parallax/runtime/plugins/terrain';
import type { TerrainSpec } from '@parallax/runtime/plugins/terrain';
import { readFoliageSpec } from '@parallax/runtime/plugins/foliage';
import { readWindSpec } from '@parallax/runtime/plugins/wind';
import type { CheckContext } from './context.js';

function attempt<T>(ctx: CheckContext, read: () => T): T | undefined {
  try {
    return read();
  } catch (e) {
    if (e instanceof ParallaxError) {
      ctx.out.push(e.diagnostic);
      return undefined;
    }
    throw e;
  }
}

function needsPlugin(ctx: CheckContext, scene: SceneDoc, block: string, plugin: string): void {
  if (scene.plugins[block] === undefined || ctx.plugins.has(plugin)) return;
  ctx.report('PP3209', `Scene "${scene.id}" has a "${block}" block, but the game doesn't use the ${plugin} plugin`, {
    path: scene.path, pointer: `/${block}`, fix: `Add ${plugin}() to Game(plugins=[...]), or remove the "${block}" block.`,
  });
}

function fileExists(ctx: CheckContext, scene: SceneDoc, file: string, pointer: string, what: string): void {
  if (isAssetUrl(file)) {
    // A hosted asset: its form only (nothing is fetched).
    const problem = remoteAssetProblem(file);
    if (problem !== undefined) ctx.report('PP3207', `Scene "${scene.id}" ${what}: ${problem}`, { path: scene.path, pointer, fix: 'Use a hosted asset URL (https://r2.parallaxpro.ai/assets/…) or a project file under assets/.' });
    return;
  }
  if (!ctx.options.assetFiles) return;
  // A file path ("assets/textures/rock.png") or, as foliage models are written, a handle ("models/rock").
  if (ctx.assets.has(file) || [...ctx.assets.values()].includes(file)) return;
  const guess = closestMatch(file, file.startsWith('assets/') ? [...ctx.assets.values()] : [...ctx.assets.keys()]);
  ctx.report('PP3207', `Scene "${scene.id}" ${what} "${file}" is not in the project`, {
    path: scene.path, pointer, fix: guess === undefined ? 'Add the file under assets/, or fix the path.' : `Did you mean "${guess}"?`,
  });
}

export function checkTerrain(ctx: CheckContext): void {
  for (const scene of ctx.project.scenes.values()) {
    needsPlugin(ctx, scene, 'terrain', 'terrain');
    needsPlugin(ctx, scene, 'foliage', 'foliage');
    needsPlugin(ctx, scene, 'wind', 'wind');
    let terrain: TerrainSpec | undefined;
    if (scene.plugins['terrain'] !== undefined) {
      terrain = attempt(ctx, () => readTerrainSpec(scene));
      terrain?.layers.forEach((layer, i) => {
        if (layer.texture !== null) fileExists(ctx, scene, layer.texture, `/terrain/layers/${i}/texture`, `terrain layer "${layer.name}" texture`);
        if (layer.normal !== null) fileExists(ctx, scene, layer.normal, `/terrain/layers/${i}/normal`, `terrain layer "${layer.name}" normal map`);
        if (layer.detail !== null) fileExists(ctx, scene, layer.detail.texture, `/terrain/layers/${i}/detail/texture`, `terrain layer "${layer.name}" detail texture`);
      });
    }
    if (scene.plugins['wind'] !== undefined) attempt(ctx, () => readWindSpec(scene));
    if (scene.plugins['foliage'] === undefined) continue;
    const layers = attempt(ctx, () => readFoliageSpec(scene));
    if (layers === undefined) continue;
    const names = terrain?.layers.map((l) => l.name) ?? [];
    layers.forEach((layer, i) => {
      const at = `/foliage/layers/${i}`;
      if (layer.model !== null) fileExists(ctx, scene, layer.model, `${at}/model`, `foliage layer "${layer.id}" model`);
      if (scene.plugins['terrain'] === undefined) {
        if (layer.layers.length > 0 || layer.avoid.length > 0) {
          ctx.report('PP3230', `Scene "${scene.id}" foliage layer "${layer.id}" grows on terrain layers, but the scene has no terrain`, {
            path: scene.path, pointer: `${at}/${layer.layers.length > 0 ? 'on' : 'avoid'}`, fix: 'Add a "terrain" block, or give the layer an "area" instead.',
          });
        } else if (layer.area === null) {
          ctx.report('PP3230', `Scene "${scene.id}" foliage layer "${layer.id}" has no "area" and the scene has no terrain`, {
            path: scene.path, pointer: at, fix: 'Give the layer an "area" footprint, or add a terrain.',
          });
        }
        return;
      }
      if (terrain === undefined) return;
      for (const [key, list] of [['on', layer.layers], ['avoid', layer.avoid]] as const) {
        for (const name of list) {
          if (names.includes(name)) continue;
          const guess = closestMatch(name, names);
          ctx.report('PP3230', `Scene "${scene.id}" foliage layer "${layer.id}": "${name}" is not one of the terrain's layers`, {
            path: scene.path, pointer: `${at}/${key}`, fix: guess === undefined ? `Use one of: ${names.join(', ')}.` : `Did you mean "${guess}"?`,
          });
        }
      }
    });
  }
}
