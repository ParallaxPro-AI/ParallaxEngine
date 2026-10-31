import { describe, expect, it } from 'vitest';
import { Quat, Vec3 } from '@parallax/runtime/core';
import { t } from '@parallax/runtime/kernel';
import { ProjectDocuments } from './session/index.js';
import { fly, look, lookRotation, pan, yawPitch, zoom2d } from './camera_controls.js';
import { colorHex, hexColor, label, parseInput, shortNumber, valueJson, widgetKind } from './fields.js';
import { DEFAULT_STYLE, formatJson, jsonStyle } from './format_json.js';
import { needsCode, saveRequest } from './server_link.js';
import { shortcutFor } from './shortcuts.js';

const close = (a: number, b: number): void => expect(Math.abs(a - b)).toBeLessThan(1e-6);

describe('formatJson', () => {
  it('keeps short values inline and breaks the top level', () => {
    const doc = { mode: '3d', ui: ['hud'], entities: [{ prefab: 'rail', at: [9.4, 0.3, 0.2] }] };
    expect(formatJson(doc)).toBe('{\n  "mode": "3d",\n  "ui": ["hud"],\n  "entities": [{ "prefab": "rail", "at": [9.4, 0.3, 0.2] }]\n}\n');
  });

  it('breaks a value that does not fit, one entry per line', () => {
    const entities = Array.from({ length: 6 }, (_, i) => ({ prefab: `brick_${i}`, at: [i, 0, i * 2] }));
    const text = formatJson({ entities });
    expect(text.split('\n')[1]).toBe('  "entities": [');
    expect(text).toContain('\n    { "prefab": "brick_0", "at": [0, 0, 0] },\n');
    expect(JSON.parse(text)).toEqual({ entities });
  });

  it('keeps a list of several placements one per line even when it would fit', () => {
    const doc = { entities: [{ prefab: 'camera', at: [0, 0, -10] }, { prefab: 'backdrop', at: [0, 0] }] };
    expect(formatJson(doc)).toBe('{\n  "entities": [\n    { "prefab": "camera", "at": [0, 0, -10] },\n    { "prefab": "backdrop", "at": [0, 0] }\n  ]\n}\n');
  });

  it('round-trips any value', () => {
    const doc = { a: [], b: {}, c: [[1, [2, { d: null }]], 'x'], e: { f: { g: true } }, 'k"ey': 'v\n' };
    expect(JSON.parse(formatJson(doc))).toEqual(doc);
  });

  it('reads and keeps a file\'s own layout', () => {
    const generated = `${JSON.stringify({ at: [1, 2], children: [{ x: 1 }] }, null, 1)}\n`;
    expect(jsonStyle(generated)).toMatchObject({ indent: ' ', compact: false });
    expect(formatJson(JSON.parse(generated), jsonStyle(generated))).toBe(generated);

    const python = '{\n  "ui": ["hud"],\n  "wind": {"speed": 11, "gusts": 0.2}\n}\n';
    expect(jsonStyle(python)).toMatchObject({ indent: '  ', compact: true, padBraces: false });
    expect(formatJson(JSON.parse(python), jsonStyle(python))).toBe(python);

    expect(jsonStyle(undefined)).toEqual(DEFAULT_STYLE);
  });
});

describe('fields', () => {
  it('picks a widget per declared type', () => {
    expect(widgetKind({ kind: 'number' })).toBe('number');
    expect(widgetKind({ kind: 'ref', to: 'prefab' })).toBe('string');
    expect(widgetKind({ kind: 'enum', values: ['a'] })).toBe('enum');
    expect(widgetKind({ kind: 'list', of: { kind: 'int' } })).toBe('json');
  });

  it('parses typed input into file JSON', () => {
    expect(parseInput('number', ' 2.5 ')).toEqual({ ok: true, value: 2.5 });
    expect(parseInput('int', '2.5').ok).toBe(false);
    expect(parseInput('number', '').ok).toBe(false);
    expect(parseInput('json', '[1, 2]')).toEqual({ ok: true, value: [1, 2] });
    expect(parseInput('json', '[1,').ok).toBe(false);
  });

  it('encodes live values as the files hold them', () => {
    expect(valueJson(t.vec3(), new Vec3(1, 2, 3), 'x')).toEqual([1, 2, 3]);
    expect(valueJson(t.number(), Number.NaN, 'x')).toBeUndefined();
  });

  it('converts colors for the color input, keeping alpha', () => {
    expect(colorHex([1, 0.5, 0, 0.3])).toBe('#ff8000');
    expect(hexColor('#ff8000', 0.3)).toEqual([1, 0.502, 0, 0.3]);
  });

  it('labels and numbers read cleanly', () => {
    expect(label('move_speed')).toBe('Move speed');
    expect(shortNumber(0.1 + 0.2)).toBe('0.3');
    expect(shortNumber(-0.000001)).toBe('0');
  });
});

