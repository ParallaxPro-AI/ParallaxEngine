/**
 * Link check: before a build runs anywhere, every import reachable from the entry must
 * resolve — relative imports to compiled modules, `project` to the generated module, and
 * `parallax*` to an engine module this runtime ships (`ENGINE_MODULES` with its file
 * present). A gap is a coded diagnostic at build time, not a module error in a browser.
 */

import { existsSync, readFileSync } from 'node:fs';
import { diagnostic } from '@parallax/runtime/core';
import type { Diagnostic } from '@parallax/runtime/core';
import { ENGINE_MODULES, missingEngineModule, PROJECT_MODULE, PROJECT_MODULE_FILE } from '@parallax/runtime/boot';
import type { BuildManifest } from '@parallax/runtime/boot';
import { RUNTIME_SRC } from './paths.js';

const SPECIFIER = /^\s*(?:import|export)\b[^'"\n]*?\bfrom\s*'([^']+)'|^\s*import\s*'([^']+)'/gm;

/** Static import specifiers of a compiled module (the transpiler emits one per line, single-quoted). */
export function importsOf(js: string): string[] {
  return [...js.matchAll(SPECIFIER)].map((m) => (m[1] ?? m[2])!);
}

/** The engine modules whose source exists, by specifier → absolute path. */
export function availableEngineModules(runtimeSrc = RUNTIME_SRC): Map<string, string> {
  const out = new Map<string, string>();
  for (const [specifier, rel] of Object.entries(ENGINE_MODULES)) {
    if (existsSync(runtimeSrc + rel)) out.set(specifier, runtimeSrc + rel);
  }
  return out;
}

function join(dir: string, rel: string): string {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

/** Walk the modules reachable from the manifest's entry; report every import that won't resolve. */
export function checkLinks(buildDir: string, manifest: BuildManifest, runtimeSrc = RUNTIME_SRC): Diagnostic[] {
  if (manifest.entry === null) return [];
  const engine = availableEngineModules(runtimeSrc);
  const compiled = new Set(manifest.modules.flatMap((m) => (m.output === null ? [] : [m.output])));
  const sourceOf = new Map(manifest.modules.flatMap((m) => (m.output === null ? [] : [[m.output, m.source] as const])));
  const out: Diagnostic[] = [];
  const reported = new Set<string>();
  const seen = new Set<string>();
  const queue = [manifest.entry];
  while (queue.length > 0) {
    const module = queue.pop()!;
    if (seen.has(module)) continue;
    seen.add(module);
    const at = sourceOf.get(module) ?? module.replace(/\.js$/, '.py');
    if (!compiled.has(module) || !existsSync(`${buildDir}/${module}`)) {
      // Only the entry can get here uncompiled (imports are queued only when compiled); its
      // compile diagnostics say why. Reading it would crash the build (ENOENT).
      out.push(diagnostic('PP9504', `${at} did not transpile, so nothing it imports was linked`, {
        path: at, fix: 'Fix the transpilation errors reported for that module, then rebuild.',
      }));
      continue;
    }
    for (const specifier of importsOf(readFileSync(`${buildDir}/${module}`, 'utf8'))) {
      if (specifier.startsWith('.')) {
        const target = join(module.split('/').slice(0, -1).join('/'), specifier);
        if (compiled.has(target)) queue.push(target);
        else out.push(diagnostic('PP9504', `${at} imports ${specifier}, which did not transpile`, {
          path: at, fix: 'Fix the transpilation errors reported for that module, then rebuild.',
        }));
      } else if (specifier === PROJECT_MODULE) {
        if (!existsSync(`${buildDir}/${PROJECT_MODULE_FILE}`) && !reported.has(specifier)) {
          reported.add(specifier);
          out.push(diagnostic('PP9504', `The generated \`project\` module is missing (${PROJECT_MODULE_FILE})`, {
            path: at, fix: 'Fix the `parallax check` errors that stopped codegen, then rebuild.',
          }));
        }
      } else if (!engine.has(specifier) && !reported.has(specifier)) {
        reported.add(specifier);
        out.push(missingEngineModule(specifier, at));
      }
    }
  }
  return out;
}
