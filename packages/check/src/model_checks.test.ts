/**
 * Model documents in a real example (racing, copied into memory): the document itself,
 * and the names prefabs, children and placements give its joints, options, parts,
 * materials and sockets.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { Diagnostic } from '@parallax/runtime/core';
import { encodeBuffer } from '@parallax/runtime/resource';
import { checkFiles } from './check.js';
import type { Declarations } from './declarations.js';
import { runExtract } from './extract.js';
import { directoryFiles, memoryFiles } from './files.js';

const RACING = fileURLToPath(new URL('../../../examples/racing', import.meta.url));

const KART = {
  format: 'parallax.model',
  version: 1,
  provides: ['vehicle'],
  materials: { body: { color: '#ff0000', metallic: 0, roughness: 0.3 }, tyre: { color: '#111111', metallic: 0, roughness: 0.9 } },
  meshes: { tub: { positions: encodeBuffer('f32', [0, 0, 0, 1, 0, 0, 0, 1, 0]) } },
  parts: [
    { name: 'tub', mesh: 'tub', material: 'body' },
    { name: 'steer_l', position: [-0.7, 0.3, 0.8] },
    { name: 'wheel_l', parent: 'steer_l', shape: 'cylinder', material: 'tyre' },
    { name: 'spoiler', shape: 'box', material: 'body', hidden: true },
  ],
  joints: [{ name: 'steer_l', part: 'steer_l', type: 'hinge', axis: [0, 1, 0], limits: [-34, 34] }],
  sockets: [{ name: 'seat', position: [0, 0.5, 0] }],
  options: [{ name: 'paint', materials: ['body'], default: 'red', choices: { red: {}, blue: { color: '#0000ff' } } }],
};

let files: Record<string, string>;
let declarations: Declarations;

beforeAll(() => {
  const tree = directoryFiles(RACING);
  files = {};
  for (const path of tree.all()) if (!/\.(png|glb|ogg|mp3|wav)$/.test(path)) files[path] = tree.read(path);
  const extracted = runExtract(RACING);
  if (!extracted.ok) throw new Error(extracted.diagnostic.message);
  declarations = extracted.declarations;
});

/** Check racing with the kart as a model document, `edit` applied to car_surge's prefab JSON. */
function run(edit: (prefab: Record<string, any>) => void = () => {}, extra: Record<string, unknown> = {}, kart: unknown = KART, assetFiles = false): readonly Diagnostic[] {
  const prefab = JSON.parse(files['prefabs/car_surge.prefab.json']!) as Record<string, any>;
  prefab['components']['model'] = { model: 'models/kart_surge' };
  // The example's vehicle_rig names its real model's joints, which this kart doesn't have.
  delete prefab['components']['vehicle_rig'];
  edit(prefab);
  const all = {
    ...files,
    'prefabs/car_surge.prefab.json': JSON.stringify(prefab),
    'assets/models/kart_surge.model.json': JSON.stringify(kart),
    ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, JSON.stringify(v)])),
  };
  return checkFiles(memoryFiles(all), structuredClone(declarations), { assetFiles }).diagnostics;
}

const brief = (found: readonly Diagnostic[]): string[] => found.map((d) => `${d.code} ${d.path ?? ''} ${d.pointer ?? ''}`.trim());

describe('model documents', () => {
  it('a clean kart document with joints, options, parts and colors set in data', () => {
    expect(brief(run((p) => {
      p['components']['model'] = {
        model: 'models/kart_surge', joints: { steer_l: 10 }, options: { paint: 'blue' }, parts: { spoiler: true }, colors: { tyre: '#222222' },
      };
    }))).toEqual([]);
  });

  it('report the document\'s own mistakes with its pointers', () => {
    const broken = { ...KART, joints: [{ name: 'steer_l', part: 'stear_l', type: 'hinge', axis: [0, 1, 0] }] };
    expect(brief(run(() => {}, {}, broken))).toEqual(['PP2124 assets/models/kart_surge.model.json /joints/0/part']);
  });

  it('report names the model doesn\'t have, each with a suggestion', () => {
    const found = run((p) => {
      p['components']['model'] = {
        model: 'models/kart_surge', joints: { steer: 10 }, options: { paint: 'green', trim: 'x' }, parts: { spoilr: true }, colors: { chrome: '#ffffff' },
      };
    });
    expect(brief(found)).toEqual([
      'PP2125 prefabs/car_surge.prefab.json /components/model/colors/chrome',
      'PP2121 prefabs/car_surge.prefab.json /components/model/joints/steer',
      'PP2123 prefabs/car_surge.prefab.json /components/model/options/paint',
      'PP2123 prefabs/car_surge.prefab.json /components/model/options/trim',
      'PP2124 prefabs/car_surge.prefab.json /components/model/parts/spoilr',
    ]);
    expect(found.find((d) => d.code === 'PP2121')!.fix).toBe('Did you mean "steer_l"?');
  });

  it('warn on a joint value past its limits (the engine stops it there)', () => {
    const found = run((p) => { p['components']['model']['joints'] = { steer_l: 50 }; });
    expect(found.map((d) => [d.code, d.severity])).toEqual([['PP2129', 'warning']]);
  });

  it('check placements\' model overrides against the prefab\'s model', () => {
    const path = 'scenes/garage/scene.json';
    const scene = JSON.parse(files[path]!) as Record<string, any>;
    scene['entities'].push({ prefab: 'car_surge', components: { model: { options: { paint: 'gold' } } } });
    const found = run(() => {}, { [path]: scene });
    expect(brief(found)).toEqual([`PP2123 ${path} /entities/${scene['entities'].length - 1}/components/model/options/paint`]);
  });

  it('check a child\'s socket against its prefab\'s model', () => {
    const child = (name: string) => (p: Record<string, any>) => {
      p['children'] = [...(p['children'] ?? []), { prefab: 'banner', components: { socket: { name } } }];
    };
    expect(brief(run(child('seat')))).toEqual([]);
    expect(brief(run(child('wheel_l')))).toEqual([]);
    expect(brief(run(child('roof')))).toEqual([`PP2122 prefabs/car_surge.prefab.json /children/${(JSON.parse(files['prefabs/car_surge.prefab.json']!).children ?? []).length}/components/socket/name`]);
  });

  it('a glTF model has no joints or options', () => {
    const found = run((p) => { p['components']['model'] = { model: 'models/kart_surge_glb', joints: { steer_l: 1 }, options: { paint: 'red' } }; },
      { 'assets/models/kart_surge_glb.glb': '' });
    expect(found.map((d) => d.code)).toEqual(['PP2121', 'PP2123']);
  });
});

