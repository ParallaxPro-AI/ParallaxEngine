/**
 * Type markers and the stored ↔ game forms of containers: what compiled annotations mean,
 * and that game code sees Python's dict / set / tuple where the kernel stores JSON shapes.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { copy } from '../function/kernel/index.js';
import { PyDict, PyFrozenSet, PySet } from './pyrt/collections.js';
import { Ellipsis } from './pyrt/values.js';
import {
  Color, content, ContentRef, Entity, Enum, enum_class, field, PrefabRef, record, resetDeclarations, rt, Tag, tag, toFieldType, Vec2,
} from './index.js';
import { cloneValue, coerce, resolveType, schemaOf, toKernelForm } from './types.js';
import type { CoerceEnv, ContentClass } from './types.js';

declare global {
  interface ImportMeta {
    glob(pattern: string[], options: { query: '?raw'; import: 'default'; eager: true }): Record<string, string>;
  }
}

const EMIT = Object.values(import.meta.glob(['../../../transpiler/parallax_transpiler/emit.py'], { query: '?raw', import: 'default', eager: true }))[0]!;

function code(fn: () => unknown): string | undefined {
  try { fn(); } catch (e) { return (e as { diagnostic?: { code: string } }).diagnostic?.code; }
  return undefined;
}

/** Content refs made on demand, as the runtime's content lists would. */
const ENV: CoerceEnv = { content: (target: ContentClass, id: string) => new ContentRef(target.__content_kind__, id) };

class RingC extends Enum { static BULL = 'bull'; static OUTER = 'outer'; }
const Ring = enum_class(RingC) as unknown as typeof RingC & { BULL: Enum; OUTER: Enum };

function itemClass(): ContentClass {
  class Item { static __annotations__ = { name: () => rt.str }; }
  return content('item')(Item) as unknown as ContentClass;
}

beforeEach(() => resetDeclarations());

describe('rt markers', () => {
  it('include every marker the transpiler emits', () => {
    expect(EMIT).toContain('def type_expr');
    const names = new Set<string>();
    // `{T}.name` written out…
    for (const m of EMIT.matchAll(/\{T\}\.([a-z_]+)/g)) names.add(m[1]!);
    // …and the builtin names `{T}.{node.id}` / `{T}.{base.id}` / `{T}.{name.lower()}` stand for.
    for (const m of EMIT.matchAll(/node\.id in \(([^)]*)\)/g)) for (const n of m[1]!.matchAll(/"(\w+)"/g)) names.add(n[1]!);
    for (const m of EMIT.matchAll(/base\.id in \(([^)]*)\)/g)) for (const n of m[1]!.matchAll(/"(\w+)"/g)) names.add(n[1]!);
    for (const m of EMIT.matchAll(/name in \(("ClassVar", "Final")\)/g)) for (const n of m[1]!.matchAll(/"(\w+)"/g)) names.add(n[1]!.toLowerCase());
    for (const placeholder of ['', 'node', 'base', 'name']) names.delete(placeholder);
    expect([...names].sort()).toEqual([
      'any', 'bool', 'callable', 'classvar', 'dict', 'final', 'float', 'frozenset', 'generic', 'int', 'list', 'literal', 'none',
      'optional', 'set', 'str', 'tuple', 'type', 'union',
    ]);
    for (const name of names) expect(rt, name).toHaveProperty(name);
  });

  it('map to the kernel field types the declarations extractor writes', () => {
    const Item = itemClass();
    expect(toFieldType(rt.set(rt.str))).toEqual({ kind: 'list', of: { kind: 'string' } });
    expect(toFieldType(rt.frozenset(Tag))).toEqual({ kind: 'list', of: { kind: 'tag' } });
    expect(toFieldType(rt.list())).toEqual({ kind: 'list', of: { kind: 'json' } });
    expect(toFieldType(rt.dict())).toEqual({ kind: 'dict', of: { kind: 'json' } });
    expect(toFieldType(rt.any)).toEqual({ kind: 'json' });
    expect(toFieldType(rt.tuple(rt.int, Ellipsis))).toEqual({ kind: 'list', of: { kind: 'int' } });
    expect(toFieldType(rt.tuple(rt.int, Color))).toEqual({ kind: 'tuple', of: [{ kind: 'int' }, { kind: 'color' }] });
    expect(toFieldType(rt.union(PrefabRef, rt.int))).toEqual({ kind: 'union', of: [{ kind: 'ref', to: 'prefab' }, { kind: 'int' }] });
    expect(toFieldType(rt.final(rt.float))).toEqual({ kind: 'number' });
    expect(toFieldType(rt.dict(rt.generic(ContentRef, Item), rt.int))).toEqual({ kind: 'dict', of: { kind: 'int' } });
    expect(toFieldType(rt.dict(Ring, rt.int))).toEqual({ kind: 'dict', of: { kind: 'int' } });
    expect(toFieldType(rt.dict(rt.int, rt.str))).toEqual({ kind: 'dict', of: { kind: 'string' } });
  });

  it('reject what a field cannot hold, with a coded diagnostic', () => {
    expect(code(() => toFieldType(rt.callable()))).toBe('PP4109');
    expect(code(() => toFieldType(rt.none))).toBe('PP4109');
    expect(code(() => toFieldType(rt.type(Entity)))).toBe('PP4109');
    expect(code(() => toFieldType(rt.classvar(rt.int)))).toBe('PP4109');
    expect(code(() => toFieldType(rt.tuple(Ellipsis, rt.int)))).toBe('PP4109');
    expect(code(() => toFieldType(rt.dict(rt.float, rt.int)))).toBe('PP4109');
    expect(code(() => toFieldType(rt.dict(Vec2, rt.int)))).toBe('PP4109');
  });

  it('leave ClassVar attributes out of a schema', () => {
    class PadC {
      static __annotations__ = { width: () => rt.float, registry: () => rt.classvar(rt.dict(rt.str, rt.int)) };
      static width = field(2);
      static registry = new PyDict();
    }
    const Pad = record(PadC);
    expect(Object.keys(schemaOf(Pad, 'record Pad').schema)).toEqual(['width']);
  });
});

