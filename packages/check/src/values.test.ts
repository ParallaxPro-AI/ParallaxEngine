import { describe, expect, it } from 'vitest';
import type { Diagnostic } from '@parallax/runtime/core';
import type { DeclaredSchema } from './declarations.js';
import { refsIn, Validator } from './values.js';
import type { RefIndex } from './values.js';

const refs: RefIndex = {
  missing: (to, id) => (to === 'prefab' && id !== 'ball' ? { code: 'PP2041', known: ['ball'], what: 'prefab' } : undefined),
};

function field(type: DeclaredSchema[string]['type'], extra: Partial<DeclaredSchema[string]> = {}): DeclaredSchema[string] {
  return { type, annotation: 'x', line: 1, ...extra };
}

const SCHEMA: DeclaredSchema = {
  speed: field({ kind: 'number' }, { default: 1, min: 0, max: 10 }),
  lives: field({ kind: 'int' }),
  at: field({ kind: 'vec2' }, { default: [0, 0] }),
  tint: field({ kind: 'color' }, { default: '#fff' }),
  mode: field({ kind: 'enum', values: ['easy', 'hard'] }, { default: 'easy' }),
  spawn: field({ kind: 'ref', to: 'prefab' }, { default: 'ball' }),
  drops: field({ kind: 'list', of: { kind: 'ref', to: 'prefab' } }, { default: [] }),
  waves: field({ kind: 'list', of: { kind: 'record', fields: { count: { type: { kind: 'int' }, default: 1 } } } }, { default: [] }),
  owner: field({ kind: 'json' }, { runtime_only: true }),
  plane: field({ kind: 'string' }, { default: 'xy', choices: ['xy', 'xz'] }),
};

function check(data: Record<string, unknown>, complete = false): Diagnostic[] {
  const out: Diagnostic[] = [];
  new Validator(refs, out).fields(SCHEMA, data as never, 'thing', { path: 'a.json', pointer: '' }, complete);
  return out;
}

describe('Validator', () => {
  it('accepts valid data', () => {
    expect(check({ speed: 3, lives: 2, at: [1, 2], tint: [1, 0, 0], mode: 'hard', spawn: 'ball', drops: ['ball'], waves: [{ count: 2 }] }, true)).toEqual([]);
  });

  it('reports every problem with its pointer, like the kernel decode would', () => {
    const found = check({ speed: 11, lives: 1.5, at: [1], tint: '#ggg', mode: 'hrad', spawn: 'bal', drops: ['x'], waves: [{ count: 'many' }], sped: 1 });
    expect(found.map((d) => [d.code, d.pointer])).toEqual([
      ['PP4103', '/speed'], ['PP4102', '/lives'], ['PP4102', '/at'], ['PP4101', '/tint'], ['PP4102', '/mode'],
      ['PP2041', '/spawn'], ['PP2041', '/drops/0'], ['PP4102', '/waves/0/count'], ['PP4104', '/sped'],
    ]);
    expect(found.find((d) => d.pointer === '/mode')!.fix).toBe('Change it to "hard".');
    expect(found.find((d) => d.pointer === '/spawn')!.fix).toBe('Change "bal" to "ball".');
    expect(found.find((d) => d.code === 'PP4104')!.fix).toBe('Did you mean "speed"?');
  });

  it('requires fields without defaults only in complete documents', () => {
    expect(check({})).toEqual([]);
    expect(check({}, true).map((d) => d.message)).toEqual(['thing.lives is required']);
  });

  it('rejects live handles and values outside choices', () => {
    expect(check({ owner: 'p1', plane: 'yz' }).map((d) => d.code)).toEqual(['PP4108', 'PP4109']);
  });

  it('finds refs through lists and records', () => {
    expect(refsIn(SCHEMA, { spawn: 'ball', drops: ['a', 'b'] } as never, '')).toEqual([
      { to: 'prefab', id: 'ball', pointer: '/spawn' },
      { to: 'prefab', id: 'a', pointer: '/drops/0' },
      { to: 'prefab', id: 'b', pointer: '/drops/1' },
    ]);
  });
});