describe('how a model looks in play', () => {
  const RIGGED = { ...KART, skeleton: { bones: [{ name: 'Hips' }, { name: 'Head', parent: 0, position: [0, 1, 0] }], inverse_bind: encodeBuffer('f32', new Array(32).fill(0)) } };
  const looks = (found: readonly Diagnostic[]): string[] => brief(found.filter((d) => d.code === 'PP2130' || d.code === 'PP2131'));

  it('a rigged model with no animator stands in its bind pose (PP2130, a warning)', () => {
    const found = run(() => {}, {}, RIGGED).filter((d) => d.code === 'PP2130');
    expect(looks(found)).toEqual(['PP2130 prefabs/car_surge.prefab.json /components/model']);
    expect(found[0]!.severity).toBe('warning');
    expect(found[0]!.fix).toContain('parallax library add humanoid_locomotion');
    expect(looks(run((p) => { p['components']['animator'] = {}; }, {}, RIGGED))).toEqual([]);
    // A child's own model, and a quadruped rig's clips piece.
    const quad = { ...RIGGED, skeleton: { ...RIGGED.skeleton, bones: [{ name: 'quad:Hips' }, { name: 'quad:Head', parent: 0 }] } };
    const child = run((p) => {
      p['components']['animator'] = {};
      p['children'] = [...(p['children'] ?? []), { name: 'rider', components: { model: { model: 'models/kart_surge' } } }];
    }, {}, quad).filter((d) => d.code === 'PP2130');
    expect(child.map((d) => d.pointer)).toEqual([`/children/${(JSON.parse(files['prefabs/car_surge.prefab.json']!).children ?? []).length}/components/model`]);
    expect(child[0]!.fix).toContain('quadruped_basics');
    // A prefab nothing names (a library copy the game never uses) isn't drawn.
    const unused = { components: { model: { model: 'assets/models/kart_surge.model.json' } } };
    expect(looks(run((p) => { p['components']['animator'] = {}; }, { 'prefabs/statue.prefab.json': unused }, RIGGED))).toEqual([]);
  });

  it('a rolling body modelled off its collider centre (PP2131, a warning)', () => {
    const ball = (y: number) => ({ ...KART, meshes: {}, joints: [], sockets: [], options: [], parts: [{ name: 'ball', shape: 'sphere', size: [1, 1, 1], position: [0, y, 0], material: 'body' }] });
    const rolling = (extra: (p: Record<string, any>) => void = () => {}) => (p: Record<string, any>) => {
      p['components']['collider'] = { shape: 'sphere', radius: 0.5 };
      extra(p);
    };
    const found = run(rolling(), {}, ball(0.5)).filter((d) => d.code === 'PP2131');
    expect(looks(found)).toEqual(['PP2131 prefabs/car_surge.prefab.json /components/model']);
    expect(found[0]!.severity).toBe('warning');
    expect(found[0]!.fix).toContain('"offset" to [0, -0.5, 0]');
    expect(looks(run(rolling(), {}, ball(0)))).toEqual([]);
    expect(looks(run(rolling((p) => { p['components']['model']['offset'] = [0, -0.5, 0]; }), {}, ball(0.5)))).toEqual([]);
    expect(looks(run(rolling((p) => { p['components']['collider']['offset'] = [0, 0.5, 0]; }), {}, ball(0.5)))).toEqual([]);
    expect(looks(run(rolling((p) => { p['components']['rigidbody']['lock_rotation'] = true; }), {}, ball(0.5)))).toEqual([]);
    // Spinning only about y (a top-down body): a height offset never orbits; one across the floor does.
    const yaw = (p: Record<string, any>) => { p['components']['rigidbody']['lock_rotation_axes'] = ['x', 'z']; };
    expect(looks(run(rolling(yaw), {}, ball(0.5)))).toEqual([]);
    expect(looks(run(rolling((p) => { yaw(p); p['components']['model']['offset'] = [0.4, 0, 0]; }), {}, ball(0.5))))
      .toEqual(['PP2131 prefabs/car_surge.prefab.json /components/model']);
    // A box doesn't roll.
    expect(looks(run(() => {}, {}, ball(0.5)))).toEqual([]);
  });
});

