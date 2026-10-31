/**
 * The layer rules, enforced. Rules that aren't tested drift; this is what
 * keeps the runtime from growing deep imports, a kernel that knows its plugins, or engine
 * code that reaches for the browser.
 */

import { describe, expect, it } from 'vitest';

declare global {
  interface ImportMeta {
    /** Vite's static glob import (vitest runs on Vite); only the form used here. */
    glob(pattern: string[], options: { query: '?raw'; import: 'default'; eager: true }): Record<string, string>;
  }
}

/** Every non-test source file, keyed by its path relative to src/ (e.g. `core/random.ts`). */
const SOURCES: Record<string, string> = Object.fromEntries(
  Object.entries(import.meta.glob(['./**/*.ts', '!./**/*.test.ts'], { query: '?raw', import: 'default', eager: true }))
    .map(([path, text]) => [path.slice(2), text]),
);

type Layer = 'core' | 'platform' | 'resource' | 'kernel' | 'services' | 'api' | 'boot' | `plugin:${string}`;

/** Which layers each layer may import (its own layer is always allowed). */
const ALLOWED: Record<string, readonly string[]> = {
  core: [],
  platform: ['core'],
  resource: ['core'],
  kernel: ['core', 'resource'],
  // Interfaces plugins provide to each other through `kernel.provide` / `kernel.service`.
  services: ['core', 'resource', 'kernel'],
  plugin: ['core', 'resource', 'kernel', 'services'],
  api: ['core', 'resource', 'kernel', 'services', 'plugin'],
  boot: ['core', 'platform', 'resource', 'kernel', 'services', 'plugin', 'api'],
};

/** Third-party packages each layer may import. Everything else stays dependency-free. */
const EXTERNAL_ALLOWED: Record<string, readonly string[]> = {
  plugin: ['@dimforge/rapier2d-compat', '@dimforge/rapier3d-compat'],
};

function kind(layer: Layer): string {
  return layer.startsWith('plugin:') ? 'plugin' : layer;
}

export function layerOf(srcRelative: string): Layer | null {
  const parts = srcRelative.split('/');
  const [top, sub, name] = parts;
  if (top === 'function') {
    if (sub === 'kernel') return 'kernel';
    if (sub === 'services' && parts.length > 2) return 'services';
    if (sub === 'plugins' && name !== undefined && parts.length > 3) return `plugin:${name}`;
    return null;
  }
  if (top === 'core' || top === 'platform' || top === 'resource' || top === 'api' || top === 'boot') {
    return parts.length > 1 ? top : null;
  }
  return null;
}

function entryOf(layer: Layer): string {
  if (layer === 'kernel') return 'function/kernel/index.ts';
  if (layer === 'services') return 'function/services/index.ts';
  if (layer.startsWith('plugin:')) return `function/plugins/${layer.slice('plugin:'.length)}/index.ts`;
  return `${layer}/index.ts`;
}

/** One import, judged against the rules. Returns a reason when it breaks one. */
export function checkImport(fromFile: string, specifier: string): string | null {
  const from = layerOf(fromFile);
  if (from === null) return `${fromFile} is not inside a layer`;

  if (!specifier.startsWith('.')) {
    const external = EXTERNAL_ALLOWED[kind(from)] ?? [];
    return external.some((pkg) => specifier === pkg || specifier.startsWith(`${pkg}/`))
      ? null
      : `${from} may not import the package "${specifier}"`;
  }

  const target = resolvePath(fromFile, specifier).replace(/\.js$/, '.ts');
  const to = layerOf(target);
  if (to === null) return `"${specifier}" resolves outside every layer (${target})`;
  if (to === from) return null;

  const allowed = ALLOWED[kind(from)] ?? [];
  if (!allowed.includes(kind(to))) return `${from} may not import ${to}`;
  if (kind(from) === 'plugin' && kind(to) === 'plugin') return `${from} may not import ${to}`;
  if (target !== entryOf(to)) return `cross-layer import must go through ${entryOf(to)}, not ${target}`;
  return null;
}

/** Resolve a relative specifier against a src-relative file, POSIX-style. */
function resolvePath(fromFile: string, specifier: string): string {
  const parts = fromFile.split('/').slice(0, -1);
  for (const segment of specifier.split('/')) {
    if (segment === '..') parts.pop();
    else if (segment !== '.') parts.push(segment);
  }
  return parts.join('/');
}

const IMPORT = /\bfrom\s+'([^']+)'|\bimport\s*\(\s*'([^']+)'\s*\)|\bimport\s+'([^']+)'/g;

describe('architecture', () => {
  it('every source file belongs to a layer and imports only what its layer allows', () => {
    const violations: string[] = [];
    expect(Object.keys(SOURCES).length).toBeGreaterThan(10);
    for (const [rel, text] of Object.entries(SOURCES)) {
      for (const match of text.matchAll(IMPORT)) {
        const specifier = match[1] ?? match[2] ?? match[3]!;
        const reason = checkImport(rel, specifier);
        if (reason !== null) violations.push(`${rel}: ${reason}`);
      }
      if (layerOf(rel) === null) violations.push(`${rel}: not inside a layer`);
    }
    expect(violations).toEqual([]);
  });

  it('rejects the imports the rules exist to prevent', () => {
    // The kernel never knows a plugin.
    expect(checkImport('function/kernel/world.ts', '../plugins/physics2d/index.js')).toMatch(/may not import/);
    // Plugins never import each other.
    expect(checkImport('function/plugins/combat/health.ts', '../physics2d/index.js')).toMatch(/may not import/);
    // The engine never touches the platform; only boot does.
    expect(checkImport('function/kernel/time.ts', '../../platform/index.js')).toMatch(/may not import/);
    // Core depends on nothing.
    expect(checkImport('core/values/vec2.ts', '../../resource/index.js')).toMatch(/may not import/);
    // One door per layer.
    expect(checkImport('function/kernel/world.ts', '../../core/values/vec2.js')).toMatch(/must go through core\/index\.ts/);
    // No third-party packages outside the layers that declare them.
    expect(checkImport('core/random.ts', 'seedrandom')).toMatch(/may not import the package/);
  });

  it('accepts the imports the rules allow', () => {
    expect(checkImport('function/kernel/world.ts', '../../core/index.js')).toBeNull();
    expect(checkImport('function/plugins/physics2d/bodies.ts', '../../kernel/index.js')).toBeNull();
    expect(checkImport('function/plugins/physics2d/world.ts', '@dimforge/rapier2d-compat')).toBeNull();
    expect(checkImport('boot/start.ts', '../platform/index.js')).toBeNull();
    expect(checkImport('core/values/vec2.ts', './vec3.js')).toBeNull();
  });
});
