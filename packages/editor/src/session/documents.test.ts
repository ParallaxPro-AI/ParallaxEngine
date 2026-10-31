import { describe, expect, it } from 'vitest';
import { ProjectDocuments, pointerOf } from './documents.js';
import { EditHistory } from './history.js';
import { files } from './test_fixtures.js';

const code = (fn: () => unknown): string | undefined => {
  try { fn(); } catch (e) { return (e as { diagnostic?: { code: string } }).diagnostic?.code; }
  return undefined;
};

function docs(): ProjectDocuments {
  return new ProjectDocuments(files({
    'scenes/main/scene.json': { entities: [{ prefab: 'a', at: [0, 0] }, { prefab: 'b' }] },
    'prefabs/a.prefab.json': { components: {} },
    'notes.txt': 'not json\n',
  }));
}

describe('ProjectDocuments', () => {
  it('applies JSON-patch ops atomically and returns their inverse', () => {
    const d = docs();
    const inverse = d.apply([{ path: 'scenes/main/scene.json', ops: [
      { op: 'replace', pointer: '/entities/0/at', value: [1, 2] },
      { op: 'add', pointer: '/entities/-', value: { prefab: 'c' } },
      { op: 'remove', pointer: '/entities/1' },
      { op: 'add', pointer: '/music', value: 'menu' },
    ] }]);
    expect(d.json('scenes/main/scene.json')).toEqual({ entities: [{ prefab: 'a', at: [1, 2] }, { prefab: 'c' }], music: 'menu' });
    d.apply(inverse);
    expect(d.json('scenes/main/scene.json')).toEqual({ entities: [{ prefab: 'a', at: [0, 0] }, { prefab: 'b' }] });
    expect(d.version).toBe(2);
  });

  it('changes nothing when any op fails', () => {
    const d = docs();
    const before = d.read('scenes/main/scene.json');
    expect(code(() => d.apply([
      { path: 'scenes/main/scene.json', ops: [{ op: 'add', pointer: '/entities/0/at', value: [5, 5] }] },
      { path: 'prefabs/a.prefab.json', ops: [{ op: 'remove', pointer: '/nothing' }] },
    ]))).toBe('PP9622');
    expect(d.read('scenes/main/scene.json')).toBe(before);
    expect(d.dirty()).toEqual([]);
  });

  it('creates and deletes whole files, keeps untouched text verbatim, and tracks dirty files', () => {
    const d = docs();
    const inverse = d.apply([{ path: 'prefabs/b.prefab.json', ops: [{ op: 'add', pointer: '', value: { components: {} } }] }]);
    expect(d.list()).toContain('prefabs/b.prefab.json');
    expect(d.read('prefabs/b.prefab.json')).toBe('{\n  "components": {}\n}\n');
    expect(d.read('notes.txt')).toBe('not json\n');
    expect(d.dirty()).toEqual(['prefabs/b.prefab.json']);
    d.apply(inverse);
    expect(d.list()).not.toContain('prefabs/b.prefab.json');
    d.markSaved();
    expect(d.dirty()).toEqual([]);
  });

  it('escapes pointer keys and serves the loaded project until the next edit', () => {
    const d = docs();
    expect(pointerOf('a/b', 'c~d', 3)).toBe('/a~1b/c~0d/3');
    const project = d.project();
    expect(d.project()).toBe(project);
    expect(project.scenes.get('main')!.entities.map((e) => e.prefab)).toEqual(['a', 'b']);
    d.apply([{ path: 'prefabs/a.prefab.json', ops: [{ op: 'add', pointer: pointerOf('tags'), value: ['x/y'] }] }]);
    expect(d.project()).not.toBe(project);
    expect(d.project().prefabs.get('a')!.tags).toEqual(['x/y']);
  });
});

describe('ProjectDocuments outside changes and locking', () => {
  it('takes files changed outside as saved, dropping unsaved edits to them', () => {
    const d = docs();
    const heard: string[][] = [];
    d.onChange((paths) => heard.push([...paths]));
    d.apply([{ path: 'prefabs/a.prefab.json', ops: [{ op: 'add', pointer: '/tags', value: ['mine'] }] }]);
    const project = d.project();
    d.replaceFiles(new Map<string, string | null>([
      ['prefabs/a.prefab.json', '{ "components": {}, "tags": ["theirs"] }'],
      ['prefabs/c.prefab.json', '{ "components": {} }'],
      ['notes.txt', null],
    ]));
    expect(d.json('prefabs/a.prefab.json')).toEqual({ components: {}, tags: ['theirs'] });
    expect(d.read('prefabs/a.prefab.json')).toBe('{ "components": {}, "tags": ["theirs"] }');
    expect(d.list()).toEqual(['prefabs/a.prefab.json', 'prefabs/c.prefab.json', 'scenes/main/scene.json']);
    expect(d.dirty()).toEqual([]);
    expect(d.project()).not.toBe(project);
    expect(heard.at(-1)).toEqual(['prefabs/a.prefab.json', 'prefabs/c.prefab.json', 'notes.txt']);
  });

  it('refuses every edit while locked (PP9648), and still takes outside changes', () => {
    const d = docs();
    const history = new EditHistory(d);
    history.commit('Tag', [{ path: 'prefabs/a.prefab.json', ops: [{ op: 'add', pointer: '/tags', value: [] }] }]);
    d.lock('Another tool is editing');
    expect(d.locked).toBe('Another tool is editing');
    expect(code(() => d.apply([{ path: 'prefabs/a.prefab.json', ops: [{ op: 'remove', pointer: '/tags' }] }]))).toBe('PP9648');
    expect(code(() => history.undo())).toBe('PP9648');
    d.replaceFiles(new Map([['prefabs/a.prefab.json', '{ "components": { "x": {} } }']]));
    expect(d.json('prefabs/a.prefab.json')).toEqual({ components: { x: {} } });
    d.unlock();
    expect(d.locked).toBeNull();
    d.apply([{ path: 'prefabs/a.prefab.json', ops: [{ op: 'add', pointer: '/tags', value: [] }] }]);
    expect(d.dirty()).toEqual(['prefabs/a.prefab.json']);
  });
});

describe('EditHistory', () => {
  it('undoes and redoes patches, merges a gesture into one step, and drops redo on a new edit', () => {
    const d = docs();
    const h = new EditHistory(d);
    const at = (): unknown => d.get('scenes/main/scene.json', '/entities/0/at');
    for (const x of [1, 2, 3]) h.commit('Move', [{ path: 'scenes/main/scene.json', ops: [{ op: 'replace', pointer: '/entities/0/at', value: [x, 0] }] }], { merge: 'drag' });
    expect(h.entries).toEqual({ labels: ['Move'], applied: 1 });
    h.seal();
    h.commit('Move', [{ path: 'scenes/main/scene.json', ops: [{ op: 'replace', pointer: '/entities/0/at', value: [9, 9] }] }], { merge: 'drag' });
    expect(h.entries.labels).toHaveLength(2);
    h.undo();
    expect(at()).toEqual([3, 0]);
    h.undo();
    expect(at()).toEqual([0, 0]);
    expect(h.canUndo).toBe(false);
    h.redo();
    expect(at()).toEqual([3, 0]);
    h.commit('Tag', [{ path: 'prefabs/a.prefab.json', ops: [{ op: 'add', pointer: '/tags', value: [] }] }]);
    expect(h.canRedo).toBe(false);
    expect(h.entries).toEqual({ labels: ['Move', 'Tag'], applied: 2 });
  });
});
