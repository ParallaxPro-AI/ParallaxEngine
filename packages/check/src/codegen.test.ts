import { beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { checkFiles } from './check.js';
import type { Declarations } from './declarations.js';
import { runExtract } from './extract.js';
import { directoryFiles, memoryFiles } from './files.js';

const BRICK = fileURLToPath(new URL('../../../examples/brick_breaker', import.meta.url));

let files: Record<string, string>;
let declarations: Declarations;

beforeAll(() => {
  const tree = directoryFiles(BRICK);
  files = Object.fromEntries(tree.all().map((p) => [p, tree.read(p)]));
  const extracted = runExtract(BRICK);
  if (!extracted.ok) throw new Error(extracted.diagnostic.message);
  declarations = extracted.declarations;
});

const KNIGHT = JSON.stringify({ asset: { version: '2.0' }, animations: [{ name: 'run' }, { name: 'idle' }] });

function generate(extra: Record<string, string> = {}, assetFiles = false, base = files) {
  return checkFiles(memoryFiles({ ...base, ...extra }), structuredClone(declarations), { assetFiles });
}

/** The example without its assets/ (it ships every file it references), for missing-asset cases. */
const bare = (): Record<string, string> => Object.fromEntries(Object.entries(files).filter(([path]) => !path.startsWith('assets/')));

describe('the project module', () => {
  it('names every prefab, scene, content entry, text key and asset as handles (JS)', () => {
    const { js } = generate({ 'assets/sfx/brick_zap.ogg': '', 'assets/models/knight.gltf': KNIGHT }).project!;
    expect(js).toContain("import { assetRef, clipRef, contentRef, dialogueRef, placedRef, prefabRef, sceneRef, textRef, worldLayerRef } from 'parallax/__project__';");
    expect(js).toContain('export const Prefabs = Object.freeze({\n  ball: prefabRef("ball"),');
    expect(js).toContain('export const Scenes = Object.freeze({\n  arena: sceneRef("arena"),\n  title: sceneRef("title"),\n});');
    expect(js).toContain('    core: contentRef("stage", "core"),');
    expect(js).toContain('  best: textRef("best"),');
    expect(js).toContain('  sfx: Object.freeze({\n    brick_zap: assetRef("sound", "sfx/brick_zap"),');
    expect(js).toContain('knight: assetRef("model", "models/knight", ["run","idle"])');
    // The ids arena gives the placements its title scene excludes ("extends" + "exclude").
    expect(js).toContain('export const Placed = Object.freeze({\n  wall: placedRef("wall"),\n  paddle: placedRef("paddle"),\n  ball: placedRef("ball"),\n});');
    // Automatic keys for Localized content fields: Content entries' text, e.g. upgrade.wide.name. (The stages'
    // keys are quiet since the locale gained a plain "stage" key, which a `Text.stage` namespace would shadow.)
    expect(js).toContain('    wide: Object.freeze({\n      description: textRef("upgrade.wide.description"),\n      name: textRef("upgrade.wide.name"),');
  });

  it('writes a matching stub for pyright', () => {
    const { pyi } = generate({ 'assets/models/knight.gltf': KNIGHT }).project!;
    expect(pyi).toContain('from game.content import StageDef, UpgradeDef');
    // No SoundRef / MusicRef: the example's sounds and music are hosted URLs (config/audio.json cues, the arena's "music").
    expect(pyi).toContain('from parallax import ClipRef, ContentRef, EffectRef, EntityRef, ModelRef, PrefabRef, SceneRef, TextRef');
    expect(pyi).toContain('class Prefabs:\n    ball: ClassVar[PrefabRef]');
    expect(pyi).toContain('    class stage:\n        cascade: ClassVar[ContentRef[StageDef]]');
    expect(pyi).toContain('class _Assets_models_knight(ModelRef):\n    class clips:\n        run: ClassVar[ClipRef]\n        idle: ClassVar[ClipRef]');
    expect(pyi).toContain('    class models:\n        knight: ClassVar[_Assets_models_knight]');
    expect(pyi).toContain('class Placed:\n    wall: ClassVar[EntityRef]\n    paddle: ClassVar[EntityRef]\n    ball: ClassVar[EntityRef]');
  });

  it('takes music as a handle, and gives the handle to write for a file path or a bare name (PP2063)', () => {
    const scene = (music: string): Record<string, string> => ({
      'scenes/arena/scene.json': JSON.stringify({ ...JSON.parse(files['scenes/arena/scene.json']!), music }),
    });
    const music = (extra: Record<string, string>) => generate(extra, true).diagnostics.filter((d) => d.pointer === '/music');
    expect(music({ ...scene('music/level_bright'), 'assets/music/level_bright.ogg': '' })).toEqual([]);
    expect(music(scene('music/level_bright')).map((d) => d.fix)).toEqual([expect.stringContaining('Add assets/music/level_bright.<ogg|mp3>,')]);
    expect(music({ ...scene('assets/music/level_bright.ogg'), 'assets/music/level_bright.ogg': '' }).map((d) => [d.code, d.fix]))
      .toEqual([['PP2063', expect.stringContaining('Write "music/level_bright"')]]);
    expect(music(scene('level_bright')).map((d) => [d.code, d.fix])).toEqual([['PP2063', expect.stringContaining('Write "music/level_bright"')]]);
  });

  it('reads effect files with the renderer\'s own parser (unknown keys, bad values)', () => {
    const vfx = (doc: unknown) => generate({ 'assets/vfx/zz_puff.vfx.json': JSON.stringify(doc) }).diagnostics
      .filter((d) => d.path === 'assets/vfx/zz_puff.vfx.json').map((d) => `${d.code} ${d.message}`);
    expect(vfx({ burst: 8, lifetime: 0.4 })).toEqual([]);
    expect(vfx({ burst: 8, offset: [0, 1, 0] })).toEqual([expect.stringMatching(/^PP3808 .*unknown key "offset"/)]);
    expect(vfx({ burst: -1 })).toEqual([expect.stringMatching(/^PP3808 .*"burst"/)]);
    // 3D: a built-in to extend, a sound that must exist (with asset files checked).
    expect(vfx({ extends: 'effect/explosion', flipbook: 'fire', children: ['effect/sparks'] })).toEqual([]);
    expect(vfx({ extends: 'effect/boom' })).toEqual([expect.stringMatching(/^PP3808 .*not a built-in effect/)]);
    const sounds = (doc: unknown) => generate({ 'assets/vfx/zz_puff.vfx.json': JSON.stringify(doc) }, true).diagnostics
      .filter((d) => d.path === 'assets/vfx/zz_puff.vfx.json').map((d) => d.code);
    expect(sounds({ extends: 'effect/explosion', sound: 'sfx/no_such_boom' })).toEqual(['PP2063']);
  });

  it('accepts built-in effects in data, and names the built-ins for an unknown one', () => {
    const prefab = (effect: string) => generate({ 'prefabs/zz_fire.prefab.json': JSON.stringify({ components: { particles: { effect } } }) }, true)
      .diagnostics.filter((d) => d.path === 'prefabs/zz_fire.prefab.json');
    expect(prefab('effect/fire')).toEqual([]);
    expect(prefab('effect/bonfire').map((d) => d.code)).toEqual(['PP2063']);
  });

  it('checks asset files when asked to', () => {
    const missing = generate({}, true, bare()).diagnostics.filter((d) => d.code === 'PP2063');
    expect(missing.length).toBeGreaterThan(0);
    expect(missing.every((d) => d.path === 'scenes/arena/scene.json' || d.path!.startsWith('game/'))).toBe(true);
    expect(generate({}, false).diagnostics).toEqual([]);
  });

  it('without asset files, generates handles for every asset the data and code reference', () => {
    // Code: ctx.vfx.play(Assets.vfx.sparks) (the example's own), and ctx.audio.play(Assets.sfx.orb_launch) and the
    // arena's "music": "music/prism_run" added here (the example's sounds and music are hosted URLs since the parity pass).
    const scene = JSON.stringify({ ...JSON.parse(files['scenes/arena/scene.json']!), music: 'music/prism_run' });
    const decl = structuredClone(declarations);
    const withRefs: Declarations = {
      ...decl, project_refs: [...decl.project_refs, { ref: ['Assets', 'sfx', 'orb_launch'], path: 'game/systems/feedback.py', line: 20, column: 8 }],
    };
    const gen = (extra: Record<string, string>) => checkFiles(memoryFiles({ ...bare(), 'scenes/arena/scene.json': scene, ...extra }), structuredClone(withRefs),
      { assetFiles: false }).project!;
    const { js, pyi } = gen({});
    expect(js).toContain('orb_launch: assetRef("sound", "sfx/orb_launch")');
    expect(js).toContain('sparks: assetRef("effect", "vfx/sparks")');
    expect(js).toContain('prism_run: assetRef("music", "music/prism_run")');
    expect(pyi).toContain('orb_launch: ClassVar[SoundRef]');
    // A file that exists is generated once, from the file.
    const withFile = gen({ 'assets/sfx/orb_launch.ogg': '' }).js;
    expect(withFile.match(/orb_launch:/g)).toHaveLength(1);
  });

  it('without asset files, a referenced model gets the clips the code reads', () => {
    const code = 'from project import Assets\n\ndef clip():\n    return Assets.models.knight.clips.run\n';
    const base = structuredClone(declarations);
    const decl: Declarations = {
      ...base, project_refs: [...base.project_refs, { ref: ['Assets', 'models', 'knight', 'clips', 'run'], path: 'game/clip.py', line: 4, column: 11 }],
    };
    const result = checkFiles(memoryFiles({ ...files, 'game/clip.py': code }), decl, { assetFiles: false });
    expect(result.diagnostics).toEqual([]);
    expect(result.project!.js).toContain('knight: assetRef("model", "models/knight", ["run"])');
  });

  it('with asset files checked, referenced but missing assets get no handle', () => {
    const { js } = generate({}, true, bare()).project!;
    expect(js).not.toContain('orb_launch');
  });
});
