import { describe, expect, it } from 'vitest';
import type { MeshBatch, ProjectFiles } from '../../../core/index.js';
import { loadProject } from '../../../resource/index.js';
import { Kernel } from '../../kernel/index.js';
import type { GameDefinition } from '../../kernel/index.js';
import { MemoryBinaryFiles, RecordingSurface3d } from '../../../platform/headless/render3d.js';
import { models } from '../models/index.js';
import { softbody } from '../softbody/index.js';
import { visuals } from '../visuals/index.js';
import { render3d } from './index.js';

const DT = 1 / 60;
const NO_GAME: GameDefinition = { components: [], resources: [], events: [], behaviors: [], systems: [] };

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, typeof v === 'string' ? v : JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

describe('deformable meshes', () => {
  // Regression: a SoftBody's or Cloth's `texture` handle was fetched as written ("images/face"), a 404.
  it('cloth and soft body textures resolve from their handles to the image files', () => {
    const project = files({
      'prefabs/cam.prefab.json': { components: { camera: { fov: 60 } } },
      'prefabs/head.prefab.json': { components: { soft_body: { texture: 'images/face', gravity_scale: 0 } } },
      'prefabs/flag.prefab.json': { components: { cloth: { texture: 'images/flag' } } },
      'scenes/main/scene.json': { entities: [{ prefab: 'cam', at: [0, 1, -4] }, { prefab: 'head', at: [0, 1, 0] }, { prefab: 'flag', at: [2, 2, 0] }] },
      'assets/images/face.png': '',
      'assets/images/flag.png': '',
    });
    const loaded = loadProject(project);
    expect(loaded.diagnostics).toEqual([]);
    const surface = new RecordingSurface3d();
    const kernel = new Kernel({
      project: loaded, game: NO_GAME, context: {}, fixedStep: DT,
      plugins: [visuals({ dimension: '3d' }), models({ files: project, binary: new MemoryBinaryFiles({}) }), softbody(), render3d({ surface, files: project })],
    });
    kernel.start('main');
    kernel.step(DT);
    const paths = surface.last!.meshes
      .map((m: MeshBatch) => m.material.baseColorTexture?.source)
      .filter((s) => s !== undefined && s !== null && s.kind === 'file')
      .map((s) => (s as { path: string }).path)
      .sort();
    expect(paths).toEqual(['assets/images/face.png', 'assets/images/flag.png']);
  });
});
