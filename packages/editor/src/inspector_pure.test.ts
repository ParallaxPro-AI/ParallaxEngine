import { describe, expect, it } from 'vitest';
import { t } from '@parallax/runtime/kernel';
import {
  assetChoices, assetName, clampNumber, CollapsedSections, colorParts, enableField, fieldLabel, fieldVisible, fieldWidget, filterAssets,
  filterComponents, parseHexColor, rangeFraction, rangeText, readableLabel, scrubValue, sharedIds, sharedValue,
} from './fields.js';

describe('fieldWidget', () => {
  it('picks pickers for references and toggles for enum lists, unwrapping optionals', () => {
    expect(fieldWidget({ kind: 'ref', to: 'asset/models' })).toEqual({ kind: 'asset', folder: 'models', optional: false });
    expect(fieldWidget({ kind: 'ref', to: 'prefab' })).toEqual({ kind: 'prefab', optional: false });
    expect(fieldWidget({ kind: 'ref', to: 'upgrade' })).toEqual({ kind: 'ref', to: 'upgrade', optional: false });
    expect(fieldWidget({ kind: 'optional', of: { kind: 'color' } })).toEqual({ kind: 'color', optional: true });
    expect(fieldWidget({ kind: 'list', of: { kind: 'enum', values: ['x', 'y'] } })).toEqual({ kind: 'flags', values: ['x', 'y'], optional: false });
    expect(fieldWidget({ kind: 'list', of: { kind: 'number' } }).kind).toBe('json');
    expect(fieldWidget({ kind: 'entity' }).kind).toBe('entity');
  });
});

describe('labels and visibility', () => {
  it('reads names and keeps the inspector\'s labels', () => {
    expect(readableLabel('fov')).toBe('FOV');
    expect(readableLabel('move_speed')).toBe('Move speed');
    expect(fieldLabel('collider', 'trigger')).toBe('Is trigger');
    expect(fieldLabel('rigidbody', 'linear_damping')).toBe('Linear drag');
    expect(fieldLabel('health', 'max_hp')).toBe('Max HP');
  });

  it('shows fields only where they matter', () => {
    expect(fieldVisible('light', 'range', { kind: 'directional' })).toBe(false);
    expect(fieldVisible('light', 'range', { kind: 'point' })).toBe(true);
    expect(fieldVisible('light', 'angle', { kind: 'point' })).toBe(false);
    expect(fieldVisible('camera', 'fov', { mode: 'orthographic' })).toBe(false);
    expect(fieldVisible('camera', 'follow', { rig: 'fixed' })).toBe(false);
    expect(fieldVisible('collider', 'radius', { shape: 'capsule' })).toBe(true);
    expect(fieldVisible('collider', 'size', { shape: 'sphere' })).toBe(false);
    expect(fieldVisible('sprite', 'animation_started', {})).toBe(false);
    expect(fieldVisible('anything', 'else', {})).toBe(true);
  });

  it('finds the field a component is switched on and off with', () => {
    expect(enableField({ enabled: t.bool({ default: true }), strength: t.number() })).toBe('enabled');
    expect(enableField({ active: t.bool({ default: true }) })).toBe('active');
    expect(enableField({ enabled: t.bool({ default: false }) })).toBeUndefined();
    expect(enableField({ speed: t.number() })).toBeUndefined();
  });
});

describe('numbers', () => {
  it('clamps to the declared range and shows it', () => {
    expect(clampNumber(5, { min: 0, max: 1 })).toBe(1);
    expect(clampNumber(-2, { min: 0 })).toBe(0);
    expect(clampNumber(2.6, {}, true)).toBe(3);
    expect(rangeText({ min: 0, max: 1 })).toBe('0 – 1');
    expect(rangeText({ min: 0 })).toBe('≥ 0');
    expect(rangeText({})).toBe('');
    expect(rangeFraction(0.25, { min: 0, max: 1 })).toBe(0.25);
    expect(rangeFraction(3, { min: 0 })).toBeUndefined();
  });

  it('scrubs by pixels, faster with Shift, finer with Alt, clamped and tidy', () => {
    expect(scrubValue(0, 150, { min: 0, max: 1 })).toBeCloseTo(0.5, 5);
    expect(scrubValue(0.5, 1000, { min: 0, max: 1 })).toBe(1);
    expect(scrubValue(10, 10, {})).toBeCloseTo(11, 5);
    expect(scrubValue(10, 10, {}, false, { fast: true })).toBeCloseTo(20, 5);
    expect(scrubValue(10, 10, {}, false, { fine: true })).toBeCloseTo(10.1, 5);
    expect(Number.isInteger(scrubValue(3, 17, {}, true))).toBe(true);
    expect(String(scrubValue(0, 7, {}))).not.toMatch(/0000/);
  });
});

