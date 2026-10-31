/**
 * plugins/hud — the HUD kit (sdk/parallax/hud.pyi): minimap
 * (base map derived from the scene, icons, player arrow, zoom, route line), compass,
 * crosshair (spread, hit / kill markers, reload, scope), nameplates and world health bars,
 * objective markers and pings (pinned to the screen edge off screen), stat bars, an ability
 * bar with cooldowns and charges, a combo counter, key hints, awareness meters and damage
 * direction arcs, and screen juice (hurt flash scaled by damage, low-health vignette,
 * hit-stop and shake on damage, eased slow motion).
 *
 * Everything a HUD shows is data: viewer components on the entity a seat plays, world
 * components on whatever should appear. The panels that draw it are built-in `@ui`
 * PlayerPanels (api/hud.ts), each open exactly while it has something to show; this plugin
 * computes their models (`HudEngine`). It reads other plugins' components by id (core
 * `marker` and `camera`, combat `health` / `health_bar` / `side`) and hears combat's
 * `damaged` / `died` by id when combat is in the game — it never imports another plugin.
 */

import { bindArgs, fail } from '../../../core/index.js';
import { componentEntity } from '../../kernel/index.js';
import type { ComponentDef, Fields, Handler, Kernel, KernelPlugin, SystemDef } from '../../kernel/index.js';
import type { Json } from '../../../resource/index.js';
import {
  abilityCharges, abilityRefill, abilityRemaining, abilityUse, comboDrop, comboHit, HudEngine,
} from './engine.js';
import type { HudOptions, HudSnapshot } from './engine.js';
import { ABILITIES, COMBO, HUD_SCHEMAS } from './schemas.js';

export { BaseMapBuilder, headingOf, planeOf } from './base_map.js';
export type { BaseMap } from './base_map.js';
export { DISTANCE_UNITS, formatDistance, HUD_PANELS, HudEngine, ICON_GLYPHS, PING_KINDS } from './engine.js';
export type { DistanceUnits, HudOptions, HudPanel, HudSnapshot, PingKind } from './engine.js';
export { DEFAULT_ACCESSIBILITY } from './models.js';
export type * from './models.js';
export { css, EDGE_INSET, pct, place, seatViews, viewHeading } from './project.js';
export type { Placed, ViewLike } from './project.js';
export {
  ABILITIES, AWARENESS, COMBO, COMPASS, CROSSHAIR, CROSSHAIR_STYLES, HUD_SCHEMAS, HURT_FEEDBACK, ICONS, KEY_HINTS,
  MAP_FEATURE, MAP_FEATURE_KINDS, MAP_ICON, MINIMAP, NAMEPLATE, STAT_BARS, VIEWER_COMPONENTS,
} from './schemas.js';

export interface HudPluginOptions extends HudOptions {
  /** Builds `ctx.hud` (the api layer's Python-facing facade over the engine). */
  readonly namespace?: (engine: HudEngine) => object;
}

export interface HudPlugin extends KernelPlugin {
  readonly engine: HudEngine;
}

/** Combat's events the HUD reacts to, heard by id when the combat plugin registered them. */
const HEARD_EVENTS = [['damaged', 'damaged'], ['died', 'died']] as const;

function positiveInt(value: unknown, where: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) fail('PP3555', `${where} must be a whole number >= 1, got ${String(value)}`);
  return value as number;
}

/** Component methods (`this` = the component's fields), plus `.entity`. */
function methods(kernel: () => Kernel, own: Record<string, (this: Fields, ...args: unknown[]) => unknown> = {}): object {
  const base = {
    get entity(): unknown {
      return kernel().handles.wrap(componentEntity(this as unknown as Fields));
    },
  };
  return Object.defineProperties(base, Object.getOwnPropertyDescriptors(own));
}

export function hud(options: HudPluginOptions): HudPlugin {
  const engine = new HudEngine(options);
  const kernel = (): Kernel => engine.kernel;
  const own: Record<string, Record<string, (this: Fields, ...args: unknown[]) => unknown>> = {
    [ABILITIES]: {
      use(this: Fields, ...args: unknown[]): boolean {
        return abilityUse(this, bindArgs('use', args, { positional: ['slot'], required: ['slot'] }).args['slot']);
      },
      ready(this: Fields, ...args: unknown[]): boolean {
        return abilityCharges(this, bindArgs('ready', args, { positional: ['slot'], required: ['slot'] }).args['slot'], 'ready') > 0;
      },
      available(this: Fields, ...args: unknown[]): number {
        return abilityCharges(this, bindArgs('available', args, { positional: ['slot'], required: ['slot'] }).args['slot'], 'available');
      },
      remaining(this: Fields, ...args: unknown[]): number {
        return abilityRemaining(this, bindArgs('remaining', args, { positional: ['slot'], required: ['slot'] }).args['slot']);
      },
      refill(this: Fields, ...args: unknown[]): void {
        abilityRefill(this, bindArgs('refill', args, { positional: ['slot'] }).args['slot'] ?? null);
      },
    },
    [COMBO]: {
      hit(this: Fields, ...args: unknown[]): void {
        const n = bindArgs('hit', args, { positional: ['n'] }).args['n'] ?? 1;
        comboHit(this, positiveInt(n, 'Combo.hit(n)'));
      },
      drop(this: Fields, ...args: unknown[]): void {
        bindArgs('drop', args, {});
        comboDrop(this);
      },
    },
  };
  const components: ComponentDef[] = Object.entries(HUD_SCHEMAS).map(([id, schema]) => ({ id, schema, methods: methods(kernel, own[id]) }));

  // Filled in `install` with combat's events, when the game has them.
  const handlers: Handler[] = [];
  const system: SystemDef = {
    id: 'hud.tick',
    scenes: [],
    handlers,
    create: () => ({
      update: (_ctx: unknown, dt: number) => engine.tick(dt),
      damaged: (_ctx: unknown, payload: Fields) => engine.damaged(payload),
      died: (_ctx: unknown, payload: Fields) => engine.died(payload),
    }),
  };
  const namespace = options.namespace;
  return {
    id: 'hud',
    engine,
    components,
    systems: [system],
    install(k) {
      engine.bind(k);
      for (const [event, method] of HEARD_EVENTS) {
        const def = k.registry.events.get(event);
        if (def !== undefined) handlers.push({ event: def, method, always: true });
      }
      k.observeScenes({ loading: () => engine.sceneLoading() });
      k.observeEntities({
        added: (records) => { for (const r of records) engine.file(r); },
        removed: (records) => { for (const r of records) engine.unfile(r.id); },
        changed: (record) => engine.file(record),
      });
      k.addHook('input', () => engine.inputHook());
    },
    snapshot: () => engine.snapshot() as unknown as Json,
    restore: (_k, state) => engine.restore(state as unknown as HudSnapshot),
    ...(namespace !== undefined && { namespace: { name: 'hud', create: () => namespace(engine) } }),
  };
}

