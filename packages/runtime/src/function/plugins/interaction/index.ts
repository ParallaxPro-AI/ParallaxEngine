/**
 * plugins/interaction — "[E] Open" (sdk/parallax/interaction.pyi): `Interactable` marks
 * what can be used, `Interactor` marks who uses things (a player entity). Each frame, before
 * the game's systems, every interactor's `focus` is derived — the best interactable in reach
 * by proximity (nearest within its facing cone) or by look (closest to the view's center,
 * with line of sight through physics3d when the game has it) — and the game's interact
 * action (`interaction(action=Controls.interact)`) is read for the interactor's seat:
 * a press, or holding for `hold` seconds (`progress` 0..1), emits `Interacted` to the
 * interactable's behaviors and to systems. Nothing toggles: focus and prompts follow the
 * world. The prompt panel (api/interaction.ts) shows the focus with the bound key.
 *
 * Doors (door.ts) live here too: things you use to open, close and unlock, moved by the
 * same system after focus, and toggled by `Interacted` on an Interactable door.
 */

import { fail, Vec3 } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import { componentEntity, t } from '../../kernel/index.js';
import type { ComponentDef, EntityRecord, EventDef, Fields, Kernel, KernelPlugin, Schema, SystemDef } from '../../kernel/index.js';
import { ACTIONS_SERVICE, PHYSICS3D_SERVICE } from '../../services/index.js';
import type { Json } from '../../../resource/index.js';
import { DOOR_EVENTS, Doors } from './door.js';
import type { ItemRefOf } from './door.js';

export { DOOR, DOOR_EVENTS, DOOR_MODES, DOOR_SCHEMA } from './door.js';
export type { ItemRefOf } from './door.js';

export const INTERACTABLE = 'interactable';
export const INTERACTOR = 'interactor';
const CAMERA = 'camera';

export const INTERACTABLE_SCHEMA: Schema = {
  /** The verb shown after the key ("Open", "Talk", "Revive"); source-language text. */
  prompt: t.string({ default: 'Interact' }),
  /** Meters (horizontal) from the interactor within which it can be used. */
  range: t.number({ default: 2.5, min: 0 }),
  /** Seconds the action must be held; 0: a press. */
  hold: t.number({ default: 0, min: 0 }),
  enabled: t.bool({ default: true }),
  /** Disable itself after the first use. */
  once: t.bool({ default: false }),
  /** Where the prompt sits and what a look-mode interactor aims at, from the entity's origin. */
  offset: t.vec3({ default: new Vec3(0, 1, 0) }),
};

export const INTERACTOR_SCHEMA: Schema = {
  mode: t.enum(['proximity', 'look'], { default: 'proximity' }),
  /** Longest reach in meters (an interactable's own `range` can be shorter). */
  range: t.number({ default: 3, min: 0 }),
  /** Degrees: proximity — half-angle of the facing cone (180: any side); look — from the view's center. None: 75 / 12 (2D: 180). */
  angle: { type: { kind: 'optional', of: { kind: 'number' } }, default: null },
  /** 3D: something solid in between blocks the focus (needs physics3d). */
  line_of_sight: t.bool({ default: true }),
  /** The interactable in focus now (kept by the engine). */
  focus: { type: { kind: 'optional', of: { kind: 'entity' } }, default: null },
  /** 0..1 of a hold under way (kept by the engine). */
  progress: t.number({ default: 0, min: 0, max: 1 }),
};

export const INTERACTION_EVENTS = {
  interacted: { id: 'interacted', target: 'entity' },
} as const satisfies Record<string, EventDef>;

export interface InteractionOptions {
  /** The game's interact action handle (`Controls.interact`, a button). */
  readonly action: unknown;
}

export interface InteractionSnapshot {
  /** Interactors that finished a hold and wait for the key to be released. */
  readonly latched: readonly number[];
}

interface ViewLike {
  readonly seat: number;
  readonly active: boolean;
  readonly dimension: '2d' | '3d';
  readonly position: Vec3;
  readonly rotation: { rotate(v: Vec3): Vec3 };
}

/** Degrees between two directions. */
function angleBetween(a: Vec3, b: Vec3): number {
  const la = a.length();
  const lb = b.length();
  if (la === 0 || lb === 0) return 0;
  return (Math.acos(Math.max(-1, Math.min(1, a.dot(b) / (la * lb)))) * 180) / Math.PI;
}

export class InteractionEngine {
  readonly #options: InteractionOptions;
  #kernel: Kernel | undefined;
  readonly #interactables = new Set<EntityId>();
  readonly #interactors = new Set<EntityId>();
  readonly #cameras = new Set<EntityId>();
  readonly #latched = new Set<EntityId>();
  #dimension: '2d' | '3d' | undefined;

  constructor(options: InteractionOptions) {
    if (options.action === undefined || options.action === null) {
      fail('PP4580', 'interaction() needs action= — the button that interacts', { fix: 'plugins.interaction(action=Controls.interact).' });
    }
    this.#options = options;
  }

