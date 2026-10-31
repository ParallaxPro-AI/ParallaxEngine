/**
 * Characters and viewmodels, with the engine's own rules (so check and runtime agree, code
 * for code; sdk/parallax/characters.pyi, viewmodel.pyi):
 *
 *   - every Character in a prefab, prefab child or scene placement: the field rules a schema
 *     can't state (`characterProblems`: the stance heights chain, swim depths, skydive and
 *     parachute speeds, traversal heights, the eye inside the body);
 *   - a Character that drives its entity's Animator (`animate`, default true): each param the
 *     character sets that the Animator declares must be declared with the kind it is set as
 *     (PP3176, as the runtime raises on the first step);
 *   - a ViewmodelItem's `grips` are two socket names, right then left (PP3873).
 */

import { CHARACTER_PARAMS, characterProblems } from '@parallax/runtime/plugins/characters';
import { resolvePrefab } from '@parallax/runtime/resource';
import type { JsonObject } from '@parallax/runtime/resource';
import type { CheckContext } from './context.js';

type Components = Readonly<Record<string, JsonObject>>;

function pointerTo(base: string, ...parts: (string | number)[]): string {
  return [base, ...parts.map((p) => String(p).replace(/~/g, '~0').replace(/\//g, '~1'))].join('/');
}

function kindOf(value: unknown): string {
  if (value === 'trigger') return 'trigger';
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'number') return 'number';
  return 'value';
}

function entity(ctx: CheckContext, components: Components, path: string, at: string): void {
  const character = components['character'];
  if (character !== undefined) {
    for (const p of characterProblems(character)) {
      ctx.report(p.code, p.message, { path, pointer: `${pointerTo(at, 'components', 'character')}${p.pointer}`, fix: p.fix });
    }
    const params = components['animator']?.['params'];
    if (character['animate'] !== false && typeof params === 'object' && params !== null && !Array.isArray(params)) {
      for (const [name, kind] of Object.entries(CHARACTER_PARAMS)) {
        if (!(name in params)) continue;
        const has = kindOf((params as JsonObject)[name]);
        if (has === kind) continue;
        ctx.report('PP3176', `The animator declares "${name}" as a ${has} param; the character sets it as a ${kind}`, {
          path, pointer: pointerTo(at, 'components', 'animator', 'params', name),
          fix: `Declare it "${name}": ${kind === 'trigger' ? '"trigger"' : kind === 'bool' ? 'false' : '0'}, or set the character's "animate": false.`,
        });
      }
    }
  }
  const grips = components['viewmodel_item']?.['grips'];
  if (Array.isArray(grips) && grips.length !== 2) {
    ctx.report('PP3873', `viewmodel_item.grips lists ${grips.length} socket${grips.length === 1 ? '' : 's'}; it takes two, right hand then left`, {
      path, pointer: pointerTo(at, 'components', 'viewmodel_item', 'grips'), fix: 'Write ["grip_r", "grip_l"] ("" leaves that hand free).',
    });
  }
}

function resolved(ctx: CheckContext, id: string): Components {
  try {
    return resolvePrefab(ctx.project, id).components;
  } catch {
    return {}; // an unknown base or a cycle: data_checks reports it
  }
}

function merge(base: Components, over: Components): Record<string, JsonObject> {
  const out: Record<string, JsonObject> = { ...base };
  for (const [id, fields] of Object.entries(over)) out[id] = { ...(base[id] ?? {}), ...fields };
  return out;
}

const WATCHED = ['character', 'animator', 'viewmodel_item'];

export function checkCharacters(ctx: CheckContext): void {
  for (const prefab of ctx.project.prefabs.values()) {
    if (WATCHED.some((c) => prefab.components[c] !== undefined)) entity(ctx, resolved(ctx, prefab.id), prefab.path, '');
    prefab.children.forEach((child, i) => {
      if (!WATCHED.some((c) => child.components[c] !== undefined)) return;
      entity(ctx, merge(child.prefab === undefined ? {} : resolved(ctx, child.prefab), child.components), prefab.path, `/children/${i}`);
    });
  }
  for (const scene of ctx.project.scenes.values()) {
    scene.entities.forEach((placed, i) => {
      if (!WATCHED.some((c) => placed.components[c] !== undefined)) return;
      entity(ctx, merge(resolved(ctx, placed.prefab), placed.components), placed.origin.path, placed.origin.pointer ?? `/entities/${i}`);
    });
  }
}
