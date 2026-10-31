import { describe, expect, it } from 'vitest';
import { Color, ParallaxError, Quat, Vec3 } from '../../../core/index.js';
import type { EntityId, Frame3d, ProjectFiles } from '../../../core/index.js';
import { encodeBuffer, loadProject, parseModelDocument } from '../../../resource/index.js';
import type { ModelDocument } from '../../../resource/index.js';
import { MemoryBinaryFiles, RecordingSurface3d } from '../../../platform/headless/render3d.js';
import { attachToSocket, leaveSocket } from '../../../api/model_sockets.js';
import { Kernel } from '../../kernel/index.js';
import type { EntityRecord, Fields, GameDefinition } from '../../kernel/index.js';
import { MODEL_GEOMETRY_SERVICE, MODEL_RIG_SERVICE } from '../../services/index.js';
import { visuals } from '../visuals/index.js';
import { nodeMatrices, restPose } from '../../../resource/index.js';
import { buildCodeModel } from '../../../resource/index.js';
import { applyJoints, jointValues, LookMaterials, lookOf, socketMatrix } from '../../../resource/index.js';
import { modelGeometry } from './geometry.js';
import { render3d } from '../render3d/index.js';
import { models } from './index.js';
import type { Render3dPlugin } from '../render3d/index.js';
import { transformPoint } from '../../../resource/index.js';

const DT = 1 / 60;

const TRI = { positions: encodeBuffer('f32', [0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: encodeBuffer('u16', [0, 1, 2]) };

/** A small kart: a body, a steered wheel that spins, a liftable chassis, a hood, a seat and a paint option. */
const KART = {
  format: 'parallax.model',
  version: 1,
  materials: {
    body: { color: '#ff0000', metallic: 0, roughness: 0.3, clearcoat: 1, clearcoat_roughness: 0.05 },
    tyre: { color: [0.1, 0.1, 0.1], metallic: 0, roughness: 0.9 },
  },
  meshes: { tub: TRI },
  parts: [
    { name: 'chassis' },
    { name: 'tub', parent: 'chassis', mesh: 'tub', material: 'body', size: [2, 1, 1] },
    { name: 'spoiler', parent: 'chassis', shape: 'box', material: 'body', position: [0, 1, -1], hidden: true },
    { name: 'steer_l', position: [-1, 0.3, 1] },
    { name: 'spin_l', parent: 'steer_l' },
    { name: 'wheel_l', parent: 'spin_l', shape: 'cylinder', size: [0.6, 0.3, 0.6], material: 'tyre', position: [0.2, 0, 0] },
    { name: 'hood', parent: 'chassis', position: [0, 0.5, 1] },
    { name: 'hood_panel', parent: 'hood', shape: 'box', size: [1, 0.05, 0.8], material: 'body', position: [0, 0, -0.4] },
    { name: 'antenna', parent: 'chassis', shape: 'capsule', size: [0.1, 0.5, 0.1], material: 'tyre', cast_shadows: false },
  ],
  joints: [
    { name: 'steer_l', part: 'steer_l', type: 'hinge', axis: [0, 1, 0], limits: [-30, 30], duration: 0.25 },
    { name: 'spin_l', part: 'spin_l', type: 'hinge', axis: [1, 0, 0] },
    { name: 'hood', part: 'hood', type: 'hinge', kind: 'aperture', axis: [1, 0, 0], limits: [0, 80], default: 10, duration: 1 },
    { name: 'lift', part: 'chassis', type: 'slider', axis: [0, 1, 0], limits: [0, 0.2] },
    { name: 'grow', part: 'tub', type: 'scale', axis: [0, 1, 0], limits: [0.5, 2] },
  ],
  sockets: [
    { name: 'seat', parent: 'chassis', position: [0, 0.6, 0], accepts: ['driver'], limit: 1 },
    { name: 'exhaust', position: [0, 0.3, -1.2], kind: 'exhaust' },
  ],
  options: [
    { name: 'paint', materials: ['body'], default: 'red', choices: { red: { color: '#ff0000' }, blue: { color: '#0000ff', roughness: 0.6 } } },
    { name: 'aero', parts: ['spoiler'], default: 'none', choices: { none: [], wing: ['spoiler'] } },
  ],
};

const DRIVER = {
  format: 'parallax.model', version: 1, provides: ['driver'],
  materials: { suit: { color: '#2040a0', metallic: 0, roughness: 0.8 } },
  parts: [{ name: 'torso', shape: 'box', size: [0.4, 0.6, 0.3], material: 'suit' }],
};

function doc(json: unknown = KART, path = 'assets/models/kart.model.json'): ModelDocument {
  const parsed = parseModelDocument(path, JSON.stringify(json));
  expect(parsed.diagnostics).toEqual([]);
  return parsed.document!;
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof ParallaxError) return e.diagnostic.code;
    throw e;
  }
  return 'no error';
}

