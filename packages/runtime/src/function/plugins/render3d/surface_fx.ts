/**
 * The `surface_fx` and `heat_haze` components (visuals' render_schemas.ts) as render data:
 * an entity's surface effects become `Material3d.effects` on each of its materials (a swap,
 * like a monitor's), and its heat haze a `Haze3d`. Animated amounts — a flash fading out, a
 * `dissolve_to` transition, a shockwave pulse — are worked out from game time here, so the
 * components hold only when each started.
 *
 * An effect material is a fresh object each frame whose id names its values: entities with
 * the same effects batch together, and the renderer packs this frame's numbers.
 */

import { hasEffects, NO_EFFECTS } from '../../../core/index.js';
import type { Haze3d, Material3d, MaterialEffects3d, Rgb } from '../../../core/index.js';
import type { EntityRecord, Fields } from '../../kernel/index.js';
import { finite, nameOf, rgba } from './draw.js';

export const SURFACE_FX = 'surface_fx';
export const HEAT_HAZE = 'heat_haze';

type Swap = (material: Material3d, name: string | null) => Material3d;

/** Where a transition toward `dissolve` stands at `now` (the same rule as visuals' `dissolveNow`). */
function dissolveAt(fx: Fields, now: number, where: string): number {
  const target = finite(fx['dissolve'], `${where}.dissolve`);
  const seconds = finite(fx['dissolve_seconds'], `${where}.dissolve_seconds`);
  if (!(seconds > 0)) return target;
  const k = Math.min(1, Math.max(0, (now - finite(fx['dissolve_at'], `${where}.dissolve_at`)) / seconds));
  const from = finite(fx['dissolve_from'], `${where}.dissolve_from`);
  return from + (target - from) * k;
}

/** A flash's strength at `now`: its peak fading linearly to 0 over its seconds (0 before it starts and after). */
export function flashAt(fx: Fields, now: number): number {
  const at = fx['flash_at'];
  if (typeof at !== 'number') return 0;
  const t = (now - at) / (fx['flash_seconds'] as number);
  return t < 0 || t >= 1 ? 0 : (fx['flash_strength'] as number) * (1 - t);
}

const rgb = (value: unknown, where: string): Rgb => {
  const c = rgba(value, where);
  return [c[0], c[1], c[2]];
};

/** An entity's surface effects at `now` (null: none drawn). */
export function effectsOf(record: EntityRecord, fx: Fields, now: number): MaterialEffects3d | null {
  const where = `${nameOf(record)} surface_fx`;
  const scroll = fx['scroll'] as { x: number; y: number };
  const effects: MaterialEffects3d = {
    ...NO_EFFECTS,
    rim: finite(fx['rim'], `${where}.rim`),
    rimColor: rgb(fx['rim_color'], `${where}.rim_color`),
    rimPower: finite(fx['rim_power'], `${where}.rim_power`),
    flash: flashAt(fx, now),
    flashColor: rgb(fx['flash_color'], `${where}.flash_color`),
    dissolve: Math.min(1, Math.max(0, dissolveAt(fx, now, where))),
    dissolveScale: finite(fx['dissolve_scale'], `${where}.dissolve_scale`),
    dissolveEdge: finite(fx['dissolve_edge'], `${where}.dissolve_edge`),
    dissolveColor: rgb(fx['dissolve_color'], `${where}.dissolve_color`),
    dissolveGlow: finite(fx['dissolve_glow'], `${where}.dissolve_glow`),
    hologram: finite(fx['hologram'], `${where}.hologram`),
    hologramColor: rgb(fx['hologram_color'], `${where}.hologram_color`),
    hologramLines: finite(fx['hologram_lines'], `${where}.hologram_lines`),
    hologramFlicker: finite(fx['hologram_flicker'], `${where}.hologram_flicker`),
    scroll: [finite(scroll.x, `${where}.scroll.x`), finite(scroll.y, `${where}.scroll.y`)],
    triplanar: finite(fx['triplanar'], `${where}.triplanar`),
  };
  return hasEffects(effects) ? effects : null;
}

/** Whether these effects keep the entity from casting a shadow (a hologram; a dissolve under way). */
export function effectsHideShadow(e: MaterialEffects3d | null): boolean {
  return e !== null && (e.hologram > 0 || e.dissolve > 0);
}

/** The key naming an effects value (two materials with the same key look the same). */
function effectsKey(e: MaterialEffects3d): string {
  const n = (x: number): string => (Math.round(x * 1000) / 1000).toString();
  return [
    e.rim, ...e.rimColor, e.rimPower, e.flash, ...e.flashColor, e.dissolve, e.dissolveScale, e.dissolveEdge, ...e.dissolveColor, e.dissolveGlow,
    e.hologram, ...e.hologramColor, e.hologramLines, e.hologramFlicker, ...e.scroll, e.triplanar,
  ].map(n).join(',');
}

/** A material with these effects: see-through for a hologram, its id naming the effects. */
export function withEffects(material: Material3d, e: MaterialEffects3d, key = effectsKey(e)): Material3d {
  return {
    ...material,
    id: `${material.id}|fx:${key}`,
    effects: e,
    ...(e.hologram > 0 && { alphaMode: 'blend' as const }),
  };
}

/**
 * The swap that puts an entity's effects on its materials (only the `material` its
 * component names, when it names one), applied over `inner` (a monitor or mirror's swap).
 */
export function effectsSwap(fx: Fields, effects: MaterialEffects3d, inner: Swap | null): Swap {
  const only = fx['material'] as string | null;
  const key = effectsKey(effects);
  return (material, name) => {
    const under = inner === null ? material : inner(material, name);
    return only !== null && name !== only ? under : withEffects(under, effects, key);
  };
}

/** An entity's heat haze at `now`: its steady shimmer and its pulse's ring while it grows. */
export function hazesOf(record: EntityRecord, haze: Fields, position: readonly [number, number, number], now: number): Haze3d[] {
  const where = `${nameOf(record)} heat_haze`;
  const out: Haze3d[] = [];
  const radius = finite(haze['radius'], `${where}.radius`);
  const strength = finite(haze['strength'], `${where}.strength`);
  const height = finite(haze['height'], `${where}.height`);
  if (radius > 0 && strength > 0) out.push({ position: [position[0], position[1] + height, position[2]], radius, strength, ring: 0 });
  const at = haze['pulse_at'];
  if (typeof at === 'number') {
    const t = (now - at) / finite(haze['pulse_seconds'], `${where}.pulse_seconds`);
    if (t >= 0 && t < 1) {
      out.push({
        position: [position[0], position[1], position[2]],
        radius: Math.max(0.01, finite(haze['pulse_radius'], `${where}.pulse_radius`) * t),
        strength: finite(haze['pulse_strength'], `${where}.pulse_strength`) * (1 - t) * (1 - t),
        ring: 0.35,
      });
    }
  }
  return out;
}
