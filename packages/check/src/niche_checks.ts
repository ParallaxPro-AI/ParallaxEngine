/**
 * Data for the softbody and screens plugins that the field schemas alone can't judge — the
 * same errors their plugins raise, found before the game runs:
 *
 *   cloth       `pinned` indices past cols × rows (PP3312); Cloth and SoftBody on one
 *               entity (PP3310); either in a 2D game (PP3314)
 *   soft_body   with a Rigidbody (PP3313: the body moves its entity itself)
 *   screen      a panel id no @ui declares (PP2080), a PlayerPanel (PP3339), a
 *               resolution outside 16..2048 texels (PP3338)
 */

import type { Json, JsonObject, Origin } from '@parallax/runtime/resource';
import type { CheckContext } from './context.js';
import { pointerTo } from './values.js';

/** Panels the engine declares itself (always available to screens). */
const BUILTIN_PANELS = new Set(['settings', 'dialogue']);

interface Site {
  /** What this prefab or placement writes itself (single-component checks). */
  readonly own: Readonly<Record<string, JsonObject>>;
  /** With a placement's prefab merged in (checks across components). */
  readonly components: Readonly<Record<string, JsonObject>>;
  readonly at: Origin;
}

function sites(ctx: CheckContext): Site[] {
  const out: Site[] = [];
  for (const prefab of ctx.project.prefabs.values()) {
    out.push({ own: prefab.components, components: prefab.components, at: { path: prefab.path, pointer: '/components' } });
    prefab.children.forEach((child, i) => out.push({ own: child.components, components: child.components, at: { path: prefab.path, pointer: pointerTo(pointerTo('/children', i), 'components') } }));
  }
  for (const scene of ctx.project.scenes.values()) {
    for (const placement of scene.entities) {
      // A placement's components merge over its prefab's.
      const prefab = ctx.project.prefabs.get(placement.prefab);
      out.push({
        own: placement.components, components: { ...(prefab?.components ?? {}), ...placement.components },
        at: { path: placement.origin.path, pointer: pointerTo(placement.origin.pointer ?? '', 'components') },
      });
    }
  }
  return out;
}

const num = (v: Json | undefined, fallback: number): number => (typeof v === 'number' ? v : fallback);

export function checkNiche(ctx: CheckContext): void {
  const in2d = ctx.plugins.has('physics2d');
  for (const { own, components, at } of sites(ctx)) {
    // A cross-component finding belongs to the site that wrote one of its components.
    const wrote = (...ids: string[]): boolean => ids.some((id) => own[id] !== undefined);
    const where = (component: string, field?: string): Origin => {
      const c = pointerTo(at.pointer, component);
      return { path: at.path, pointer: field === undefined ? c : pointerTo(c, field) };
    };
    const cloth = components['cloth'];
    const soft = components['soft_body'];
    if (cloth !== undefined && soft !== undefined && wrote('cloth', 'soft_body')) {
      ctx.report('PP3310', 'An entity has both Cloth and SoftBody', { ...where('soft_body'), fix: 'Keep one: an entity is either a sheet or a closed body.' });
    }
    if (in2d && wrote('cloth', 'soft_body')) {
      ctx.report('PP3314', `${cloth !== undefined ? 'Cloth' : 'SoftBody'} is 3D; this game uses physics2d`, { ...where(cloth !== undefined ? 'cloth' : 'soft_body'), fix: 'Use physics3d, or remove it.' });
    }
    if (cloth !== undefined && wrote('cloth') && Array.isArray(cloth['pinned'])) {
      const count = num(cloth['cols'], 12) * num(cloth['rows'], 12);
      cloth['pinned'].forEach((i, k) => {
        if (typeof i === 'number' && (i < 0 || i >= count)) {
          ctx.report('PP3312', `cloth.pinned[${k}] is particle ${i}, but the cloth has ${count} (cols × rows)`, { ...where('cloth', 'pinned'), fix: `Pin particles 0 to ${count - 1} (row × cols + col).` });
        }
      });
    }
    if (soft !== undefined && components['rigidbody'] !== undefined && wrote('soft_body', 'rigidbody')) {
      ctx.report('PP3313', 'A SoftBody entity also has a Rigidbody', { ...where('rigidbody'), fix: 'Remove the Rigidbody: the soft body moves its entity itself (one-way collisions).' });
    }

    const screen = components['screen'];
    if (screen !== undefined && wrote('screen')) {
      const panel = screen['panel'];
      if (typeof panel === 'string') {
        const decl = ctx.decl.panels[panel];
        if (decl === undefined && !BUILTIN_PANELS.has(panel)) {
          ctx.report('PP2080', `screen.panel "${panel}" is not a declared @ui panel`, { ...where('screen', 'panel'), fix: `Panels: ${Object.keys(ctx.decl.panels).join(', ') || '(none)'}.` });
        } else if (decl?.per_player === true) {
          ctx.report('PP3339', `screen.panel "${panel}" is a PlayerPanel; a screen shows one state to everyone`, { ...where('screen', 'panel'), fix: 'Show a Panel (not a PlayerPanel) on screens.' });
        }
      }
      const resolution = screen['resolution'];
      if (Array.isArray(resolution) && resolution.some((v) => typeof v !== 'number' || Math.round(v) < 16 || Math.round(v) > 2048)) {
        ctx.report('PP3338', `screen.resolution is ${JSON.stringify(resolution)}`, { ...where('screen', 'resolution'), fix: 'Give whole numbers of texels from 16 to 2048 on each side, e.g. [512, 288].' });
      }
    }
  }
}
