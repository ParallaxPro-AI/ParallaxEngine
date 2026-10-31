/**
 * Every SDK module is wired end to end. For each `sdk/parallax/<module>.pyi`:
 *
 *   - boot's ENGINE_MODULES maps `parallax/<module>` to an api source file that exists;
 *   - a module that declares components (`@component(...)`) has a PLUGINS_OF_MODULE entry
 *     in the transpiler's extract pass (check reads which plugin a component needs from it),
 *     and those plugin ids are factories in `parallax.plugins`;
 *   - every factory `parallax.plugins` declares is exported by `api/plugins.ts`;
 *   - a module's main `...Api` class (one no other Api class of the module holds) is a
 *     `Context` attribute, and the factory of the module's plugin mounts its namespace under
 *     that attribute name.
 */

import { describe, expect, it } from 'vitest';
import * as plugins from '../api/plugins.js';
import { ENGINE_MODULES } from './modules.js';

interface Fs {
  readFileSync(path: string, encoding: 'utf8'): string;
  readdirSync(path: string): string[];
  existsSync(path: string): boolean;
}
// Node built-ins, untyped here: the runtime compiles without @types/node.
const load = (specifier: string): Promise<unknown> => import(/* @vite-ignore */ specifier);
const fs = await load('node:fs') as Fs;

const SRC = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const SDK = `${SRC}/../../../sdk/parallax`;
const DECLARE = `${SRC}/../../transpiler/parallax_transpiler/extract/declare.py`;

/**
 * SDK files that aren't engine modules: the core module, the factories, and `parallax.test`
 * (served by packages/test's runner to test files only, never to game code).
 */
const NOT_MODULES = new Set(['__init__', 'plugins', 'test']);

const modules = fs.readdirSync(SDK).filter((f) => f.endsWith('.pyi')).map((f) => f.slice(0, -4)).filter((m) => !NOT_MODULES.has(m)).sort();
const sdk = (module: string): string => fs.readFileSync(`${SDK}/${module}.pyi`, 'utf8');

/** declare.py's PLUGINS_OF_MODULE, read as data. */
function pluginsOfModule(): Map<string, string[]> {
  const text = fs.readFileSync(DECLARE, 'utf8');
  const block = /PLUGINS_OF_MODULE[^=]*=\s*\{([\s\S]*?)\n\}/.exec(text);
  if (block === null) throw new Error('PLUGINS_OF_MODULE not found in declare.py');
  const out = new Map<string, string[]>();
  for (const m of block[1]!.matchAll(/"([\w.]+)":\s*\[([^\]]*)\]/g)) out.set(m[1]!, [...m[2]!.matchAll(/"(\w+)"/g)].map((x) => x[1]!));
  return out;
}

/** Factory names `parallax.plugins` declares, with whether every parameter has a default. */
function factories(): Map<string, { optionalOnly: boolean }> {
  const text = sdk('plugins');
  const out = new Map<string, { optionalOnly: boolean }>();
  for (const m of text.matchAll(/^def (\w+)\(([\s\S]*?)\)\s*->\s*Plugin/gm)) {
    const params = m[2]!.split(',').map((p) => p.trim()).filter((p) => p !== '' && p !== '*');
    out.set(m[1]!, { optionalOnly: params.every((p) => p.includes('=')) });
  }
  return out;
}

/** The module's main Api class: an `...Api` class no other one of the module holds or returns. */
function mainApi(text: string): string | undefined {
  const apis = [...text.matchAll(/^class (\w+Api)\b/gm)].map((m) => m[1]!);
  const held = new Set([
    ...[...text.matchAll(/^\s+\w+:\s*(\w+Api)\b/gm)].map((m) => m[1]!),
    ...[...text.matchAll(/->\s*(\w+Api)\b/g)].map((m) => m[1]!),
  ]);
  const main = apis.filter((a) => !held.has(a));
  if (main.length > 1) throw new Error(`several top-level Api classes: ${main.join(', ')}`);
  return main[0];
}