const origin = (worlds: Float32Array, node: number): [number, number, number] => transformPoint(worlds.subarray(node * 16, node * 16 + 16), 0, 0, 0);
const close3 = (a: readonly number[], b: readonly number[]): void => a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, 5));

describe('model documents as ModelAssets', () => {
  const model = buildCodeModel(doc());
  const part = (name: string): number => model.code!.partNode[model.code!.document.partByName.get(name)!]!;

  it('lay parts out as nodes, each drawn part\'s mesh on its own child node scaled by its size', () => {
    expect(model.nodes[part('tub')]!.parent).toBe(part('chassis'));
    const leaf = model.nodes[part('tub')]!.children.map((c) => model.nodes[c]!).find((n) => n.mesh !== null)!;
    expect(leaf.scale).toEqual([2, 1, 1]);
    expect(leaf.name).toBe('');
    expect(model.meshes[leaf.mesh!]![0]!.geometry.id).toBe('assets/models/kart.model.json#mesh:tub');
    const wheel = model.nodes[part('wheel_l')]!.children.map((c) => model.nodes[c]!)[0]!;
    expect(model.meshes[wheel.mesh!]![0]!.geometry.id).toBe('shape:cylinder');
    const antenna = model.nodes[part('antenna')]!.children.map((c) => model.nodes[c]!)[0]!;
    expect(model.meshes[antenna.mesh!]![0]!.geometry.id).toBe('shape:capsule:0.05:0.5');
    expect(model.order[0]).toBe(part('chassis'));
    expect(model.nodeByName.get('hood')).toBe(part('hood'));
    expect(model.clips.size).toBe(0);
  });

  it('give each named material one Material3d, layers included', () => {
    const tub = model.meshes.flat().find((p) => p.geometry.id.endsWith('#mesh:tub'))!;
    expect(tub.materialName).toBe('body');
    expect(tub.material).toMatchObject({ id: 'assets/models/kart.model.json#material:body', baseColor: [1, 0, 0, 1], roughness: 0.3, alphaMode: 'opaque' });
    expect(tub.material.layers).toMatchObject({ clearcoat: 1, clearcoatRoughness: 0.05, transmission: 0 });
    const tyre = model.meshes.flat().find((p) => p.materialName === 'tyre')!;
    expect(tyre.material.layers).toBeUndefined();
    expect(new Set(model.meshes.flat().filter((p) => p.materialName === 'body').map((p) => p.material)).size).toBe(1);
  });

  it('turn a hinge about its axis around the part\'s own origin, children following', () => {
    const rest = nodeMatrices(model, restPose(model));
    const values = jointValues(model.code!.document, { joints: { steer_l: 90, hood: 0 } }, 0, 'kart');
    const posed = applyJoints(model, rest, values);
    expect(posed).not.toBe(rest);
    close3(origin(posed, part('steer_l')), [-1, 0.3, 1]);
    // The wheel sits 0.2 along the steer's +x and swings with it (90 is clamped to the 30° limit).
    const half = (30 * Math.PI) / 360;
    const q = new Quat(0, Math.sin(half), 0, Math.cos(half)).rotate(new Vec3(0.2, 0, 0));
    close3(origin(posed, part('wheel_l')), [-1 + q.x, 0.3 + q.y, 1 + q.z]);
    // Clamped to the limits: 90 is 30.
    const clamped = jointValues(model.code!.document, { joints: { steer_l: 90 } }, 0, 'kart');
    expect([...clamped.values()][0]).toBe(30);
  });

  it('nest joints: a spin under a steer turns about the steered axis', () => {
    const rest = nodeMatrices(model, restPose(model));
    const both = applyJoints(model, rest, jointValues(model.code!.document, { joints: { steer_l: 30, spin_l: 45, hood: 0 } }, 0, 'kart'));
    // Same as a part authored with those rotations: steer about y, then spin about the steered x.
    const turned = {
      ...KART,
      parts: KART.parts.map((p) => p.name === 'steer_l' ? { ...p, rotation: quat([0, 1, 0], 30) }
        : p.name === 'spin_l' ? { ...p, rotation: quat([1, 0, 0], 45) } : p),
    };
    const authored = buildCodeModel(doc(turned));
    const authoredWorlds = applyJoints(authored, nodeMatrices(authored, restPose(authored)), jointValues(authored.code!.document, { joints: { hood: 0 } }, 0, 'k'));
    close3(origin(both, part('wheel_l')), origin(authoredWorlds, part('wheel_l')));
    close3([...both.subarray(part('wheel_l') * 16, part('wheel_l') * 16 + 12)], [...authoredWorlds.subarray(part('wheel_l') * 16, part('wheel_l') * 16 + 12)]);
  });

  it('slide and scale parts; a joint at its zero point changes nothing', () => {
    const rest = nodeMatrices(model, restPose(model));
    const values = jointValues(model.code!.document, { joints: { lift: 0.15, grow: 2, hood: 0 } }, 0, 'kart');
    const posed = applyJoints(model, rest, values);
    close3(origin(posed, part('hood')), [0, 0.65, 1]);
    const tubLeaf = model.nodes[part('tub')]!.children[0]!;
    // The tub's mesh node is scaled 2 by its size and 2 by the joint along y.
    expect(posed[tubLeaf * 16 + 5]).toBeCloseTo(2);
    expect(posed[tubLeaf * 16 + 0]).toBeCloseTo(2);
    const still = applyJoints(model, rest, jointValues(model.code!.document, { joints: { hood: 0 } }, 0, 'kart'));
    expect(still).toBe(rest);
  });

  it('check joint names, including the ones in joint_motion', () => {
    expect(code(() => jointValues(model.code!.document, { joints: { steer: 1 } }, 0, 'kart'))).toBe('PP2121');
    expect(code(() => jointValues(model.code!.document, { joint_motion: { nope: { start_value: 0, start_time: 0, seconds: 1 } } }, 0, 'kart'))).toBe('PP2121');
  });

  it('look: options, shown parts and colors, every name checked', () => {
    const spoilerLeaf = model.nodes[part('spoiler')]!.children[0]!;
    expect(lookOf(model, {}, 'kart').hidden![spoilerLeaf]).toBe(1);
    expect(lookOf(model, { options: { aero: 'wing' } }, 'kart').hidden?.[spoilerLeaf] ?? 0).toBe(0);
    const noHood = lookOf(model, { parts: { hood: false } }, 'kart').hidden!;
    expect(noHood[model.nodes[part('hood_panel')]!.children[0]!]).toBe(1);
    expect(code(() => lookOf(model, { options: { paint: 'green' } }, 'kart'))).toBe('PP2123');
    expect(code(() => lookOf(model, { options: { color: 'red' } }, 'kart'))).toBe('PP2123');
    expect(code(() => lookOf(model, { parts: { hub: true } }, 'kart'))).toBe('PP2124');
    expect(code(() => lookOf(model, { colors: { paint: Color.WHITE } }, 'kart'))).toBe('PP2125');
    expect(code(() => lookOf(model, { colors: { body: '#fff' } }, 'kart'))).toBe('PP3800');
  });

  it('make per-look materials once, so surfaces keep their GPU copies', () => {
    const materials = new LookMaterials();
    const tub = model.meshes.flat().find((p) => p.geometry.id.endsWith('#mesh:tub'))!;
    expect(materials.of(model, tub, lookOf(model, {}, 'kart'))).toBe(tub.material);
    const blue = materials.of(model, tub, lookOf(model, { options: { paint: 'blue' } }, 'kart'));
    expect(blue).toMatchObject({ baseColor: [0, 0, 1, 1], roughness: 0.6 });
    expect(blue.layers?.clearcoat).toBe(1);
    expect(materials.of(model, tub, lookOf(model, { options: { paint: 'blue' } }, 'kart'))).toBe(blue);
    const recolored = materials.of(model, tub, lookOf(model, { colors: { body: new Color(0, 1, 0) } }, 'kart'));
    expect(recolored.baseColor).toEqual([0, 1, 0, 1]);
    expect(recolored.id).not.toBe(tub.material.id);
  });

  it('pose sockets with the model: declared, on a part, and parts or bones by name', () => {
    const rest = nodeMatrices(model, restPose(model));
    close3(transformPoint(socketMatrix(model, rest, 'seat', 'kart'), 0, 0, 0), [0, 0.6, 0]);
    const lifted = applyJoints(model, rest, jointValues(model.code!.document, { joints: { lift: 0.2, hood: 0 } }, 0, 'kart'));
    close3(transformPoint(socketMatrix(model, lifted, 'seat', 'kart'), 0, 0, 0), [0, 0.8, 0]);
    close3(transformPoint(socketMatrix(model, lifted, 'exhaust', 'kart'), 0, 0, 0), [0, 0.3, -1.2]);
    close3(transformPoint(socketMatrix(model, lifted, 'hood', 'kart'), 0, 0, 0), [0, 0.7, 1]);
    expect(code(() => socketMatrix(model, rest, 'roof', 'kart'))).toBe('PP2122');
  });

  it('give physics the default look: hidden parts left out, joints at their defaults', () => {
    const geometry = modelGeometry(model);
    const triangles = geometry.indices.length / 3;
    const visible = model.order.filter((n) => model.nodes[n]!.mesh !== null).length;
    expect(triangles).toBeGreaterThan(0);
    // The spoiler (a 12-triangle box) is hidden by default.
    const spoiler = buildCodeModel(doc({ ...KART, options: [{ ...KART.options[1]!, default: 'wing' }] }));
    expect(modelGeometry(spoiler).indices.length / 3 - triangles).toBe(12);
    expect(visible).toBe(5);
    // The hood opens 10° by default: its panel's far edge is lifted off the hinge line.
    const ys = [...geometry.vertices].filter((_, i) => i % 3 === 1);
    expect(Math.max(...ys)).toBeGreaterThan(0.5 + 0.025);
  });
});

