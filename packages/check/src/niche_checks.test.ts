/** Softbody and screens data checks, over a real example (read-only) with prefabs added. */

import { beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadProject } from '@parallax/runtime/resource';
import { CheckContext } from './context.js';
import type { Declarations } from './declarations.js';
import { runExtract } from './extract.js';
import { directoryFiles, memoryFiles } from './files.js';
import { checkNiche } from './niche_checks.js';

let base: Record<string, string>;
let declarations: Declarations;

beforeAll(() => {
  const dir = fileURLToPath(new URL('../../../examples/fps_shooter', import.meta.url));
  const tree = directoryFiles(dir);
  base = {};
  for (const path of tree.all()) if (!/\.(png|glb|ogg|mp3|wav)$/.test(path)) base[path] = tree.read(path);
  const extracted = runExtract(dir);
  if (!extracted.ok) throw new Error(extracted.diagnostic.message);
  declarations = extracted.declarations;
});

function found(prefabs: Record<string, unknown>, scene?: unknown[]): string[] {
  const added: Record<string, string> = {};
  for (const [id, components] of Object.entries(prefabs)) added[`prefabs/zz_${id}.prefab.json`] = JSON.stringify({ components });
  if (scene !== undefined) added['scenes/zz_test/scene.json'] = JSON.stringify({ entities: scene });
  const files = memoryFiles({ ...base, ...added });
  const ctx = new CheckContext(files, loadProject(files), declarations, { assetFiles: false });
  checkNiche(ctx);
  return ctx.out.map((d) => `${d.code} ${d.path?.replace(/^prefabs\/zz_|\.prefab\.json$/g, '') ?? ''}${d.pointer ?? ''}`);
}

describe('niche plugin data checks', () => {
  it('passes the example and well-formed data', () => {
    expect(found({
      cape: { cloth: { cols: 4, rows: 4, pinned: [15] } },
      jelly: { soft_body: {} },
    })).toEqual([]);
  });

  it('finds what the plugins would refuse at run time', () => {
    expect(found({
      cape: { cloth: { cols: 4, rows: 4, pinned: [16] } },
      both: { cloth: {}, soft_body: {} },
      jelly: { soft_body: {}, rigidbody: {} },
      tv: { screen: { panel: 'nope', resolution: [8, 4000] } },
    }).sort()).toEqual([
      'PP3312 cape/components/cloth/pinned',
      'PP3310 both/components/soft_body',
      'PP3313 jelly/components/rigidbody',
      'PP2080 tv/components/screen/panel',
      'PP3338 tv/components/screen/resolution',
    ].sort());
  });

  it('judges a placement with its prefab, reporting where the data was written', () => {
    // The prefab alone is fine (a cloth); the placement adds a SoftBody to it.
    const out = found({ flag: { cloth: {} } }, [{ prefab: 'zz_flag', components: { soft_body: {} } }]);
    expect(out).toEqual(['PP3310 scenes/zz_test/scene.json/entities/0/components/soft_body']);
  });
});
