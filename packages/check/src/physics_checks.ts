/**
 * Physics data the schemas alone can't judge (joints, ragdolls, breakables): what only
 * works in one dimension, limits given backwards, fracture without a piece to fill.
 * Each is the same error the runtime raises, found before the game runs.
 */

import type { JsonObject, Origin } from '@parallax/runtime/resource';
import type { CheckContext } from './context.js';
import { pointerTo } from './values.js';

interface Site {
  readonly components: Readonly<Record<string, JsonObject>>;
  readonly at: Origin;
}

function sites(ctx: CheckContext): Site[] {
  const out: Site[] = [];
  for (const prefab of ctx.project.prefabs.values()) {
    out.push({ components: prefab.components, at: { path: prefab.path, pointer: '/components' } });
    prefab.children.forEach((child, i) => out.push({ components: child.components, at: { path: prefab.path, pointer: pointerTo(pointerTo('/children', i), 'components') } }));
  }
  for (const scene of ctx.project.scenes.values()) {
    // A placement's origin points at the entity (/entities/N); its components sit under /components.
    for (const placement of scene.entities) {
      out.push({ components: placement.components, at: { path: placement.origin.path, pointer: pointerTo(placement.origin.pointer ?? '', 'components') } });
    }
  }
  return out;
}

export function checkPhysics(ctx: CheckContext): void {
  const in2d = ctx.plugins.has('physics2d');
  for (const { components, at } of sites(ctx)) {
    const where = (component: string, field?: string): Origin => {
      const c = pointerTo(at.pointer, component);
      return { path: at.path, pointer: field === undefined ? c : pointerTo(c, field) };
    };
    const joint = components['joint'];
    if (joint !== undefined) {
      if (in2d && joint['kind'] === 'ball') {
        ctx.report('PP3187', 'A "ball" joint is 3D; this game uses physics2d', { ...where('joint', 'kind'), fix: 'In 2D a "hinge" turns freely about its anchor.' });
      }
      const limits = joint['limits'];
      if (Array.isArray(limits) && typeof limits[0] === 'number' && typeof limits[1] === 'number') {
        if (limits[0] > limits[1]) ctx.report('PP3185', `joint.limits is (${limits[0]}, ${limits[1]}); min is above max`, { ...where('joint', 'limits'), fix: 'Give (min, max).' });
        const kind = joint['kind'] ?? 'hinge';
        if (kind !== 'hinge' && kind !== 'slider') {
          ctx.report('PP3185', `A ${String(kind)} joint has no free coordinate to limit`, { ...where('joint', 'limits'), fix: 'Limits are for hinges (degrees) and sliders (meters).' });
        }
      }
      const kind = joint['kind'] ?? 'hinge';
      if ((joint['motor_speed'] !== undefined && joint['motor_speed'] !== null || joint['motor_target'] !== undefined && joint['motor_target'] !== null)
        && kind !== 'hinge' && kind !== 'slider') {
        ctx.report('PP3186', `A ${String(kind)} joint has a motor, but nothing to drive`, { ...where('joint'), fix: 'Motors drive hinges and sliders.' });
      }
      if (joint['to_parent'] === true && joint['connected'] !== undefined && joint['connected'] !== null) {
        ctx.report('PP3181', 'joint sets both connected and to_parent', { ...where('joint'), fix: 'Use one: to_parent connects to the entity\'s parent.' });
      }
    }
    if (in2d && components['ragdoll'] !== undefined) {
      ctx.report('PP3194', 'Ragdolls are physics3d only; this game uses physics2d', { ...where('ragdoll'), fix: 'Remove the ragdoll component, or make the game 3D.' });
    }
    const breakable = components['breakable'];
    if (breakable !== undefined && typeof breakable['fracture'] === 'number' && breakable['fracture'] > 0 && (breakable['pieces'] === undefined || breakable['pieces'] === null)) {
      ctx.report('PP3212', `breakable fractures into ${breakable['fracture']} pieces but names no pieces prefab`, {
        ...where('breakable', 'pieces'), fix: 'Name a 1 m unit-cube piece prefab in "pieces".',
      });
    }
  }
}