function quat(axis: readonly number[], degrees: number): number[] {
  const h = (degrees * Math.PI) / 360;
  return [axis[0]! * Math.sin(h), axis[1]! * Math.sin(h), axis[2]! * Math.sin(h), Math.cos(h)];
}

// ── In a kernel ─────────────────────────────────────────────────────────────────

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, typeof v === 'string' ? v : JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

const NO_GAME: GameDefinition = { components: [], resources: [], events: [], behaviors: [], systems: [] };

interface Garage {
  readonly kernel: Kernel;
  readonly plugin: Render3dPlugin;
  frame(): Frame3d;
  record(placed: string): EntityRecord;
  model(placed: string): Fields & Record<string, (...args: unknown[]) => unknown>;
  step(n?: number): void;
}

async function garage(kart: unknown = { model: 'models/kart' }, options: { assetFiles?: boolean } = {}): Promise<Garage> {
  const project = files({
    'prefabs/cam.prefab.json': { components: { camera: { fov: 60 } } },
    'prefabs/kart.prefab.json': { components: { model: kart } },
    'prefabs/driver.prefab.json': { components: { model: { model: 'models/driver' } } },
    'prefabs/crate.prefab.json': { components: { shape: { kind: 'box' } } },
    'scenes/main/scene.json': { entities: [{ id: 'cam', prefab: 'cam', at: [0, 2, -8] }, { id: 'kart', prefab: 'kart', at: [3, 0, 0] }] },
    'assets/models/kart.model.json': KART,
    'assets/models/driver.model.json': DRIVER,
  });
  const loaded = loadProject(project);
  expect(loaded.diagnostics).toEqual([]);
  const surface = new RecordingSurface3d();
  const assetFiles = options.assetFiles === false ? { assetFiles: false } : {};
  const plugin = render3d({ surface, files: project, ...assetFiles });
  const kernel = new Kernel({
    project: loaded, game: NO_GAME, plugins: [visuals({ dimension: '3d' }), models({ files: project, binary: new MemoryBinaryFiles({}), ...assetFiles }), plugin], context: {}, fixedStep: DT,
  });
  plugin.engine.preload();
  await plugin.engine.whenLoaded();
  kernel.start('main');
  kernel.step(DT);
  const record = (placed: string): EntityRecord => [...kernel.world.live()].find((r) => r.placedId === placed)!;
  return {
    kernel, plugin,
    frame: () => plugin.engine.lastFrame!,
    record,
    model: (placed) => record(placed).components.get('model') as Fields & Record<string, (...args: unknown[]) => unknown>,
    step: (n = 1) => { for (let i = 0; i < n; i++) kernel.step(DT); },
  };
}