describe('camera controls', () => {
  it('yaw and pitch round-trip through a rotation', () => {
    const { yaw, pitch } = yawPitch(lookRotation(30, -20));
    close(yaw, 30);
    close(pitch, -20);
  });

  it('looks, flies and pans in camera space', () => {
    const pose = { position: new Vec3(0, 0, 0), rotation: Quat.IDENTITY, fov: 60 };
    const turned = look(pose, 360, 0, 0.25);
    close(yawPitch(turned.rotation).yaw, 90);
    const flown = fly(pose, 1, 0, 2);
    close(flown.position.x, 1);
    close(flown.position.z, 2);
    const panned = pan(pose, 10, 10, 0.1);
    close(panned.position.x, -1);
    close(panned.position.y, 1);
  });

  it('2D zoom keeps the point under the pointer still', () => {
    const pose = { position: new Vec3(0, 0, -10), rotation: Quat.IDENTITY, size: 5 };
    const zoomed = zoom2d(pose, -2, { x: 4, y: 2 });
    const k = zoomed.size! / 5;
    // The pointer's world point sits at the same fraction of the view before and after.
    close((4 - zoomed.position.x) / k, 4);
    close((2 - zoomed.position.y) / k, 2);
    close(zoomed.position.z, -10);
  });
});

describe('shortcuts', () => {
  const key = (k: string, mods: Partial<KeyboardEvent> = {}) => ({ key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods });

  it('maps editor keys in edit mode', () => {
    expect(shortcutFor(key('w'), 'edit')).toBe('translate');
    expect(shortcutFor(key('Delete'), 'edit')).toBe('delete');
    expect(shortcutFor(key('z', { metaKey: true }), 'edit')).toBe('undo');
    expect(shortcutFor(key('Z', { ctrlKey: true, shiftKey: true }), 'edit')).toBe('redo');
    expect(shortcutFor(key('p', { ctrlKey: true }), 'edit')).toBe('play');
  });

  it('leaves the keyboard to the game while it plays, except stop', () => {
    expect(shortcutFor(key('w'), 'playing')).toBeNull();
    expect(shortcutFor(key('Delete'), 'paused')).toBeNull();
    expect(shortcutFor(key('s', { ctrlKey: true }), 'playing')).toBeNull();
    expect(shortcutFor(key('p', { metaKey: true }), 'playing')).toBe('stop');
  });
});

describe('server link', () => {
  const files = (map: Record<string, string>) => ({ list: () => Object.keys(map), read: (p: string) => map[p]! });

  it('sends dirty documents in their file\'s layout, and removals', () => {
    const original = '{\n "entities": [\n  {\n   "prefab": "a"\n  }\n ]\n}\n';
    const docs = new ProjectDocuments(files({ 'scenes/main/scene.json': original, 'prefabs/old.prefab.json': '{}' }));
    docs.apply([{ path: 'scenes/main/scene.json', ops: [{ op: 'add', pointer: '/entities/0/at', value: [1, 2] }] }]);
    docs.apply([{ path: 'prefabs/old.prefab.json', ops: [{ op: 'remove', pointer: '' }] }]);
    const request = saveRequest(docs, (p) => (p === 'scenes/main/scene.json' ? original : undefined));
    expect(request.removed).toEqual(['prefabs/old.prefab.json']);
    expect(request.files).toEqual([{
      path: 'scenes/main/scene.json',
      text: '{\n "entities": [\n  {\n   "prefab": "a",\n   "at": [\n    1,\n    2\n   ]\n  }\n ]\n}\n',
    }]);
  });

  it('hot-reloads code only for Python changes', () => {
    expect(needsCode(['game/main.py'])).toBe(true);
    expect(needsCode(['scenes/a/scene.json', 'ui/hud.html'])).toBe(false);
  });
});