  get kernel(): Kernel {
    if (this.#kernel === undefined) fail('PP9580', 'The interaction plugin is used before its kernel was built');
    return this.#kernel;
  }

  get action(): unknown {
    return this.#options.action;
  }

  bind(kernel: Kernel): void {
    if (this.#kernel !== undefined) fail('PP9581', 'This interaction plugin is already installed in another kernel');
    this.#kernel = kernel;
  }

  file(record: EntityRecord): void {
    const put = (set: Set<EntityId>, has: boolean): void => { if (has) set.add(record.id); else set.delete(record.id); };
    put(this.#interactables, record.components.has(INTERACTABLE));
    put(this.#interactors, record.components.has(INTERACTOR));
    put(this.#cameras, record.components.has(CAMERA));
  }

  unfile(id: EntityId): void {
    this.#interactables.delete(id);
    this.#interactors.delete(id);
    this.#cameras.delete(id);
    this.#latched.delete(id);
  }

  get interactors(): readonly EntityId[] {
    return [...this.#interactors];
  }

  /** Whether some interactor has a focus (the prompt panel's `when=`). */
  anyFocus(): boolean {
    for (const id of this.#interactors) {
      if (this.kernel.world.get(id)?.components.get(INTERACTOR)?.['focus'] != null) return true;
    }
    return false;
  }

  #seatOf(record: EntityRecord): number {
    return record.owner ?? 0;
  }

  #view(seat: number): ViewLike | undefined {
    for (const id of this.#cameras) {
      const view = (this.kernel.world.get(id)?.components.get(CAMERA) as { __view__?: ViewLike } | undefined)?.__view__;
      if (view !== undefined && view.active && view.seat === seat) return view;
    }
    return undefined;
  }

  /** The point a prompt sits at / a look aims at. */
  anchor(target: EntityRecord): Vec3 {
    return target.transform.worldPosition().__add__(target.components.get(INTERACTABLE)!['offset'] as Vec3);
  }

  /**
   * 2D or 3D, from the cameras' resolved views (the factory runs before `Game(mode=...)` is
   * known).
   */
  get dimension(): '2d' | '3d' {
    if (this.#dimension !== undefined) return this.#dimension;
    for (const id of this.#cameras) {
      const view = (this.kernel.world.get(id)?.components.get(CAMERA) as { __view__?: ViewLike } | undefined)?.__view__;
      if (view !== undefined) return (this.#dimension = view.dimension);
    }
    return fail('PP3581', 'Interaction needs a camera to know the game\'s plane, and this scene has none', {
      fix: 'Place an entity with a camera component in the scene.',
    });
  }

  #flat(v: Vec3): Vec3 {
    return this.dimension === '3d' ? new Vec3(v.x, 0, v.z) : new Vec3(v.x, v.y, 0);
  }

  #blocked(from: Vec3, to: Vec3, ignore: readonly EntityId[], target: EntityId): boolean {
    const physics = this.kernel.tryService(PHYSICS3D_SERVICE);
    if (physics === undefined) return false;
    const d = to.__sub__(from);
    const distance = d.length();
    if (distance < 1e-6) return false;
    const hit = physics.raycast(from, d.__truediv__(distance), distance, { ignore });
    return hit !== undefined && hit.entity !== target && hit.distance < distance - 0.05;
  }

  /** The interactable `who` would use now, or null. */
  focusOf(who: EntityRecord): EntityId | null {
    const me = who.components.get(INTERACTOR)!;
    const dimension = this.dimension;
    const mode = me['mode'] as 'proximity' | 'look';
    const reach = me['range'] as number;
    const position = who.transform.worldPosition();
    let best: EntityId | null = null;
    let bestScore = Infinity;
    const view = mode === 'look' ? this.#view(this.#seatOf(who)) : undefined;
    if (mode === 'look' && dimension === '2d') {
      fail('PP3580', 'Interactor(mode="look") aims with a 3D camera; this is a 2D game', { fix: 'Use mode="proximity" in 2D.' });
    }
    const angle = (me['angle'] as number | null) ?? (mode === 'look' ? 12 : dimension === '2d' ? 180 : 75);
    const facing = this.#flat(who.transform.worldRotation().rotate(dimension === '3d' ? Vec3.FORWARD : Vec3.RIGHT));
    for (const id of this.#interactables) {
      if (id === who.id) continue;
      const target = this.kernel.world.get(id);
      const it = target?.components.get(INTERACTABLE);
      if (target === undefined || it === undefined || it['enabled'] !== true) continue;
      const anchor = this.anchor(target);
      const distance = this.#flat(target.transform.worldPosition().__sub__(position)).length();
      if (distance > Math.min(reach, it['range'] as number)) continue;
      let score: number;
      if (mode === 'look') {
        if (view === undefined) continue;
        const off = angleBetween(view.rotation.rotate(Vec3.FORWARD), anchor.__sub__(view.position));
        if (off > angle) continue;
        if (me['line_of_sight'] === true && this.#blocked(view.position, anchor, [who.id], id)) continue;
        score = off;
      } else {
        const toward = this.#flat(target.transform.worldPosition().__sub__(position));
        const off = toward.length() < 1e-6 ? 0 : angleBetween(facing, toward);
        if (angle < 180 && off > angle) continue;
        if (dimension === '3d' && me['line_of_sight'] === true
          && this.#blocked(position.__add__(new Vec3(0, 1, 0)), anchor, [who.id], id)) continue;
        // Nearest wins; facing it is worth up to half its distance.
        score = distance * (1 + (0.5 * off) / 180);
      }
      if (score < bestScore) {
        bestScore = score;
        best = id;
      }
    }
    return best;
  }

  /** Before the game's systems: focus, hold progress, presses → Interacted. */
  update(dt: number): void {
    const kernel = this.kernel;
    const actions = kernel.service(ACTIONS_SERVICE);
    for (const id of this.#interactors) {
      const who = kernel.world.get(id);
      if (who === undefined) continue;
      const me = who.components.get(INTERACTOR)!;
      const focus = this.focusOf(who);
      const previous = me['focus'] === null ? null : kernel.handles.unwrap(me['focus']) ?? null;
      if (focus !== previous) {
        me['focus'] = focus === null ? null : kernel.handles.wrap(focus);
        me['progress'] = 0;
      }
      const seat = this.#seatOf(who);
      const held = actions.held(this.#options.action, seat, id);
      if (!held) this.#latched.delete(id);
      if (focus === null) continue;
      const target = kernel.world.get(focus)!;
      const it = target.components.get(INTERACTABLE)!;
      const hold = it['hold'] as number;
      let fire = false;
      if (hold <= 0) {
        fire = actions.pressed(this.#options.action, seat, id);
      } else if (held && !this.#latched.has(id)) {
        const progress = Math.min(1, (me['progress'] as number) + dt / hold);
        me['progress'] = progress;
        if (progress >= 1) {
          fire = true;
          this.#latched.add(id);
        }
      } else if ((me['progress'] as number) > 0) {
        me['progress'] = 0;
      }
      if (!fire) continue;
      me['progress'] = 0;
      if (it['once'] === true) it['enabled'] = false;
      kernel.emit(INTERACTION_EVENTS.interacted, { entity: kernel.handles.wrap(focus), source: kernel.handles.wrap(id) });
    }
  }

  snapshot(): InteractionSnapshot {
    return { latched: [...this.#latched] };
  }

  restore(saved: InteractionSnapshot): void {
    this.#latched.clear();
    for (const id of saved.latched) if (this.kernel.world.isAlive(id as EntityId)) this.#latched.add(id as EntityId);
  }
}

export interface InteractionPluginOptions extends InteractionOptions {
  readonly namespace?: (engine: InteractionEngine) => object;
  /** An `item` content ref by id, for DoorBlocked's `key` (the api supplies it); else the id. */
  readonly itemRef?: ItemRefOf;
}

export interface InteractionPlugin extends KernelPlugin {
  readonly engine: InteractionEngine;
}

export function interaction(options: InteractionPluginOptions): InteractionPlugin {
  const engine = new InteractionEngine(options);
  const entityOf = {
    get entity(): unknown {
      return engine.kernel.handles.wrap(componentEntity(this as unknown as Fields));
    },
  };
  const doors = new Doors(() => engine.kernel, options.itemRef);
  const components: ComponentDef[] = [
    { id: INTERACTABLE, schema: INTERACTABLE_SCHEMA, methods: entityOf },
    { id: INTERACTOR, schema: INTERACTOR_SCHEMA, methods: entityOf },
    doors.component(),
  ];
  const system: SystemDef = {
    id: 'interaction.focus',
    scenes: [],
    // Using an Interactable door toggles it (Door.toggle_on_interact), keys and all.
    handlers: [{ event: INTERACTION_EVENTS.interacted, method: 'interacted' }],
    create: () => ({
      update: (_ctx: unknown, dt: number) => {
        engine.update(dt);
        doors.tick(dt);
      },
      interacted: (_ctx: unknown, payload: Fields) => {
        const handles = engine.kernel.handles;
        const id = handles.unwrap(payload['entity']);
        if (id !== undefined) doors.interacted(id, handles.unwrap(payload['source']) ?? null);
      },
    }),
  };
  return {
    id: 'interaction',
    engine,
    components,
    events: [...Object.values(INTERACTION_EVENTS), ...Object.values(DOOR_EVENTS)],
    systems: [system],
    install(kernel) {
      engine.bind(kernel);
      kernel.observeEntities({
        added: (records) => {
          for (const r of records) {
            engine.file(r);
            doors.added(r);
          }
        },
        removed: (records) => { for (const r of records) engine.unfile(r.id); },
        changed: (record) => engine.file(record),
      });
    },
    snapshot: () => engine.snapshot() as unknown as Json,
    restore: (_kernel, state) => engine.restore(state as unknown as InteractionSnapshot),
    ...(options.namespace !== undefined && { namespace: { name: 'interaction', create: () => options.namespace!(engine) } }),
  };
}