describe('stored form ↔ game form', () => {
  it('tags are interned: a Tag field read back is the declared tag itself, so `is` holds', () => {
    const Home = tag('home');
    expect(tag('home')).toBe(Home);
    const t = resolveType(Tag, 'f');
    expect(coerce(t, 'home', ENV, 'f')).toBe(Home);
    expect(coerce(resolveType(rt.list(Tag), 'f'), ['home'], ENV, 'f')).toEqual([Home]);
    expect((coerce(resolveType(rt.list(Tag), 'f'), ['home'], ENV, 'f') as unknown[])[0]).toBe(Home);
  });

  it('dicts are PyDicts keyed by refs, enums and ints; stored keyed by their ids', () => {
    const Item = itemClass();
    const byItem = resolveType(rt.dict(rt.generic(ContentRef, Item), rt.int), 'f');
    const d = coerce(byItem, { sword: 2, shield: 1 }, ENV, 'f') as PyDict;
    expect(d).toBeInstanceOf(PyDict);
    expect(d.__getitem__(new ContentRef('item', 'sword'))).toBe(2);
    expect(coerce(byItem, d, ENV, 'f')).toBe(d);
    d.__setitem__(new ContentRef('item', 'bow'), 5);
    expect(toKernelForm(byItem, d, 'f')).toEqual({ sword: 2, shield: 1, bow: 5 });

    const byRing = resolveType(rt.dict(Ring, rt.list(rt.int)), 'f');
    const r = coerce(byRing, { bull: [1, 2] }, ENV, 'f') as PyDict;
    expect(r.__getitem__(Ring.BULL)).toEqual([1, 2]);
    expect(toKernelForm(byRing, r, 'f')).toEqual({ bull: [1, 2] });

    const byInt = resolveType(rt.dict(rt.int, rt.str), 'f');
    const n = coerce(byInt, { 3: 'c', '-1': 'z' }, ENV, 'f') as PyDict;
    expect([...n]).toEqual([3, -1]);
    expect(toKernelForm(byInt, n, 'f')).toEqual({ 3: 'c', '-1': 'z' });
    expect(code(() => coerce(byInt, { x: 'c' }, ENV, 'f'))).toBe('PP4102');
  });

  it('the kernel copies a PyDict deeply; its JSON form is keyed by stored keys', () => {
    const d = PyDict.from([['a', [1, 2]], [new PrefabRef('crate'), 3]]);
    const c = copy(d);
    expect(c).toBeInstanceOf(PyDict);
    expect(c).not.toBe(d);
    expect(c.__getitem__('a')).toEqual([1, 2]);
    expect(c.__getitem__('a')).not.toBe(d.__getitem__('a'));
    expect(JSON.parse(JSON.stringify(d))).toEqual({ a: [1, 2], crate: 3 });
    expect(JSON.stringify(PyDict.from([[1, true], [true, null]]))).toBe('{"1":null}');
    expect(JSON.stringify(new PySet(['x', 2]))).toBe('["x",2]');
    expect(code(() => toKernelForm(resolveType(rt.dict(rt.str, rt.int), 'f'), 3, 'f'))).toBe('PP4102');
  });

  it('sets are PySets (frozensets PyFrozenSets), stored as lists', () => {
    const tags = resolveType(rt.set(Tag), 'f');
    const s = coerce(tags, ['red', 'blue'], ENV, 'f') as PySet;
    expect(s).toBeInstanceOf(PySet);
    expect(s.__contains__(new Tag('red'))).toBe(true);
    s.add(new Tag('green'));
    expect(toKernelForm(tags, s, 'f')).toEqual(['red', 'blue', 'green']);
    expect(coerce(resolveType(rt.frozenset(rt.int), 'f'), [1, 2], ENV, 'f')).toBeInstanceOf(PyFrozenSet);
  });

  it('tuples are frozen arrays; tuple[T, ...] too', () => {
    const rest = resolveType(rt.tuple(PrefabRef, Ellipsis), 'f');
    const stored = ['a', 'b'];
    const t = coerce(rest, stored, ENV, 'f') as readonly unknown[];
    expect(Object.isFrozen(t)).toBe(true);
    expect(t[1]).toEqual(new PrefabRef('b'));
    expect(coerce(rest, t, ENV, 'f')).toBe(t);
    expect(toKernelForm(rest, t, 'f')).toEqual(['a', 'b']);

    const pair = resolveType(rt.tuple(rt.int, PrefabRef), 'f');
    const frozen = Object.freeze([1, 'crate']);
    const p = coerce(pair, frozen, ENV, 'f') as readonly unknown[];
    expect(Object.isFrozen(p)).toBe(true);
    expect(p).toEqual([1, new PrefabRef('crate')]);
    expect(coerce(pair, p, ENV, 'f')).toBe(p);
    expect(Object.isFrozen(toKernelForm(pair, p, 'f'))).toBe(true);
  });

  it('unions present the alternative the kernel stored', () => {
    const u = resolveType(rt.union(PrefabRef, rt.int), 'f');
    expect(coerce(u, 'crate', ENV, 'f')).toEqual(new PrefabRef('crate'));
    expect(coerce(u, 4, ENV, 'f')).toBe(4);
    expect(toKernelForm(u, new PrefabRef('crate'), 'f')).toBe('crate');
    expect(code(() => toKernelForm(u, true, 'f'))).toBe('PP4102');
  });

  it('a literal alternative that lists the string wins over a ref, whatever the order', () => {
    const u = resolveType(rt.union(rt.generic(ContentRef, itemClass()), rt.literal('rest')), 'f');
    expect(coerce(u, 'rest', ENV, 'f')).toBe('rest');
    expect(coerce(u, 'sword', ENV, 'f')).toEqual(new ContentRef('item', 'sword'));
  });

  it('Any presents JSON objects as dicts', () => {
    const any = resolveType(rt.any, 'f');
    const v = coerce(any, { a: { b: [1, { c: 2 }] } }, ENV, 'f') as PyDict;
    const inner = v.__getitem__('a') as PyDict;
    expect(inner).toBeInstanceOf(PyDict);
    expect((inner.__getitem__('b') as unknown[])[1]).toBeInstanceOf(PyDict);
    expect(toKernelForm(any, v, 'f')).toEqual({ a: inner });
    expect(JSON.parse(JSON.stringify(v))).toEqual({ a: { b: [1, { c: 2 }] } });
  });

  it('defaults are cloned per instance, dicts and sets included; tuples are shared', () => {
    const d = PyDict.from([['a', [1]]]);
    const c = cloneValue(d);
    expect(c).not.toBe(d);
    expect(c.__getitem__('a')).not.toBe(d.__getitem__('a'));
    const t = Object.freeze([1, 2]);
    expect(cloneValue(t)).toBe(t);
    const s = new PySet([1]);
    expect(cloneValue(s)).not.toBe(s);
  });
});
