/**
 * Effect files (`assets/vfx/<name>.vfx.json`) through the parser the game's renderer uses
 * (render2d's in a 2D game, render3d's otherwise), so check reports what the game would
 * fail with at run time: unknown keys, bad values and ranges, images that don't exist
 * (with asset files) — the renderer's own codes and messages. Both read the one `.vfx.json`
 * schema (runtime core VFX_KEYS; a 2D game ignores the 3D-only keys) and report PP3808. A
 * 3D effect's `sound` must be a sound in assets/sfx/ ("sfx/<name>") or a built-in
 * ("synth/<name>").
 */

import { ParallaxError } from '@parallax/runtime/core';
import type { ProjectFiles } from '@parallax/runtime/core';
import { AssetCatalog2d, parseEffect as parseEffect2d } from '@parallax/runtime/plugins/render2d';
import { parseEffect as parseEffect3d } from '@parallax/runtime/plugins/render3d';
import { AssetCatalog } from '@parallax/runtime/resource';
import type { CheckContext } from './context.js';

const VFX_FILE = /^assets\/vfx\/[^/]+\.vfx\.json$/;

export function checkEffects(ctx: CheckContext): void {
  const paths = ctx.files.all().filter((p) => VFX_FILE.test(p));
  if (paths.length === 0) return;
  const files: ProjectFiles = { list: () => ctx.files.all(), read: (p) => ctx.files.read(p) };
  const assetFiles = ctx.options.assetFiles;
  const parse = ctx.decl.game?.mode === '2d'
    ? ((catalog) => (path: string, text: string) => parseEffect2d(path, text, catalog))(new AssetCatalog2d(files, assetFiles))
    : ((catalog) => (path: string, text: string) => parseEffect3d(path, text, catalog))(new AssetCatalog(files, assetFiles));
  for (const path of paths) {
    try {
      // A 3D effect's sound is played by the audio plugin: it must be a sound in assets/sfx/.
      const sound = (parse(path, ctx.files.read(path)) as { readonly sound?: string | null }).sound;
      if (typeof sound === 'string' && ctx.missingAsset('asset/sfx', sound) !== undefined) {
        ctx.report('PP2063', `${path}: "sound" names "${sound}", which is not a sound in assets/sfx/ or a built-in synth sound`, { path, fix: 'Add the sound under assets/sfx/, or fix the name.' });
      }
    } catch (e) {
      if (!(e instanceof ParallaxError)) throw e;
      const d = e.diagnostic;
      ctx.report(d.code, d.message, { path, ...(d.fix !== undefined && { fix: d.fix }) });
    }
  }
}
