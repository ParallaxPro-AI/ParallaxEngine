/**
 * World-generation data the field schemas can't judge (procgen plugin):
 *
 *   - Spline points/bank/curve combinations, Track specs (and their Spline), Sweep parts (profile names — built-in or
 *     content/profile — widths, stripes, ranges), Structure plans (every
 *     plan problem at its floor, row and column; for a `.plan` file at its line and
 *     column, PP3653 for the file's own syntax), material keys (PP3652), Dungeon ranges — each the same reader the
 *     runtime uses, so data that checks builds (PP3640–PP3660);
 *   - `kit` names a content/prop_kit entry (PP2140); a Sweep's profile exists (PP2141);
 *     prop kits and profiles themselves parse (PP3661, PP3641).
 *
 * A placement's component is checked merged over its prefab's (field by field), as it is
 * spawned.
 */

import { closestMatch, ParallaxError } from '@parallax/runtime/core';
import { instantiate } from '@parallax/runtime/kernel';
import type { Fields } from '@parallax/runtime/kernel';
import {
  BUILTIN_PROFILES, checkLayer, DUNGEON, dungeonSpec, problemSite, PROCGEN_SCHEMAS, profileOf, readKits, readProfiles, SPLINE,
  splineSpec, STRUCTURE, structureProblems, structureSpec, SWEEP, TRACK, trackSpec,
} from '@parallax/runtime/plugins/procgen';
import type { Profile } from '@parallax/runtime/plugins/procgen';
import type { JsonObject, Origin, SceneDoc } from '@parallax/runtime/resource';
import type { CheckContext } from './context.js';
import { pointerTo } from './values.js';

interface Site {
  readonly components: Readonly<Record<string, JsonObject>>;
  readonly at: Origin;
  readonly scene: SceneDoc | undefined;
}

function sites(ctx: CheckContext): Site[] {
  const out: Site[] = [];
  for (const prefab of ctx.project.prefabs.values()) {
    out.push({ components: prefab.components, at: { path: prefab.path, pointer: '/components' }, scene: undefined });
  }
  for (const scene of ctx.project.scenes.values()) {
    for (const placement of scene.entities) {
      const base = ctx.project.prefabs.get(placement.prefab)?.components ?? {};
      const merged: Record<string, JsonObject> = {};
      // Only components the placement itself sets are checked here (the prefab's own are checked once, above).
      for (const [id, fields] of Object.entries(placement.components)) merged[id] = { ...(base[id] ?? {}), ...fields };
      for (const source of [SWEEP, TRACK]) {
        for (const id of [SPLINE, source]) if (merged[source] !== undefined && merged[id] === undefined && base[id] !== undefined) merged[id] = base[id]!;
      }
      out.push({ components: merged, at: { path: placement.origin.path, pointer: pointerTo(placement.origin.pointer, 'components') }, scene });
    }
  }
  return out;
}

