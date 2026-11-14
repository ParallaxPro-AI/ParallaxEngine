/**
 * Ids the runtime refuses at start-up, caught by `parallax check`: a component, event or
 * resource named like the engine's (PP2010) and a panel named like a built-in panel
 * (PP4420). Each case changes the brick_breaker example's declarations in memory.
 */

import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { BUILTIN_PANEL_IDS } from '@parallax/runtime/core';
import type { Diagnostic } from '@parallax/runtime/core';
import { checkFiles } from './check.js';
import type { Declarations } from './declarations.js';
import { runExtract } from './extract.js';
import { directoryFiles, memoryFiles } from './files.js';

const EXAMPLE = fileURLToPath(new URL('../../../examples/brick_breaker', import.meta.url));

let files: Record<string, string>;
let declarations: Declarations;

beforeAll(() => {
  const tree = directoryFiles(EXAMPLE);
  files = {};
  for (const path of tree.all()) if (!/\.(png|glb|ogg|mp3|wav)$/.test(path)) files[path] = tree.read(path);
  const extracted = runExtract(EXAMPLE);
  if (!extracted.ok) throw new Error(extracted.diagnostic.message);
  declarations = extracted.declarations;
});

function run(edit: (d: Declarations) => Declarations): readonly Diagnostic[] {
  return checkFiles(memoryFiles(files), edit(structuredClone(declarations)), { assetFiles: false }).diagnostics;
}

const brief = (found: readonly Diagnostic[]): string[] => found.map((x) => `${x.code} ${x.path}:${x.line}`);
const withoutPlugin = (d: Declarations, id: string): Declarations => ({ ...d, game: { ...d.game!, plugins: d.game!.plugins.filter((p) => p.id !== id) } });
const located = { module: 'game.parts', feature: null, path: 'game/parts.py', line: 7 };

describe('ids the engine already uses', () => {
  it('a component named like an engine component of a listed plugin is PP2010, naming the plugin', () => {
    const clash = (d: Declarations): Declarations => ({
      ...d, components: { ...d.components, rigidbody: { ...located, name: 'Body', fields: d.engine.components['rigidbody']!.fields, localized: [] } },
    });
    // (The prefabs' rigidbody data is now read against Body too; only the clash matters here.)
    const found = run(clash).filter((x) => x.code === 'PP2010');
    expect(brief(found)).toEqual(['PP2010 game/parts.py:7']);
    expect(found[0]!.message).toBe('Two component definitions are named "rigidbody": Body and the engine\'s Rigidbody (from physics3d())');
    // Without the plugin there is no engine component to clash with (only the missing plugin's own errors remain).
    expect(run((d) => clash(withoutPlugin(d, 'physics3d'))).filter((x) => x.code === 'PP2010')).toEqual([]);
  });

  it('an event named like an engine event from core or a listed plugin is PP2010', () => {
    const engine = declarations.engine.events;
    const [id, builtIn] = Object.entries(engine).find(([, e]) => e.plugins.includes('core') || e.plugins.includes('physics3d'))!;
    const clash = (eventId: string) => (d: Declarations): Declarations => ({
      ...d, events: { ...d.events, [eventId]: { ...located, name: 'Mine', fields: {} } },
    });
    const found = run(clash(id));
    expect(brief(found)).toEqual(['PP2010 game/parts.py:7']);
    expect(found[0]!.message).toContain(builtIn.name);
    // An event of a plugin the game does not list is free.
    const unlisted = Object.entries(engine).find(([, e]) => !e.plugins.includes('core') && e.plugins.every((p) => !declarations.game!.plugins.some((u) => u.id === p)))![0];
    expect(run(clash(unlisted))).toEqual([]);
  });

  it('a resource named like an engine resource ("settings") is PP2010 at its declaration', () => {
    const found = run((d) => {
      const [id, decl] = Object.entries(d.resources)[0]!;
      const resources = { ...d.resources };
      delete resources[id];
      return { ...d, resources: { ...resources, settings: { ...decl, ...located } } };
    });
    expect(brief(found)).toEqual(['PP2010 game/parts.py:7']);
    expect(found[0]!.message).toContain('@resource("settings")');
  });

  it('a resource named like a plugin\'s resource clashes only when the game lists that plugin', () => {
    const clash = (plugin: string) => (d: Declarations): Declarations => {
      const [id, decl] = Object.entries(d.resources)[0]!;
      const resources = { ...d.resources };
      delete resources[id];
      const engineResource = { name: 'Forecast', module: 'parallax.forecast', plugins: [plugin], fields: {} };
      return {
        ...d, resources: { ...resources, forecast: { ...decl, ...located } },
        engine: { ...d.engine, resources: { ...d.engine.resources, forecast: engineResource } },
      };
    };
    const listed = run(clash('grid'));
    expect(brief(listed)).toEqual(['PP2010 game/parts.py:7']);
    expect(listed[0]!.message).toBe('@resource("forecast") is already grid()\'s parallax.forecast.Forecast');
    expect(run(clash('vehicles')).filter((x) => x.code === 'PP2010')).toEqual([]);
  });

  it('a panel with a built-in panel\'s id (dialogue, the HUD kit\'s) is PP4420', () => {
    expect(BUILTIN_PANEL_IDS).toContain('dialogue');
    const found = run((d) => {
      const any = Object.values(d.panels)[0]!;
      return { ...d, panels: { ...d.panels, dialogue: { ...any, name: 'Talk', path: 'game/ui.py', line: 12 }, hud_minimap: { ...any, name: 'Map', path: 'game/ui.py', line: 30 } } };
    });
    expect(brief(found)).toEqual(['PP4420 game/ui.py:12', 'PP4420 game/ui.py:30']);
  });
});
