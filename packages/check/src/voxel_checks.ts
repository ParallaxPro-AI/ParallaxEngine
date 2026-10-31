/**
 * Blocks (sdk/parallax/voxels.pyi `BlockDef`) — what the voxels plugin raises when it reads
 * the block table, found before the game runs:
 *
 *   texture   neither a path string nor {"side", "top", "bottom"} paths with "side" given (PP3622)
 *
 * `texture` is `str | BlockTextures`, which the field schemas carry as json, so its shape is
 * judged here by the plugin's own reader.
 */

import { readBlockTexture } from '@parallax/runtime/plugins/voxels';
import type { CheckContext } from './context.js';

export function checkVoxels(ctx: CheckContext): void {
  for (const entry of ctx.project.content.get('block')?.values() ?? []) {
    const faces = readBlockTexture(entry.values['texture']);
    if (typeof faces !== 'string') continue;
    ctx.report('PP3622', `content/block/${entry.id}.json: "texture" must be ${faces}`, {
      path: entry.path, pointer: '/texture',
      fix: 'Write "texture" as one image handle ("images/<name>"), or {"side": image, "top": image, "bottom": image} (sdk/parallax/voxels.pyi BlockTextures).',
    });
  }
}