export function checkProcgen(ctx: CheckContext): void {
  if (!ctx.plugins.has('procgen')) return;
  const raised = (fn: () => void, at: Origin | undefined): void => {
    try {
      fn();
    } catch (error) {
      if (!(error instanceof ParallaxError)) throw error;
      const d = error.diagnostic;
      const path = d.path ?? at?.path;
      // A plan file's problem has a line, not a pointer.
      const pointer = d.line !== undefined ? undefined : d.pointer ?? at?.pointer;
      // Data checks may already have said it (a prop kit's missing prefab is a reference error there).
      if (ctx.out.some((o) => o.path === path && o.pointer === pointer && o.line === d.line)) return;
      ctx.report(d.code, d.message, {
        ...(d.fix !== undefined && { fix: d.fix }), ...(path !== undefined && { path }), ...(pointer !== undefined && { pointer }), ...(d.line !== undefined && { line: d.line }),
      });
    }
  };

  let profiles = new Map<string, Profile>();
  const kits = new Set<string>();
  raised(() => { profiles = readProfiles(ctx.project); }, undefined);
  for (const id of ctx.project.content.get('prop_kit')?.keys() ?? []) kits.add(id);
  raised(() => readKits(ctx.project), undefined);

  for (const { components, at, scene } of sites(ctx)) {
    const where = (component: string, ...path: (string | number)[]): Origin => {
      let pointer = pointerTo(at.pointer, component);
      for (const p of path) pointer = pointerTo(pointer, p);
      return { path: at.path, pointer };
    };
    /** The component's runtime fields (schema errors are data_checks' to report). */
    const fieldsOf = (id: string): Fields | undefined => {
      const json = components[id];
      if (json === undefined) return undefined;
      try { return instantiate(PROCGEN_SCHEMAS[id]!, json, id); } catch { return undefined; }
    };
    const spline = fieldsOf(SPLINE);
    if (spline !== undefined) raised(() => splineSpec(spline, `${at.path} spline`), where(SPLINE));
    const sweep = fieldsOf(SWEEP);
    if (sweep !== undefined) {
      (sweep['parts'] as Fields[]).forEach((layer, i) => {
        const name = layer['profile'] as string;
        if (BUILTIN_PROFILES[name] === undefined && !profiles.has(name)) {
          const guess = closestMatch(name, [...Object.keys(BUILTIN_PROFILES), ...profiles.keys()]);
          ctx.report('PP2141', `Sweep part ${i} names profile "${name}", which is neither built in nor in content/profile`, {
            ...where(SWEEP, 'parts', i, 'profile'),
            fix: guess !== undefined ? `Did you mean "${guess}"?` : `Built-ins: ${Object.keys(BUILTIN_PROFILES).join(', ')}; or add content/profile/${name}.json.`,
          });
        } else {
          raised(() => profileOf(name, profiles, 'sweep'), where(SWEEP, 'parts', i, 'profile'));
        }
        raised(() => checkLayer(layer, `Sweep part ${i}`), where(SWEEP, 'parts', i));
      });
    }
    const track = fieldsOf(TRACK);
    if (track !== undefined) {
      raised(() => trackSpec(track, `${at.path} track`), where(TRACK));
      if (spline === undefined && scene !== undefined) {
        ctx.report('PP3645', 'A Track follows the Spline on the same entity, and this one has none', {
          ...where(TRACK), fix: 'Add a "spline" component with the circuit\'s points next to the "track".',
        });
      }
    }
    const structure = fieldsOf(STRUCTURE);
    if (structure !== undefined && ((structure['floors'] as unknown[]).length > 0 || structure['plan'] !== null)) {
      raised(() => {
        const spec = structureSpec(structure, `${at.path} structure`, ctx.project.plans);
        for (const p of structureProblems(spec)) {
          const site = problemSite(spec, p);
          if (site.path !== undefined) {
            // Drawn in a plan file: point at its line and column (as the runtime does).
            const path = site.path;
            if (ctx.out.some((o) => o.path === path && o.line === site.line && o.message.endsWith(p.message))) continue;
            ctx.report('PP3650', `${site.text}: ${p.message}`, { path, ...(site.line !== undefined && { line: site.line }), fix: p.fix });
          } else {
            ctx.report('PP3650', `Structure floor ${p.floor} row ${p.row} column ${p.column}: ${p.message}`, { ...where(STRUCTURE, 'floors', p.floor, 'plan', p.row), fix: p.fix });
          }
        }
      }, where(STRUCTURE));
    }
    const dungeon = fieldsOf(DUNGEON);
    if (dungeon !== undefined) raised(() => dungeonSpec(dungeon, `${at.path} dungeon`), where(DUNGEON));
    for (const [id, fields] of [[STRUCTURE, structure], [DUNGEON, dungeon]] as const) {
      const kit = fields?.['kit'];
      if (typeof kit === 'string' && !kits.has(kit)) {
        const guess = closestMatch(kit, [...kits]);
        ctx.report('PP2140', `${id} kit "${kit}" is not a content/prop_kit entry`, {
          ...where(id, 'kit'), fix: guess !== undefined ? `Did you mean "${guess}"?` : `Add content/prop_kit/${kit}.json.`,
        });
      }
    }
  }
}
