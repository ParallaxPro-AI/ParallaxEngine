/**
 * Ids a game shares with the engine, which the runtime refuses as the game starts (so the
 * game never runs). Reported here instead, at the game's declaration:
 *
 *   PP2010  a @component, @event or @resource id that is already the engine's, from core or
 *           from a plugin the game lists
 *   PP4420  a @ui panel id that is one of the engine's built-in panels (`settings`,
 *           `dialogue`, `interact_prompt`, `cinematic`, the HUD kit's `hud_*`)
 */

import { BUILTIN_PANEL_IDS } from '@parallax/runtime/core';
import type { CheckContext } from './context.js';
import type { EngineDecl } from './declarations.js';

/** Who brings an engine declaration: "the engine" (core) or the listed plugins, as `name()`. */
function source(ctx: CheckContext, engine: EngineDecl): string {
  if (engine.plugins.includes('core')) return 'the engine';
  const from = engine.plugins.filter((p) => ctx.plugins.has(p));
  return from.map((p) => `${p}()`).join(' / ');
}

export function checkNames(ctx: CheckContext): void {
  for (const [id, component] of Object.entries(ctx.decl.components)) {
    const engine = ctx.decl.engine.components[id];
    if (engine === undefined || !ctx.available(engine.plugins)) continue;
    const from = engine.plugins.filter((p) => p !== 'core' && ctx.plugins.has(p));
    ctx.report('PP2010', `Two component definitions are named "${id}": ${component.name} and the engine's ${engine.name}`
      + (from.length > 0 ? ` (from ${from.map((p) => `${p}()`).join(', ')})` : ''), {
      path: component.path, line: component.line,
      fix: `Rename yours, e.g. @component("${component.feature ?? 'game'}_${id}"), and use that key in prefabs.`,
    });
  }
  for (const [id, event] of Object.entries(ctx.decl.events)) {
    const engine = ctx.decl.engine.events[id];
    if (engine === undefined || !ctx.available(engine.plugins)) continue;
    ctx.report('PP2010', `Event id "${id}" is already ${source(ctx, engine)}'s ${engine.module}.${engine.name}`, {
      path: event.path, line: event.line,
      fix: `Rename this one (say "${ctx.decl.game?.id ?? 'game'}_${id}"), or listen for ${engine.name} from ${engine.module}.`,
    });
  }
  for (const [id, resource] of Object.entries(ctx.decl.resources)) {
    const engine = ctx.decl.engine.resources[id];
    if (engine === undefined || !ctx.available(engine.plugins)) continue;
    ctx.report('PP2010', `@resource("${id}") is already ${source(ctx, engine)}'s ${engine.module}.${engine.name}`, {
      path: resource.path, line: resource.line,
      fix: `Give it another id, such as @resource("${ctx.decl.game?.id ?? 'game'}_${id}"). The engine's ${engine.name} is readable as is.`,
    });
  }
  for (const [id, panel] of Object.entries(ctx.decl.panels)) {
    if (!BUILTIN_PANEL_IDS.includes(id)) continue;
    ctx.report('PP4420', `Panel "${id}" is the id of an engine panel`, {
      path: panel.path, line: panel.line,
      fix: `Give ${panel.name} another id, e.g. @ui("my_${id}", ...); to restyle the engine's panel, subclass it under a new id.`,
    });
  }
}