describe('colors', () => {
  it('reads hex in its three lengths and color JSON in both forms', () => {
    expect(parseHexColor('#f80')).toEqual([1, 0.5333, 0, 1]);
    expect(parseHexColor('ff8000', 0.5)).toEqual([1, 0.502, 0, 0.5]);
    expect(parseHexColor('#ff800080')![3]).toBeCloseTo(0.502, 3);
    expect(parseHexColor('#ff80')).toBeNull();
    expect(colorParts([0.1, 0.2, 0.3])).toEqual([0.1, 0.2, 0.3, 1]);
    expect(colorParts('#000000')).toEqual([0, 0, 0, 1]);
  });
});

describe('multi-selection', () => {
  it('shares a value only when every entity has it, and the components all have', () => {
    expect(sharedValue([1, 1, 1])).toEqual({ mixed: false, value: 1 });
    expect(sharedValue([[1, 2], [1, 3]])).toEqual({ mixed: true, value: undefined });
    expect(sharedIds([['shape', 'light', 'collider'], ['collider', 'shape']])).toEqual(['shape', 'collider']);
  });
});

describe('Add Component', () => {
  it('searches the game\'s and the engine\'s components, the game\'s first', () => {
    const choices = [
      { id: 'light', category: 'Rendering' }, { id: 'rigidbody', category: 'Physics' }, { id: 'health', category: 'Game' },
      { id: 'collider', category: 'Physics' },
    ];
    expect(filterComponents(choices, '').map((c) => c.id)).toEqual(['health', 'collider', 'rigidbody', 'light']);
    expect(filterComponents(choices, 'phys').map((c) => c.id)).toEqual(['collider', 'rigidbody']);
    expect(filterComponents(choices, 'rigid body').map((c) => c.id)).toEqual(['rigidbody']);
  });
});

describe('asset choices', () => {
  const paths = ['assets/models/crate.glb', 'assets/models/tree.model.json', 'assets/images/sky.png', 'assets/sfx/jump.ogg', 'assets/music/theme.ogg', 'assets/vfx/fire.vfx.json', 'prefabs/a.prefab.json'];
  it('lists the project\'s files of the kind, then hosted ones in use, then built-ins', () => {
    const used = [{ kind: 'models', ref: 'https://r2.parallaxpro.ai/assets/model_static/ab/cd/x.glb', name: 'barrel' }, { kind: 'audio', ref: 'assets/sfx/jump.ogg', name: 'jump' }];
    expect(assetChoices('models', paths, used).map((c) => [c.ref, c.name, c.source])).toEqual([
      ['models/crate', 'crate', 'project'], ['models/tree', 'tree', 'project'],
      ['https://r2.parallaxpro.ai/assets/model_static/ab/cd/x.glb', 'barrel', 'hosted'],
    ]);
    expect(assetChoices('sfx', paths, used, ['synth/coin']).map((c) => c.ref)).toEqual(['sfx/jump', 'synth/coin']);
    expect(assetChoices('vfx', paths, [], ['effect/fire']).map((c) => c.name)).toEqual(['fire', 'fire']);
    expect(filterAssets(assetChoices('models', paths, used), 'tre').map((c) => c.name)).toEqual(['tree']);
  });

  it('names a reference by its file', () => {
    expect(assetName('models/tree')).toBe('tree');
    expect(assetName('https://r2.parallaxpro.ai/assets/image_texture/68/61/abc.png')).toBe('abc');
    expect(assetName('effect/fire')).toBe('fire');
  });
});

describe('CollapsedSections', () => {
  it('remembers collapsed sections across instances and survives broken storage', () => {
    const data = new Map<string, string>();
    const store = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } };
    const a = new CollapsedSections(store);
    a.set('component:light', true);
    a.set('transform', true);
    a.set('transform', false);
    const b = new CollapsedSections(store);
    expect(b.has('component:light')).toBe(true);
    expect(b.has('transform')).toBe(false);
    const broken = new CollapsedSections({ getItem: () => '{nope', setItem: () => { throw new Error('full'); } });
    expect(broken.has('x')).toBe(false);
    broken.set('x', true);
    expect(broken.has('x')).toBe(true);
    expect(new CollapsedSections(undefined).has('x')).toBe(false);
  });
});
