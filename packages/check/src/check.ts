/**
 * `checkProject(dir)`: load the data files, run the declarations pass, check the two
 * against each other, and generate the `project` module.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { formatDiagnostic } from '@parallax/runtime/core';
import type { Diagnostic } from '@parallax/runtime/core';
import { loadProject } from '@parallax/runtime/resource';
import { checkAi } from './ai_checks.js';
import { checkAnimation } from './animation_checks.js';
import { checkCharacters } from './character_checks.js';
import { checkCode } from './code_checks.js';
import { generateProject } from './codegen.js';
import type { ProjectModule } from './codegen.js';
import { CheckContext } from './context.js';
import type { CheckOptions } from './context.js';
import { checkData } from './data_checks.js';
import type { Declarations } from './declarations.js';
import { extractDiagnostics, runExtract } from './extract.js';
import { checkLook } from './look_checks.js';
import { checkLook2d } from './look2d_checks.js';
import { checkModels } from './model_checks.js';
import { checkNature } from './nature_checks.js';
import { checkHud } from './hud_checks.js';
import { checkEconomy } from './economy_checks.js';
import { checkCinematics } from './cinematics_checks.js';
import { checkVehiclesCombat } from './vehicle_combat_checks.js';
import { checkNiche } from './niche_checks.js';
import { directoryFiles } from './files.js';
import type { ProjectTree } from './files.js';
import { checkPhysics } from './physics_checks.js';
import { checkProcgen } from './procgen_checks.js';
import { checkStory } from './story_checks.js';
import { checkTerrain } from './terrain_checks.js';
import { checkShapes2d } from './render2d_checks.js';
import { checkEffects } from './vfx_checks.js';
import { checkTilemaps } from './tilemap_checks.js';
import { checkVoxels } from './voxel_checks.js';
import { checkUi } from './ui_checks.js';

export interface CheckResult {
  readonly diagnostics: readonly Diagnostic[];
  readonly declarations?: Declarations;
  readonly project?: ProjectModule;
  readonly errors: number;
  readonly warnings: number;
}

export interface CheckProjectOptions extends CheckOptions {
  /**
   * Where to write declarations.json, project.js and project.pyi: a directory, or false
   * to write nothing. Default: `<project>/build`.
   */
  readonly outDir?: string | false;
}

/** Checks over already-extracted declarations (no Python, no disk writes). */
export function checkFiles(files: ProjectTree, declarations: Declarations, options: CheckOptions = {}): CheckResult {
  const project = loadProject(files);
  const ctx = new CheckContext(files, project, declarations, options);
  ctx.out.push(...project.diagnostics, ...extractDiagnostics(declarations));
  checkData(ctx);
  checkModels(ctx);
  checkCode(ctx);
  checkUi(ctx);
  checkStory(ctx);
  checkAnimation(ctx);
  checkHud(ctx);
  checkAi(ctx);
  checkPhysics(ctx);
  checkProcgen(ctx);
  checkTerrain(ctx);
  checkNature(ctx);
  checkCharacters(ctx);
  checkEconomy(ctx);
  checkCinematics(ctx);
  checkVehiclesCombat(ctx);
  checkNiche(ctx);
  checkTilemaps(ctx);
  checkShapes2d(ctx);
  checkEffects(ctx);
  checkVoxels(ctx);
  checkLook(ctx);
  checkLook2d(ctx);
  const generated = generateProject(ctx);
  return summarize(ctx.out, declarations, generated);
}

export function checkProject(dir: string, options: CheckProjectOptions = {}): CheckResult {
  const files = directoryFiles(dir);
  const extracted = runExtract(dir);
  if (!extracted.ok) return summarize([extracted.diagnostic]);
  const result = checkFiles(files, extracted.declarations, options);
  const outDir = options.outDir ?? `${dir}/build`;
  if (outDir !== false && result.project !== undefined) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(`${outDir}/declarations.json`, extracted.text.endsWith('\n') ? extracted.text : `${extracted.text}\n`);
    writeFileSync(`${outDir}/project.js`, result.project.js);
    writeFileSync(`${outDir}/project.pyi`, result.project.pyi);
  }
  return result;
}

function summarize(diagnostics: readonly Diagnostic[], declarations?: Declarations, project?: ProjectModule): CheckResult {
  // A base scene's placement is checked again for every scene extending it: report each problem once.
  const seen = new Set<string>();
  const unique = diagnostics.filter((d) => {
    const key = `${d.code}|${d.path ?? ''}|${d.pointer ?? ''}|${d.line ?? ''}|${d.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const sorted = [...unique].sort((a, b) =>
    (a.path ?? '').localeCompare(b.path ?? '') || (a.line ?? 0) - (b.line ?? 0) || (a.pointer ?? '').localeCompare(b.pointer ?? ''));
  return {
    diagnostics: sorted,
    ...(declarations !== undefined && { declarations }),
    ...(project !== undefined && { project }),
    errors: sorted.filter((d) => d.severity === 'error').length,
    warnings: sorted.filter((d) => d.severity === 'warning').length,
  };
}

export function formatResult(result: CheckResult): string {
  const blocks = result.diagnostics.map(formatDiagnostic);
  blocks.push(`${result.errors} error${result.errors === 1 ? '' : 's'}, ${result.warnings} warning${result.warnings === 1 ? '' : 's'}`);
  return blocks.join('\n\n');
}

export function resultJson(result: CheckResult): string {
  return JSON.stringify({ errors: result.errors, warnings: result.warnings, diagnostics: result.diagnostics }, null, 2);
}
