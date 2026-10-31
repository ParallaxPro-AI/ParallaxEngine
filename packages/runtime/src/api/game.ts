/**
 * `Game(...)` and `Feature(...)`: the entry point and its slices. Run order of systems:
 * each feature's systems in feature order, then `Game(systems=[...])`, each system moved
 * after the systems its `after=` names. A system without `scenes=` takes its feature's.
 */

import { closestMatch, fail } from '../core/index.js';
import type { UiCursor } from '../core/index.js';
import type { KernelPlugin } from '../function/kernel/index.js';
import { systemOptions } from './declarations.js';
import { bindArgs } from './kwargs.js';
import { SceneRef } from './types.js';

function list(value: unknown): unknown[] {
  return value === undefined || value === null ? [] : [...(value as Iterable<unknown>)];
}

export class Feature {
  readonly id: string;
  readonly requires: readonly string[];
  readonly systems: readonly unknown[];
  readonly scenes: readonly unknown[];
  readonly doc: string | null;

  constructor(...args: unknown[]) {
    const a = bindArgs('Feature', args, { positional: ['id'], keyword: ['requires', 'systems', 'scenes', 'doc'], required: ['id'] }).args;
    if (typeof a['id'] !== 'string') fail('PP4113', 'Feature id must be a str');
    this.id = a['id'];
    this.requires = list(a['requires']) as string[];
    this.systems = list(a['systems']);
    this.scenes = list(a['scenes']);
    this.doc = (a['doc'] ?? null) as string | null;
  }
}

/** One system of the game, with the scene scope it runs under. */
export interface GameSystem {
  readonly cls: unknown;
  readonly scenes: readonly unknown[];
}

export class Game {
  readonly id: string;
  readonly title: string;
  readonly sdk: string;
  readonly start_scene: SceneRef;
  readonly mode: '2d' | '3d';
  readonly plugins: readonly KernelPlugin[];
  readonly features: readonly Feature[];
  readonly systems: readonly unknown[];
  readonly languages: readonly string[];
  readonly save_version: number;
  /** `cursor=Cursor(...)`: the look of the cursor the engine draws; null = the engine ring. */
  readonly cursor: UiCursor | null;
  /**
   * `pointer_lock=False`: a host that locks the pointer for play (an editor's Play) leaves
   * this game the OS cursor. Default True. Mouse-look still locks on a press either way.
   */
  readonly pointer_lock: boolean;

  constructor(...args: unknown[]) {
    const a = bindArgs('Game', args, {
      keyword: ['id', 'title', 'sdk', 'start_scene', 'mode', 'plugins', 'features', 'systems', 'languages', 'save_version', 'cursor', 'pointer_lock'],
      required: ['id', 'title', 'sdk', 'start_scene', 'mode'],
    }).args;
    if (typeof a['id'] !== 'string' || typeof a['title'] !== 'string' || typeof a['sdk'] !== 'string') {
      fail('PP4113', 'Game id=, title= and sdk= must be strings');
    }
    if (!(a['start_scene'] instanceof SceneRef)) fail('PP4113', 'Game start_scene= must be a scene (Scenes.<id>)');
    if (a['mode'] !== '2d' && a['mode'] !== '3d') fail('PP4113', `Game mode= must be "2d" or "3d", got ${JSON.stringify(a['mode'])}`);
    this.id = a['id'];
    this.title = a['title'];
    this.sdk = a['sdk'];
    this.start_scene = a['start_scene'];
    this.mode = a['mode'];
    this.plugins = list(a['plugins']).map((p) => {
      if (typeof p !== 'object' || p === null || typeof (p as KernelPlugin).id !== 'string') {
        fail('PP4113', `Game plugins= takes plugins (physics2d(), combat()…), got ${String(p)}`);
      }
      return p as KernelPlugin;
    });
    this.features = list(a['features']).map((f) => {
      if (!(f instanceof Feature)) fail('PP4113', 'Game features= takes Feature(...) values');
      return f;
    });
    this.systems = list(a['systems']);
    this.languages = a['languages'] === undefined ? ['en'] : (list(a['languages']) as string[]);
    if (this.languages.length === 0) fail('PP4113', 'Game languages= needs at least the source language');
    this.save_version = (a['save_version'] ?? 1) as number;
    const cursor = a['cursor'] ?? null;
    // Duck-typed: ui.ts (Cursor) imports this module's neighbours, not the other way round.
    const look = (cursor as { __cursor__?: UiCursor } | null)?.__cursor__;
    if (cursor !== null && look === undefined) fail('PP4113', `Game cursor= takes a Cursor(...), got ${String(cursor)}`);
    this.cursor = look ?? null;
    const lock = a['pointer_lock'] ?? true;
    if (typeof lock !== 'boolean') fail('PP4113', `Game pointer_lock= takes True or False, got ${String(lock)}`);
    this.pointer_lock = lock;
  }

  /** Every system in run order, with its effective scene scope. */
  orderedSystems(): GameSystem[] {
    const listed: GameSystem[] = [
      ...this.features.flatMap((f) => f.systems.map((cls) => ({ cls, scenes: scopeOf(cls, f.scenes) }))),
      ...this.systems.map((cls) => ({ cls, scenes: scopeOf(cls, []) })),
    ];
    const seen = new Set<unknown>();
    for (const s of listed) {
      if (seen.has(s.cls)) fail('PP2010', `System ${systemOptions(s.cls).id} is listed twice`);
      seen.add(s.cls);
    }
    return orderAfter(listed);
  }
}

function scopeOf(cls: unknown, featureScenes: readonly unknown[]): readonly unknown[] {
  const own = systemOptions(cls).scenes;
  return own.length > 0 ? own : featureScenes;
}

/** Listed order, except that each system runs after every system its `after=` names. */
function orderAfter(listed: readonly GameSystem[]): GameSystem[] {
  const ids = listed.map((s) => systemOptions(s.cls).id);
  const ordered: GameSystem[] = [];
  const placed = new Set<unknown>();
  const visiting = new Set<unknown>();
  const visit = (s: GameSystem): void => {
    if (placed.has(s.cls)) return;
    const options = systemOptions(s.cls);
    if (visiting.has(s.cls)) fail('PP4114', `System ${options.id} is part of an after= cycle`);
    visiting.add(s.cls);
    for (const dependency of options.after) {
      const target = listed.find((x) => x.cls === dependency);
      if (target === undefined) {
        const name = typeof dependency === 'function' ? (dependency as { __system_id__?: string }).__system_id__ ?? dependency.name : String(dependency);
        const guess = closestMatch(String(name), ids);
        fail('PP4114', `System ${options.id} runs after ${name}, which the game doesn't list`, {
          fix: guess !== undefined ? `Did you mean ${guess}?` : 'Add it to Game(systems=[...]) or a Feature.',
        });
      }
      visit(target);
    }
    visiting.delete(s.cls);
    placed.add(s.cls);
    ordered.push(s);
  };
  for (const s of listed) visit(s);
  return ordered;
}
