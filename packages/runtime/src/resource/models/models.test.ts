import { describe, expect, it } from 'vitest';
import { chosenMaterial, clampJoint, decodeBuffer, easeJoint, encodeBuffer, jointNamed, jointValue, parseModelDocument, shownParts } from '../index.js';
import type { ModelDocument } from '../index.js';
import { ParallaxError } from '../../core/index.js';

const TRI = { positions: encodeBuffer('f32', [0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: encodeBuffer('u16', [0, 1, 2]) };

/** A small kart: a body, a steered wheel that spins, a seat socket and a paint option. */
export const KART = {
  format: 'parallax.model',
  version: 1,
  provides: ['vehicle'],
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
    { name: 'wheel_l', parent: 'spin_l', shape: 'cylinder', size: [0.6, 0.3, 0.6], material: 'tyre' },
    { name: 'hood', parent: 'chassis', position: [0, 0.5, 1] },
  ],
  joints: [
    { name: 'steer_l', part: 'steer_l', type: 'hinge', axis: [0, 2, 0], limits: [-30, 30], duration: 0.25 },
    { name: 'spin_l', part: 'spin_l', type: 'hinge', axis: [1, 0, 0] },
    { name: 'hood', part: 'hood', type: 'hinge', kind: 'aperture', axis: [1, 0, 0], limits: [0, 80], default: 10 },
    { name: 'lift', part: 'chassis', type: 'slider', axis: [0, 1, 0], limits: [0, 0.2] },
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

function parse(doc: unknown, path = 'assets/models/kart.model.json'): ReturnType<typeof parseModelDocument> {
  return parseModelDocument(path, JSON.stringify(doc));
}

function documentOf(doc: unknown): ModelDocument {
  const parsed = parse(doc);
  expect(parsed.diagnostics).toEqual([]);
  return parsed.document!;
}

function codes(doc: unknown): string[] {
  return parse(doc).diagnostics.map((d) => d.code);
}

const errorCode = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ParallaxError) return e.diagnostic.code;
    throw e;
  }
  return 'no error';
};

describe('model documents', () => {
  it('decode buffers exactly, little-endian, by their element type', () => {
    expect([...decodeBuffer(encodeBuffer('f32', [1.5, -2, 3.25]))!.values]).toEqual([1.5, -2, 3.25]);
    expect([...decodeBuffer(encodeBuffer('u32', [70000, 1]))!.values]).toEqual([70000, 1]);
    expect(decodeBuffer(encodeBuffer('u16', [65535]))!.type).toBe('u16');
    expect(decodeBuffer('i8:AAAA')).toBeUndefined();
    expect(decodeBuffer('u16:AA==')).toBeUndefined();
  });

  it('parse into parts, meshes, materials, joints, sockets and options', () => {
    const doc = documentOf(KART);
    expect(doc.parts.map((p) => p.name)).toEqual(['chassis', 'tub', 'spoiler', 'steer_l', 'spin_l', 'wheel_l', 'hood']);
    expect(doc.parts[1]).toMatchObject({ parent: { kind: 'part', index: 0 }, draws: { mesh: 'tub' }, size: [2, 1, 1], material: 'body' });
    expect(doc.parts[2]).toMatchObject({ hidden: true, draws: { shape: 'box' } });
    expect(doc.materials.get('body')).toMatchObject({ color: [1, 0, 0, 1], clearcoat: 1, clearcoatRoughness: 0.05, alpha: 'opaque' });
    expect(doc.materials.get('tyre')!.color).toEqual([0.1, 0.1, 0.1, 1]);
    expect([...doc.meshes.get('tub')!.positions]).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const steer = doc.joints.get('steer_l')!;
    expect(steer).toMatchObject({ part: 3, type: 'hinge', kind: 'pose', axis: [0, 1, 0], limits: [-30, 30], default: 0, duration: 0.25 });
    expect(doc.joints.get('spin_l')!.limits).toBeNull();
    expect(doc.joints.get('hood')!.default).toBe(10);
    expect(doc.sockets.get('seat')).toMatchObject({ parent: { kind: 'part', index: 0 }, accepts: ['driver'], limit: 1, kind: null });
    expect(doc.sockets.get('exhaust')).toMatchObject({ parent: null, kind: 'exhaust', accepts: null });
    expect(doc.provides).toEqual(['vehicle']);
    const aero = doc.options.get('aero')!;
    expect(aero.kind === 'parts' && [...aero.choices.get('wing')!]).toEqual([2]);
  });

  it('report every mistake with its code, file and pointer', () => {
    const at = parse({ ...KART, joints: [{ name: 'x', part: 'nope', type: 'hinge', axis: [0, 1, 0] }] }).diagnostics[0]!;
    expect(at).toMatchObject({ code: 'PP2124', path: 'assets/models/kart.model.json', pointer: '/joints/0/part' });
    expect(codes({ ...KART, format: 'gltf' })).toEqual(['PP2120']);
    expect(codes({ ...KART, meshes: { tub: { ...TRI, indices: encodeBuffer('u16', [0, 1, 5]) } } })).toEqual(['PP2128']);
    expect(codes({ ...KART, meshes: { tub: { positions: 'f32:%%' } } })).toEqual(['PP2128']);
    expect(codes({ ...KART, parts: [...KART.parts, { name: 'tub' }] })).toEqual(['PP2127']);
    expect(codes({ ...KART, parts: [...KART.parts, { name: 'x', mesh: 'nope', material: 'body' }] })).toEqual(['PP2126']);
    expect(codes({ ...KART, parts: [...KART.parts, { name: 'x', shape: 'box', material: 'paint' }] })).toEqual(['PP2125']);
    expect(codes({ ...KART, parts: [...KART.parts, { name: 'x', shape: 'box' }] })).toEqual(['PP1002']);
    expect(codes({ ...KART, parts: [...KART.parts, { name: 'x', rotation: [0, 0, 0, 2] }] })).toEqual(['PP1002']);
    expect(codes({ ...KART, parts: [...KART.parts, { name: 'x', shap: 'box' }] })).toEqual(['PP1003']);
    expect(codes({ ...KART, joints: [{ name: 's', part: 'tub', type: 'slider', axis: [0, 1, 0] }] })).toEqual(['PP2129']);
    expect(codes({ ...KART, joints: [{ name: 's', part: 'tub', type: 'hinge', axis: [0, 0, 0] }] })).toEqual(['PP2129']);
    expect(codes({ ...KART, joints: [{ name: 's', part: 'tub', type: 'hinge', axis: [0, 1, 0], limits: [0, 10], default: 20 }] })).toEqual(['PP2129']);
    expect(codes({ ...KART, options: [{ name: 'paint', materials: ['body'], default: 'green', choices: { red: {} } }] })).toEqual(['PP2123']);
    expect(codes({ ...KART, options: [{ name: 'aero', parts: ['spoiler'], default: 'x', choices: { x: ['tub'] } }] })).toEqual(['PP2129']);
    expect(parseModelDocument('assets/models/x.model.json', '{').diagnostics[0]!.code).toBe('PP1001');
  });

  it('keep skinned meshes in model space: a skinned part has no parent or transform', () => {
    const skinned = {
      ...KART,
      skeleton: { bones: [{ name: 'hips' }, { name: 'head', parent: 0, position: [0, 1, 0] }], inverse_bind: encodeBuffer('f32', new Array(32).fill(0)) },
      meshes: { body: { ...TRI, joints: encodeBuffer('u16', new Array(12).fill(1)), weights: encodeBuffer('f32', [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]) } },
      parts: [{ name: 'body', mesh: 'body', material: 'body' }, { name: 'hat', parent: 'head', shape: 'sphere', material: 'body' }],
      joints: [], sockets: [{ name: 'eye', parent: 'head', position: [0, 0.1, 0.1] }], options: [],
    };
    const doc = documentOf(skinned);
    expect(doc.parts[0]!.skinned).toBe(true);
    expect(doc.parts[1]!.parent).toEqual({ kind: 'bone', index: 1 });
    expect(doc.sockets.get('eye')!.parent).toEqual({ kind: 'bone', index: 1 });
    expect(codes({ ...skinned, parts: [{ name: 'body', mesh: 'body', material: 'body', position: [0, 1, 0] }] })).toEqual(['PP2129']);
    expect(codes({ ...skinned, skeleton: { ...skinned.skeleton, bones: [{ name: 'hips' }] } })).toContain('PP2128');
  });
});

