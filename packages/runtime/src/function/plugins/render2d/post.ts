/**
 * The environment's post settings a 2D canvas draws: bloom (glow around what is brighter than
 * `bloom_threshold`, in drawn color 0..1) and vignette. Null when neither would show, so the
 * surface does no work: no bloom strength, a threshold of 1 or more (nothing on a canvas is
 * brighter than white; the default threshold is 1, so 2D games glow only when they set one),
 * and no vignette. The other post keys are 3D-only.
 */

import type { Post2d } from '../../../core/index.js';
import type { PostSettings } from '../../services/index.js';

export function post2d(post: Pick<PostSettings, 'bloom' | 'bloomThreshold' | 'vignette'> | undefined): Post2d | null {
  if (post === undefined) return null;
  const bloom = post.bloomThreshold < 1 ? Math.max(0, post.bloom) : 0;
  const vignette = Math.min(1, Math.max(0, post.vignette));
  if (bloom <= 0 && vignette <= 0) return null;
  return { bloom, bloomThreshold: Math.max(0, post.bloomThreshold), vignette };
}
