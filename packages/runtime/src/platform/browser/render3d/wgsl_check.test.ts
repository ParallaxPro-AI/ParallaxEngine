/**
 * WGSL parse checks for every shader the WebGPU backend compiles, headless:
 *
 *   - a template-list rule: WGSL reads `ident < … >` as a template list (`select(a < b, c >= d, …)`
 *     fails to parse), so a `<` after an identifier must not be followed by a `>` before the
 *     expression ends — parenthesize the comparison;
 *   - when `naga` (the wgpu shader translator) is installed, every module is validated by it.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { POST_PASSES, wgslPost } from './post_shaders.js';
import type { PostVariant } from './post_shaders.js';
import { sceneVariants, wgsl } from './shaders.js';
import { WGSL_MIPMAP } from './webgpu.js';
import { wgslBake, wgslImpostor } from './impostors.js';
import { wgslDecal } from './decals.js';
import { wgslParticles, wgslRibbons } from './vfx.js';
import { wgslSky } from './sky_shaders.js';
import { wgslWater } from './water_shaders.js';

const TEMPLATED = /^(var|vec[234]|mat[234]x[234]|array|ptr|atomic|bitcast|texture_\w+)$/;

/** Comparisons WGSL would take for the start of a template list: `ident <` with a `>` later at the same depth. */
export function templateTraps(source: string): string[] {
  const traps: string[] = [];
  const text = source.replace(/\/\/.*$/gm, '');
  const start = /\b([A-Za-z_]\w*)\s*<(?![<=])/g;
  for (let m = start.exec(text); m !== null; m = start.exec(text)) {
    // Template types (`vec4<f32>`, `array<T, N>`, `texture_2d<f32>`) are what `<` after a type name means.
    if (TEMPLATED.test(m[1]!)) continue;
    let depth = 0;
    for (let i = m.index + m[0].length; i < text.length; i++) {
      const c = text[i]!;
      if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') {
        if (depth === 0) break;
        depth--;
      } else if (c === ';' || c === '{' || c === '}' || c === ':' || (c === '&' && text[i + 1] === '&') || (c === '|' && text[i + 1] === '|')) {
        break;
      } else if (c === '>' && text[i - 1] !== '-' && depth === 0) {
        const line = text.slice(text.lastIndexOf('\n', m.index) + 1, text.indexOf('\n', m.index));
        traps.push(line.trim());
        break;
      }
    }
  }
  return traps;
}

/** Every WGSL module the WebGPU backend builds. */
function modules(): [string, string][] {
  const out: [string, string][] = [];
  for (const { pass, variant } of sceneVariants()) out.push([`${pass} ${JSON.stringify(variant)}`, wgsl(pass, variant)]);
  const postVariants: Record<string, PostVariant[]> = {
    ao: [{ scale: 1, samples: 12 }, { scale: 2, samples: 8 }], aoBlur: [{ scale: 1 }, { scale: 2 }], present: [{ fxaa: true }, { fxaa: false }],
    volumetric: [{ samples: 24 }], godRays: [{ samples: 24 }, { samples: 40 }],
  };
  for (const pass of POST_PASSES) for (const v of postVariants[pass] ?? [{}]) out.push([`post ${pass} ${JSON.stringify(v)}`, wgslPost(pass, v)]);
  out.push(['mipmap', WGSL_MIPMAP]);
  out.push(['impostor bake', wgslBake()], ['impostor', wgslImpostor(false)], ['impostor mrt', wgslImpostor(true)], ['decal', wgslDecal()]);
  for (const additive of [false, true]) out.push([`vfx particles ${additive}`, wgslParticles(additive)], [`vfx ribbons ${additive}`, wgslRibbons(additive)]);
  for (const q of [0, 1, 2]) for (const clouds of ['flat', 'volumetric'] as const) out.push([`nature sky ${q} ${clouds}`, wgslSky(q, clouds)]);
  out.push(['nature water', wgslWater()]);
  return out;
}

const NAGA = [join(homedir(), '.cargo', 'bin', 'naga'), '/opt/homebrew/bin/naga', '/usr/local/bin/naga'].find((p) => existsSync(p));

describe('WGSL parses', () => {
  it('the template-list rule catches `select(a < b, c >= d, …)` and passes parenthesized comparisons', () => {
    expect(templateTraps('return select(n < 1.0 + f, n >= f, f >= 0.0);')).toHaveLength(1);
    expect(templateTraps('return select((n < 1.0 + f), (n >= f), f >= 0.0);')).toEqual([]);
    expect(templateTraps('let v: vec4<f32> = vec4<f32>(1.0); if (a < b) { x = 1; }')).toEqual([]);
    expect(templateTraps('let k = min(a < b, c > d);')).toHaveLength(1);
    expect(templateTraps('fn f() -> f32 { return a; }')).toEqual([]);
  });

  it.each(modules())('%s: no comparison reads as a template list', (_name, source) => {
    expect(templateTraps(source)).toEqual([]);
  });

  it.runIf(NAGA !== undefined)('naga validates every module', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wgsl-'));
    try {
      const failures: string[] = [];
      for (const [name, source] of modules()) {
        const file = join(dir, 'shader.wgsl');
        writeFileSync(file, source);
        try {
          execFileSync(NAGA!, [file], { stdio: 'pipe' });
        } catch (error) {
          failures.push(`${name}: ${String((error as { stderr?: Buffer }).stderr ?? error).slice(0, 400)}`);
        }
      }
      expect(failures).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