describe('model rig rules', () => {
  const doc = documentOf(KART);

  it('clamp joint values to their limits; free hinges take any angle', () => {
    expect(clampJoint(doc.joints.get('steer_l')!, 50)).toBe(30);
    expect(clampJoint(doc.joints.get('spin_l')!, 725)).toBe(725);
    expect(errorCode(() => jointNamed(doc, 'steer', 'pose("steer")'))).toBe('PP2121');
  });

  it('ease a timed move as a pure function of game time', () => {
    const motion = { start_value: 0, start_time: 10, seconds: 2 };
    expect(jointValue(30, motion, 9)).toBe(0);
    expect(jointValue(30, motion, 11)).toBeCloseTo(15);
    expect(jointValue(30, motion, 10.5)).toBeCloseTo(30 * easeJoint(0.25));
    expect(jointValue(30, motion, 12)).toBe(30);
    expect(jointValue(30, undefined, 0)).toBe(30);
  });

  it('show parts by the document, then options, then overrides', () => {
    expect(shownParts(doc, {}, {})[2]).toBe(false);
    expect(shownParts(doc, { aero: 'wing' }, {})[2]).toBe(true);
    expect(shownParts(doc, { aero: 'wing' }, { spoiler: false })[2]).toBe(false);
    expect(shownParts(doc, {}, { tub: false })[1]).toBe(false);
  });

  it('apply a material option\'s choice over the material', () => {
    expect(chosenMaterial(doc, 'body', {}).color).toEqual([1, 0, 0, 1]);
    expect(chosenMaterial(doc, 'body', { paint: 'blue' })).toMatchObject({ color: [0, 0, 1, 1], roughness: 0.6, clearcoat: 1 });
    expect(chosenMaterial(doc, 'tyre', { paint: 'blue' }).roughness).toBe(0.9);
  });

  it('layer several options over one material in document order (a wood, then a finish over it)', () => {
    const layered = documentOf({
      ...KART,
      options: [
        KART.options[0],
        { name: 'finish', materials: ['body'], default: 'none', choices: { none: {}, aged: { roughness: 0.95 }, dark: { color: '#000000' } } },
      ],
    });
    expect(chosenMaterial(layered, 'body', {})).toMatchObject({ color: [1, 0, 0, 1] });
    expect(chosenMaterial(layered, 'body', { paint: 'blue', finish: 'aged' })).toMatchObject({ color: [0, 0, 1, 1], roughness: 0.95 });
    expect(chosenMaterial(layered, 'body', { paint: 'blue', finish: 'dark' })).toMatchObject({ color: [0, 0, 0, 1], roughness: 0.6 });
  });
});