/** The world position of the first instance of a geometry drawn for an entity. */
function drawnAt(frame: Frame3d, geometry: string, entity: EntityId): [number, number, number] {
  for (const batch of frame.meshes) {
    if (batch.geometry.id !== geometry) continue;
    const i = batch.entities.indexOf(entity);
    if (i !== -1) return [batch.instances[i * 20 + 12]!, batch.instances[i * 20 + 13]!, batch.instances[i * 20 + 14]!];
  }
  throw new Error(`no ${geometry} drawn for entity ${entity}`);
}

describe('code models in a kernel', () => {
  it('draw a model document like any model: its shown parts, materials and shadows', async () => {
    const g = await garage();
    const kart = g.record('kart').id;
    const drawn = g.frame().meshes.filter((b) => b.entities.includes(kart));
    expect(drawn.map((b) => b.geometry.id).sort()).toEqual(['assets/models/kart.model.json#mesh:tub', 'shape:box', 'shape:capsule:0.05:0.5', 'shape:cylinder']);
    expect(drawn.find((b) => b.geometry.id.startsWith('shape:capsule'))!.castShadows).toBe(false);
    close3(drawnAt(g.frame(), 'shape:cylinder', kart), [3 - 1 + 0.2, 0.3, 1]);
  });

  it('pose joints through Model methods, at once or eased over game time', async () => {
    const g = await garage();
    const kart = g.record('kart').id;
    const model = g.model('kart');
    model['pose']!('lift', 0.2);
    g.step();
    close3(drawnAt(g.frame(), 'shape:capsule:0.05:0.5', kart), [3, 0.2, 0]);
    expect(model['joints']).toEqual({ lift: 0.2 });
    model['pose']!('lift', 0, { seconds: 1 });
    g.step(30);
    expect(model['joint']!('lift')).toBeCloseTo(0.1, 1);
    expect(drawnAt(g.frame(), 'shape:capsule:0.05:0.5', kart)[1]).toBeCloseTo(model['joint']!('lift') as number, 5);
    g.step(31);
    expect(model['joint']!('lift')).toBe(0);
    model['open']!('hood');
    expect(model['joint_motion']).toMatchObject({ hood: { start_value: 10, seconds: 1 } });
    g.step(61);
    expect(model['joint']!('hood')).toBe(80);
    expect(model['joint']!('steer_l')).toBe(0);
    expect(code(() => model['pose']!('steering', 1))).toBe('PP2121');
    expect(code(() => model['open']!('spin_l'))).toBe('PP3823');
    model['pose']!('steer_l', 99);
    expect(model['joint']!('steer_l')).toBe(30);
  });

  it('snapshot a timed move with the entity and replay it exactly', async () => {
    const g = await garage();
    const model = g.model('kart');
    model['pose']!('steer_l', 30, { seconds: 0.5 });
    g.step(5);
    const snapshot = g.kernel.snapshot();
    g.step(10);
    const later = g.frame().meshes.map((b) => [...b.instances]);
    g.kernel.restore(snapshot);
    g.step(10);
    expect(g.frame().meshes.map((b) => [...b.instances])).toEqual(later);
  });

  it('pick options, show parts and recolor through Model methods', async () => {
    const g = await garage();
    const kart = g.record('kart').id;
    const model = g.model('kart');
    const bodyOf = (frame: Frame3d) => frame.meshes.find((b) => b.geometry.id.endsWith('#mesh:tub') && b.entities.includes(kart))!.material;
    model['set_option']!('paint', 'blue');
    g.step();
    const blue = bodyOf(g.frame());
    expect(blue.baseColor).toEqual([0, 0, 1, 1]);
    g.step();
    expect(bodyOf(g.frame())).toBe(blue);
    expect(model['option']!('paint')).toBe('blue');
    expect(model['option']!('aero')).toBe('none');
    model['show_part']!('spoiler');
    g.step();
    expect(g.frame().meshes.filter((b) => b.geometry.id === 'shape:box' && b.entities.includes(kart)).reduce((n, b) => n + b.entities.filter((e) => e === kart).length, 0)).toBe(2);
    model['set_color']!('tyre', new Color(1, 1, 0));
    g.step();
    expect(g.frame().meshes.find((b) => b.geometry.id === 'shape:cylinder')!.material.baseColor).toEqual([1, 1, 0, 1]);
    expect(code(() => model['set_option']!('paint', 'green'))).toBe('PP2123');
    expect(code(() => model['show_part']!('roof'))).toBe('PP2124');
    expect(code(() => model['set_color']!('chrome', Color.WHITE))).toBe('PP2125');
    expect(model['sockets']!({ kind: 'exhaust' })).toEqual(['exhaust']);
    expect((model['sockets']!() as string[]).slice(0, 2)).toEqual(['seat', 'exhaust']);
  });

  it('list the model\'s joints, limits, options and choices', async () => {
    const g = await garage();
    const model = g.model('kart');
    expect(model['joint_names']!()).toEqual(['steer_l', 'spin_l', 'hood', 'lift', 'grow']);
    const limits = model['limits']!('hood') as readonly number[];
    expect(limits).toEqual([0, 80]);
    expect(Object.isFrozen(limits)).toBe(true);
    expect(model['limits']!('spin_l')).toBeNull();
    expect(model['option_names']!()).toEqual(['paint', 'aero']);
    expect(model['choices']!('paint')).toEqual(['red', 'blue']);
    expect(code(() => model['limits']!('steering'))).toBe('PP2121');
    expect(code(() => model['choices']!('decals'))).toBe('PP2123');
  });

  it('raise names in prefab data the model lacks on the first frame', async () => {
    await expect(garage({ model: 'models/kart', joints: { steering: 10 } })).rejects.toMatchObject({ diagnostic: { code: 'PP2121' } });
    await expect(garage({ model: 'models/kart', options: { paint: 'green' } })).rejects.toMatchObject({ diagnostic: { code: 'PP2123' } });
  });

  it('seat an attached entity on a socket and keep it there as the model moves', async () => {
    const g = await garage();
    const kart = g.record('kart');
    const driver = g.kernel.spawn('driver');
    attachToSocket(g.kernel, kart, driver, 'seat', undefined);
    expect(driver.parent).toBe(kart.id);
    expect(driver.components.get('socket')!['name']).toBe('seat');
    close3([driver.transform.position.x, driver.transform.position.y, driver.transform.position.z], [0, 0.6, 0]);
    g.model('kart')['pose']!('lift', 0.2);
    g.step();
    close3([driver.transform.position.x, driver.transform.position.y, driver.transform.position.z], [0, 0.8, 0]);
    close3(drawnAt(g.frame(), 'shape:box', driver.id), [3, 0.8, 0]);
    const seat = g.kernel.service(MODEL_RIG_SERVICE).socket(kart.id, 'seat', 'world')!;
    close3([seat.position.x, seat.position.y, seat.position.z], [3, 0.8, 0]);
    const exhaust = g.model('kart')['socket_position']!('exhaust') as Vec3;
    close3([exhaust.x, exhaust.y, exhaust.z], [3, 0.3, -1.2]);
    // A declared socket takes what it accepts, as many as its limit.
    const second = g.kernel.spawn('driver');
    expect(code(() => attachToSocket(g.kernel, kart, second, 'seat', undefined))).toBe('PP3825');
    const crate = g.kernel.spawn('crate');
    expect(code(() => attachToSocket(g.kernel, kart, crate, 'seat', undefined))).toBe('PP3824');
    expect(code(() => attachToSocket(g.kernel, kart, crate, 'roof', undefined))).toBe('PP2122');
    expect(code(() => attachToSocket(g.kernel, driver, crate, 'seat', true))).toBe('PP3004');
    // Any part is a socket too: its origin.
    attachToSocket(g.kernel, kart, crate, 'hood', undefined);
    g.step();
    expect(crate.transform.position.z).toBeCloseTo(1);
    leaveSocket(g.kernel, driver);
    expect(driver.components.has('socket')).toBe(false);
  });

  it('give mesh colliders the model document\'s triangles, data-only runs included', async () => {
    const g = await garage({ model: 'models/kart' }, { assetFiles: false });
    const geometry = g.kernel.service(MODEL_GEOMETRY_SERVICE).geometry('models/kart')!;
    expect(geometry.indices.length).toBeGreaterThan(0);
    expect(g.kernel.service(MODEL_RIG_SERVICE).rig('models/kart')!.document!.joints.size).toBe(5);
    expect(g.frame().meshes.length).toBeGreaterThan(0);
  });
});
