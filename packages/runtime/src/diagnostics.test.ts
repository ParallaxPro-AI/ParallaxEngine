/**
 * Diagnostic codes mean one thing. Every `'PPxxxx'` literal in the engine's sources
 * (packages/runtime, packages/check, packages/test; tests excluded) is filed under the area
 * that raises it — a plugin (its function/plugins/<name>/ directory, its api module and its
 * check module count as one), or the engine core (kernel, resource, core, the api core,
 * boot, platform and check's own passes). A code raised by two areas must be one of the
 * SHARED codes below, whose meaning is generic on purpose (a destroyed entity, a missing
 * asset, bad call arguments); anything else is a collision: two unrelated mistakes a reader
 * (or an AI fixing the error) can't tell apart.
 */

import { describe, expect, it } from 'vitest';

interface Fs {
  readFileSync(path: string, encoding: 'utf8'): string;
  readdirSync(path: string, options: { withFileTypes: true }): { name: string; isDirectory(): boolean }[];
}
// Node built-ins, untyped here: the runtime compiles without @types/node.
const load = (specifier: string): Promise<unknown> => import(/* @vite-ignore */ specifier);
const fs = await load('node:fs') as Fs;

const PACKAGES = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');

/** Codes several areas raise with the same meaning. */
const SHARED: Readonly<Record<string, string>> = {
  PP1002: 'a data file value has the wrong shape',
  PP2060: 'a locale key is missing',
  PP2062: 'an unknown text key',
  PP2063: 'a referenced file (asset, clip, locale) does not exist',
  PP2072: 'panel markup does not exist',
  PP2080: 'unknown panel',
  PP2082: 'the panel has no such action',
  PP3001: 'the entity lacks the component',
  PP3002: 'the entity was destroyed',
  PP3003: 'not a component',
  PP3004: 'an argument of the wrong kind (a Tag, a str key)',
  PP3030: 'call arguments do not bind (positional / keyword / missing)',
  PP3033: 'unknown ease',
  PP3247: 'the plugin is already installed in another kernel',
  PP3403: 'no such seat',
  PP3622: 'a voxel block definition (content/block) is malformed',
  PP3808: 'an effect file (.vfx.json, one schema in 2D and 3D) is malformed',
  PP3405: 'pointer.world needs a camera / renderer',
  PP3424: "a panel's state() must return a dict",
  PP9002: 'a malformed snapshot',
  PP9240: 'the plugin is used before its kernel was built',
  PP9250: 'the plugin is used before its kernel was built',
  PP9355: 'the server sent something this client cannot apply',
  PP9501: 'an engine module is not in this build',
  PP9502: 'the project has no entry to run (manifest, game/main.py)',
};

/**
 * Collisions inside areas other agents are rebuilding right now; each owner renumbers its
 * side when it lands. Kept short: a new collision fails the test.
 */
const PENDING: Readonly<Record<string, string>> = {
};

/**
 * Plugin areas by directory / api module / check module name. The model pipeline (visuals'
 * Model and Animator, the models plugin, render3d, resource/models) is one area.
 */
const ALIASES: Readonly<Record<string, string>> = {
  physics: 'physics', physics2d: 'physics', physics3d: 'physics', story: 'story',
  animation: 'visuals', model_sockets: 'visuals', model: 'visuals', visuals: 'visuals', models: 'visuals', render3d: 'visuals',
  action_input: 'input', character: 'characters', screens: 'screens',
};

/** Check modules that check several plugins' data: their codes belong to any of those. */
const CHECK_SPANS: Readonly<Record<string, readonly string[]>> = {
  'check:nature': ['water', 'weather', 'environment', 'foliage', 'wind'],
  'check:terrain': ['terrain', 'foliage', 'wind'],
  'check:physics': ['physics', 'destruction'],
  'check:vehicle_combat': ['vehicles', 'combat'],
  'check:characters': ['characters', 'viewmodel'],
  'check:niche': ['screens', 'softbody', 'payments', 'chat', 'voice'],
};

function plugins(): Set<string> {
  return new Set(fs.readdirSync(`${PACKAGES}/runtime/src/function/plugins`, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name));
}

function areaOf(path: string, pluginDirs: ReadonlySet<string>): string {
  const plugin = (name: string): string | undefined => (pluginDirs.has(name) || name in ALIASES ? ALIASES[name] ?? name : undefined);
  let m = /^runtime\/src\/function\/plugins\/([^/]+)\//.exec(path);
  if (m !== null) return plugin(m[1]!) ?? m[1]!;
  m = /^runtime\/src\/api\/([^/.]+)\.ts$/.exec(path);
  if (m !== null) return plugin(m[1]!) ?? 'core';
  m = /^check\/src\/([a-z0-9]+(?:_[a-z0-9]+)*)_checks\.ts$/.exec(path);
  if (m !== null) {
    const name = plugin(m[1]!) ?? m[1]!;
    return `check:${name}` in CHECK_SPANS ? `check:${name}` : plugin(m[1]!) ?? 'core';
  }
  if (path.startsWith('runtime/src/platform/browser/ui/')) return 'ui';
  if (path.startsWith('runtime/src/resource/models/')) return 'visuals';
  if (path.startsWith('test/')) return 'test';
  return 'core';
}

/** The areas a code is raised by, a spanning check module merged into a plugin it spans. */
function areasOf(byArea: ReadonlyMap<string, string>): Map<string, string> {
  const out = new Map(byArea);
  for (const [check, spanned] of Object.entries(CHECK_SPANS)) {
    if (out.has(check) && spanned.some((p) => out.has(p))) out.delete(check);
  }
  return out;
}

function walk(dir: string, out: string[]): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) { if (entry.name !== 'node_modules' && entry.name !== 'fixtures') walk(path, out); } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(path);
  }
  return out;
}

/** code → area → first message seen. */
function codeUses(): Map<string, Map<string, string>> {
  const dirs = plugins();
  const uses = new Map<string, Map<string, string>>();
  for (const root of ['runtime/src', 'check/src', 'test/src']) {
    for (const file of walk(`${PACKAGES}/${root}`, [])) {
      const rel = file.slice(PACKAGES.length + 1);
      const text = fs.readFileSync(file, 'utf8');
      for (const m of text.matchAll(/['"`](PP\d{4})['"`]\s*,\s*([^\n]*)/g)) {
        const area = areaOf(rel, dirs);
        const byArea = uses.get(m[1]!) ?? new Map<string, string>();
        if (!byArea.has(area)) byArea.set(area, `${rel}: ${m[2]!.slice(0, 80)}`);
        uses.set(m[1]!, byArea);
      }
    }
  }
  for (const [code, byArea] of uses) uses.set(code, areasOf(byArea));
  return uses;
}

describe('diagnostic codes', () => {
  const uses = codeUses();

  it('finds the codes it checks', () => {
    expect(uses.size).toBeGreaterThan(500);
  });

  it('no code is raised by two areas unless its meaning is shared on purpose', () => {
    const collisions = [...uses].filter(([code, areas]) => areas.size > 1 && SHARED[code] === undefined && PENDING[code] === undefined)
      .map(([code, areas]) => `${code}: ${[...areas].map(([a, where]) => `${a} (${where})`).join(' | ')}`);
    expect(collisions).toEqual([]);
  });

  it('the SHARED and PENDING lists hold only codes that are still used by several areas', () => {
    const stale = [...Object.keys(SHARED), ...Object.keys(PENDING)].filter((code) => (uses.get(code)?.size ?? 0) < 2);
    expect(stale).toEqual([]);
  });

});