/** `Context` attributes typed `parallax.<module>.<Api>`. */
function contextAttributes(): Map<string, string> {
  const text = sdk('__init__');
  const out = new Map<string, string>();
  for (const m of text.matchAll(/^\s+(\w+):\s*parallax\.(\w+)\.(\w+Api)\b/gm)) out.set(`${m[2]!}.${m[3]!}`, m[1]!);
  return out;
}

describe('SDK modules are wired through boot, the transpiler, the plugin factories and ctx', () => {
  const ofModule = pluginsOfModule();
  const factoryList = factories();

  it.each(modules)('parallax.%s has an ENGINE_MODULES entry whose source exists', (module) => {
    const file = ENGINE_MODULES[`parallax/${module}`];
    expect(file, `boot/modules.ts ENGINE_MODULES lacks 'parallax/${module}'`).toBeDefined();
    expect(fs.existsSync(`${SRC}/${file}`), `${file} does not exist`).toBe(true);
  });

  it.each(modules)('parallax.%s: components → a PLUGINS_OF_MODULE entry naming factories', (module) => {
    if (!/^@component\(/m.test(sdk(module))) return;
    const ids = ofModule.get(`parallax.${module}`);
    expect(ids, `declare.py PLUGINS_OF_MODULE lacks "parallax.${module}"`).toBeDefined();
    for (const id of ids!) expect(factoryList.has(id), `plugin "${id}" (parallax.${module}) is not a parallax.plugins factory`).toBe(true);
  });

  it('reads the tables it compares (a parse that finds nothing would pass everything)', () => {
    expect(modules.length).toBeGreaterThan(20);
    expect(ofModule.size).toBeGreaterThan(20);
    expect(factoryList.size).toBeGreaterThan(20);
    expect(contextAttributes().size).toBeGreaterThan(15);
    expect(factoryList.get('interaction')?.optionalOnly).toBe(false);
    expect(mainApi(sdk('ai'))).toBe('AiApi');
    expect(mainApi(sdk('city'))).toBe('CityApi');
  });

  it('every parallax.plugins factory is exported by api/plugins.ts', () => {
    const missing = [...factoryList.keys()].filter((name) => typeof (plugins as Record<string, unknown>)[name] !== 'function');
    expect(missing).toEqual([]);
  });

  // The naming rule: plugin factory = module = ctx attribute = `<Name>Api`. The one exception is
  // physics, whose two factories (physics2d / physics3d) share the module and `ctx.physics`.
  const SHARED_MODULE: Readonly<Record<string, readonly string[]>> = { physics: ['physics2d', 'physics3d'] };
  const pascal = (name: string): string => name.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');

  it.each(modules)('parallax.%s follows the naming rule (factory = module = ctx attribute = <Name>Api)', (module) => {
    const ids = ofModule.get(`parallax.${module}`);
    if (ids !== undefined) expect(ids, `parallax.${module}'s plugin factory must be ${module}()`).toEqual(SHARED_MODULE[module] ?? [module]);
    const api = mainApi(sdk(module));
    if (api === undefined) return;
    expect(api, `parallax.${module}'s main Api class must be ${pascal(module)}Api`).toBe(`${pascal(module)}Api`);
    expect(contextAttributes().get(`${module}.${api}`), `ctx.${module} must be typed parallax.${module}.${api}`).toBe(module);
  });

  it.each(modules)("parallax.%s: its main Api is a ctx attribute, and its plugin mounts it there", (module) => {
    const api = mainApi(sdk(module));
    if (api === undefined) return;
    const attribute = contextAttributes().get(`${module}.${api}`);
    expect(attribute, `Context has no attribute typed parallax.${module}.${api}`).toBeDefined();
    const ids = ofModule.get(`parallax.${module}`) ?? [];
    expect(ids.length, `parallax.${module} has an Api but no plugin in PLUGINS_OF_MODULE`).toBeGreaterThan(0);
    for (const id of ids) {
      if (!factoryList.get(id)?.optionalOnly) continue;
      const plugin = (plugins as Record<string, () => { namespace?: { name: string } }>)[id]!();
      expect(plugin.namespace?.name, `${id}() mounts no ctx.${attribute}`).toBe(attribute);
    }
  });
});
