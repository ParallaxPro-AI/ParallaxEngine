/**
 * HUD and interaction data that names other things by string, which a field schema can't
 * check (the hud plugin, sdk/parallax/hud.pyi):
 *
 *   - `stat_bars.bars[].value` / `.max` are `"<component>.<field>"` paths: the component
 *     must exist and the field must be a number (error); the component should be on the
 *     same prefab or placement, else it must arrive by `spawn(components=)` (warning).
 *   - `key_hints.actions[]` and `abilities.slots[].action` are `"<ActionSet>.<action>"`
 *     names of declared actions (error); `abilities.slots[].image` is an image file's
 *     project path (error).
 *   - `marker` (core) and `health_bar` (combat) are data other plugins declare and only the
 *     hud plugin draws: on an entity in a game without hud() they show nothing (warning).
 */

import { closestMatch, isAssetUrl, remoteAssetProblem } from '@parallax/runtime/core';
import type { JsonObject } from '@parallax/runtime/resource';
import type { CheckContext } from './context.js';

const NUMERIC = new Set(['number', 'int']);

function pointerTo(base: string, ...parts: (string | number)[]): string {
  return [base, ...parts.map((p) => String(p).replace(/~/g, '~0').replace(/\//g, '~1'))].join('/');
}

/** `"<ActionSet>.<action>"` for every declared action (sets are keyed by qualified name; the class name is what data writes). */
function actionNames(ctx: CheckContext): string[] {
  return Object.entries(ctx.decl.action_sets).flatMap(([qualified, decl]) => {
    const name = (decl as unknown as { name?: string }).name ?? qualified.slice(qualified.lastIndexOf('.') + 1);
    return Object.keys(decl.actions).map((a) => `${name}.${a}`);
  });
}

function checkEntity(ctx: CheckContext, components: Readonly<Record<string, JsonObject>>, has: ReadonlySet<string>,
  at: { readonly path: string; readonly pointer: string }, actions: readonly string[]): void {
  const statBars = components['stat_bars'];
  const bars = statBars?.['bars'];
  if (Array.isArray(bars)) {
    bars.forEach((bar, i) => {
      if (typeof bar !== 'object' || bar === null || Array.isArray(bar)) return;
      for (const key of ['value', 'max'] as const) {
        const path = (bar as JsonObject)[key];
        if (typeof path !== 'string') continue;
        const pointer = pointerTo(at.pointer, 'components', 'stat_bars', 'bars', i, key);
        const dot = path.indexOf('.');
        const component = dot < 0 ? path : path.slice(0, dot);
        const field = dot < 0 ? '' : path.slice(dot + 1);
        const info = ctx.components.get(component);
        if (dot < 0 || info === undefined) {
          const guess = closestMatch(component, [...ctx.components.keys()]);
          ctx.report('PP2550', `Stat bar ${key} "${path}" names no component "${component}"`, {
            path: at.path, pointer, fix: guess !== undefined ? `Did you mean "${guess}.${field || '<field>'}"?` : 'Write "<component>.<field>", e.g. "health.current".',
          });
          continue;
        }
        const spec = info.fields[field];
        if (spec === undefined || !NUMERIC.has(spec.type.kind)) {
          const numbers = Object.entries(info.fields).filter(([, f]) => NUMERIC.has(f.type.kind)).map(([n]) => n);
          ctx.report('PP2550', `Stat bar ${key} "${path}": "${component}" has no number field "${field}"`, {
            path: at.path, pointer, fix: `Number fields of ${component}: ${numbers.join(', ') || '(none)'}.`,
          });
          continue;
        }
        if (!has.has(component)) {
          ctx.report('PP2552', `Stat bar ${key} "${path}" reads "${component}", which this entity doesn't have`, {
            severity: 'warning', path: at.path, pointer, fix: `Add "${component}" to its components (or pass it in spawn(components=[...])).`,
          });
        }
      }
    });
  }
  const named = (value: unknown, pointer: string, what: string): void => {
    if (typeof value !== 'string' || actions.includes(value)) return;
    const guess = closestMatch(value, actions);
    ctx.report('PP2551', `${what} "${value}" is not a declared action`, {
      path: at.path, pointer, fix: guess !== undefined ? `Did you mean "${guess}"?` : 'Write "<ActionSet>.<action>", e.g. "Controls.jump".',
    });
  };
  const hints = components['key_hints']?.['actions'];
  if (Array.isArray(hints)) hints.forEach((a, i) => named(a, pointerTo(at.pointer, 'components', 'key_hints', 'actions', i), 'Key hint'));
  const slots = components['abilities']?.['slots'];
  if (Array.isArray(slots)) {
    slots.forEach((slot, i) => {
      if (typeof slot === 'object' && slot !== null && !Array.isArray(slot)) {
        named((slot as JsonObject)['action'], pointerTo(at.pointer, 'components', 'abilities', 'slots', i, 'action'), 'Ability slot action');
        const image = (slot as JsonObject)['image'];
        const hosted = typeof image === 'string' && isAssetUrl(image) ? remoteAssetProblem(image, 'images') ?? null : undefined;
        if (typeof hosted === 'string') {
          ctx.report('PP2554', `Ability slot image: ${hosted}`, {
            path: at.path, pointer: pointerTo(at.pointer, 'components', 'abilities', 'slots', i, 'image'),
            fix: 'Use a hosted image URL (https://r2.parallaxpro.ai/assets/….png) or a project path ("assets/ui/dash.png").',
          });
        } else if (hosted === undefined && typeof image === 'string' && ctx.options.assetFiles && ![...ctx.assets.values()].includes(image)) {
          const guess = closestMatch(image, [...ctx.assets.values()]);
          ctx.report('PP2554', `Ability slot image "${image}" is not a file in assets/`, {
            path: at.path, pointer: pointerTo(at.pointer, 'components', 'abilities', 'slots', i, 'image'),
            fix: guess !== undefined ? `Did you mean "${guess}"?` : 'Write the image\'s project path, e.g. "assets/ui/dash.png".',
          });
        }
      }
    });
  }
}

/** Components declared outside the hud plugin that only hud() draws. */
export const DRAWN_BY_HUD = ['marker', 'health_bar'] as const;

function undrawn(ctx: CheckContext): void {
  const report = (components: Readonly<Record<string, JsonObject>>, at: { readonly path: string; readonly pointer: string }): void => {
    for (const id of DRAWN_BY_HUD) {
      if (!(id in components)) continue;
      ctx.report('PP2553', `"${id}" is drawn by the hud plugin, which this game doesn't have: it shows nothing`, {
        severity: 'warning', path: at.path, pointer: pointerTo(at.pointer, 'components', id),
        fix: 'Add hud() to Game(plugins=[...]) (and a MarkersPanel / NameplatesPanel to a scene), or remove the component.',
      });
    }
  };
  for (const prefab of ctx.project.prefabs.values()) report(prefab.components, { path: prefab.path, pointer: '' });
  for (const scene of ctx.project.scenes.values()) for (const placement of scene.entities) report(placement.components, placement.origin);
}

export function checkHud(ctx: CheckContext): void {
  if (!ctx.plugins.has('hud')) {
    undrawn(ctx);
    return;
  }
  const actions = actionNames(ctx);
  for (const prefab of ctx.project.prefabs.values()) {
    checkEntity(ctx, prefab.components, new Set(Object.keys(prefab.components)), { path: prefab.path, pointer: '' }, actions);
  }
  for (const scene of ctx.project.scenes.values()) {
    for (const placement of scene.entities) {
      if (!('stat_bars' in placement.components) && !('key_hints' in placement.components) && !('abilities' in placement.components)) continue;
      const base = ctx.project.prefabs.get(placement.prefab)?.components ?? {};
      const has = new Set([...Object.keys(base), ...Object.keys(placement.components)]);
      checkEntity(ctx, placement.components, has, placement.origin, actions);
    }
  }
}