describe('hosted assets (https://r2.parallaxpro.ai/assets/...)', () => {
  const GLB = 'https://r2.parallaxpro.ai/assets/model_character/e9/3e/e93e873bf8ac7981b7b5568eb71ddc4bdd19c7c1441f35be01b45df9a5ff359c.glb';
  const JPG = 'https://r2.parallaxpro.ai/assets/image_texture/4d/91/4d916dfe89c9d2b88bf52e0c70c6a9798a5c29c8c2fcb6ba1ab7b7ded9ef3ed5.jpg';

  it('a model named by URL needs no file, with or without asset files (nothing is fetched)', () => {
    const named = (model: string) => (p: Record<string, any>) => { p['components']['model'] = { model }; };
    expect(brief(run(named(GLB)))).toEqual([]);
    expect(brief(run(named(GLB.replace('r2.', '')))).filter((d) => d.includes('car_surge'))).toEqual([]);
    expect(brief(run(named(GLB), {}, KART, true)).filter((d) => d.includes('car_surge'))).toEqual([]);
  });

  it('a malformed or wrong-kind URL is PP2063 with what is wrong', () => {
    const bad = (model: string) => run((p) => { p['components']['model'] = { model }; }).filter((d) => d.path === 'prefabs/car_surge.prefab.json');
    const host = bad('https://example.com/assets/x.glb');
    expect(host.map((d) => d.code)).toEqual(['PP2063']);
    expect(host[0]!.message).toContain('not a hosted asset URL');
    const kind = bad(JPG);
    expect(kind.map((d) => d.code)).toEqual(['PP2063']);
    expect(kind[0]!.message).toContain('.glb, .gltf, .model.json');
    expect(bad(`${GLB}?v=2`).map((d) => d.code)).toEqual(['PP2063']);
  });

  it('a clip of a hosted model is checked for form only', () => {
    const clip = (ref: string) => (p: Record<string, any>) => {
      p['components']['model'] = { model: GLB };
      p['components']['animator'] = { default_clip: ref };
    };
    expect(brief(run(clip(`${GLB}#Idle`)))).toEqual([]);
    expect(brief(run(clip('https://example.com/x.glb#Idle')))).toEqual(['PP2063 prefabs/car_surge.prefab.json /components/animator/default_clip']);
  });

  it('scene music by URL: an audio file of the store, checked for form', () => {
    const path = 'scenes/garage/scene.json';
    const withMusic = (music: string) => {
      const scene = JSON.parse(files[path]!) as Record<string, any>;
      scene['music'] = music;
      return brief(run(() => {}, { [path]: scene })).filter((d) => d.includes(path));
    };
    expect(withMusic('https://r2.parallaxpro.ai/assets/audio_music/f4/de/f4de9280688d1dae3c50059c52925ae5783ef0103fc0b6dda7256f82bf00f3e3.mp3')).toEqual([]);
    expect(withMusic(JPG)).toEqual([`PP2063 ${path} /music`]);
  });

  it('a model document\'s texture maps: hosted URLs by form, project images must exist', () => {
    const textured = (body: Record<string, unknown>) => ({
      ...KART,
      materials: { ...KART.materials, body: { color: '#ffffff', metallic: 0, roughness: 0.3, ...body } },
      parts: KART.parts.map((part) => (part.name === 'tub' ? { ...part, uv_scale: [2, 2] } : part)),
    });
    const kart = 'assets/models/kart_surge.model.json';
    const found = (body: Record<string, unknown>, assetFiles = false): string[] => brief(run(() => {}, {}, textured(body), assetFiles)).filter((d) => d.includes(kart));
    expect(found({ texture: JPG, normal_map: JPG.replace('r2.', ''), normal_strength: 0.5 })).toEqual([]);
    expect(found({ texture: 'https://example.com/a.png' })).toEqual([`PP2063 ${kart} /materials/body/texture`]);
    expect(found({ texture: GLB })).toEqual([`PP2063 ${kart} /materials/body/texture`]);
    // A project image is looked for only with asset files.
    expect(found({ normal_map: 'assets/images/missing_normal.png' })).toEqual([]);
    expect(found({ normal_map: 'assets/images/missing_normal.png' }, true)).toEqual([`PP2063 ${kart} /materials/body/normal_map`]);
  });
});
