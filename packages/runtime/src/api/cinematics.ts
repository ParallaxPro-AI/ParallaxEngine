/**
 * `parallax.cinematics` (sdk/parallax/cinematics.pyi): the built-in `cinematic` content
 * kind, the CinematicTrigger handle, the CinematicStarted / CinematicMarker /
 * CinematicEnded events, `ctx.cinematics`, the built-in CinematicPanel (letterbox bars,
 * subtitles, dialogue lines) and the `cinematics(skip=, advance=)` factory
 * `parallax.plugins` re-exports. The player lives in the cinematics plugin.
 *
 *     game = Game(..., plugins=[plugins.cinematics(skip=Controls.skip, advance=Controls.confirm)])
 *     ctx.cinematics.play(Content.cinematic.boss_intro, bind={"boss": boss})
 *
 *     @on(CinematicEnded)
 *     def after(self, ctx, e: CinematicEnded):
 *         if e.cinematic == Content.cinematic.boss_intro: ...
 */

import { fail } from '../core/index.js';
import type { Color, EntityId, Vec3 } from '../core/index.js';
import type { Kernel, KernelPlugin } from '../function/kernel/index.js';
import {
  CINEMATIC, CINEMATIC_EVENTS, CINEMATIC_TRIGGER, CINEMATIC_TRIGGER_SCHEMA, cinematics as cinematicsPlugin,
} from '../function/plugins/cinematics/index.js';
import type { CinematicsEngine, Presentation, VfxOptions } from '../function/plugins/cinematics/index.js';
import type { Context } from './context.js';
import { content, declareBuiltIns } from './declarations.js';
import { eventHandle } from './events.js';
import { componentHandle } from './handles.js';
import { Button } from './input.js';
import { bindArgs, kw } from './kwargs.js';
import { dictEntries } from './py.js';
import { EffectRef, field, rt, SceneRef } from './types.js';
import { builtinPanels, Panel, registeredPanels, ui } from './ui.js';

/** A trigger volume: an entity tagged `activator` coming within `radius` plays `cinematic`. */
export const CinematicTrigger = componentHandle({ id: CINEMATIC_TRIGGER, schema: CINEMATIC_TRIGGER_SCHEMA }, 'CinematicTrigger');

/** cinematic (ContentRef). */
export const CinematicStarted = eventHandle(CINEMATIC_EVENTS.started, 'CinematicStarted');
/** cinematic, skipped (ended by a skip or a scene load, at its end state). */
export const CinematicEnded = eventHandle(CINEMATIC_EVENTS.ended, 'CinematicEnded');
/** cinematic, name, time (the key's seconds), skipped (fired by a skip, not by playback reaching it). */
export const CinematicMarker = eventHandle(CINEMATIC_EVENTS.marker, 'CinematicMarker');

class CinematicFields {
  static readonly __annotations__ = {
    duration: () => rt.optional(rt.float),
    skippable: () => rt.bool,
    scenes: () => rt.list(SceneRef),
    bind: () => rt.list(rt.str),
    tracks: () => rt.list(rt.any),
  };
  static readonly duration = field(null, kw({ min: 0, unit: 's', doc: 'None: the last key\'s time.' }));
  static readonly skippable = field(true);
  static readonly scenes = field([]);
  static readonly bind = field([]);
  static readonly tracks = field([]);
}

/** Built-in content kind: content/cinematic/<id>.json (the format: function/plugins/cinematics/timeline.ts). */
export const CinematicDef = declareBuiltIns(() => content(CINEMATIC)(CinematicFields), 'cinematics');

function cinematicId(value: unknown, where: string): string {
  const ref = value as { id?: unknown; kind?: unknown } | null;
  if (typeof value === 'object' && ref !== null && typeof ref.id === 'string' && ref.kind === CINEMATIC) return ref.id;
  return fail('PP7211', `${where} takes a cinematic (Content.cinematic.<id>), got ${String(value)}`, {
    fix: 'Add content/cinematic/<id>.json and pass Content.cinematic.<id>.',
  });
}

/** `ctx.cinematics`. */
export class CinematicsApi {
  readonly #engine: CinematicsEngine;

  constructor(engine: CinematicsEngine) {
    this.#engine = engine;
  }

  /** play(cinematic, *, bind=None): bind maps the cinematic's "bind" names to entities. */
  play(...args: unknown[]): null {
    const a = bindArgs('play', args, { positional: ['cinematic'], keyword: ['bind'], required: ['cinematic'] }).args;
    const id = cinematicId(a['cinematic'], 'play()');
    const handles = this.#engine.kernel.handles;
    const bindings = new Map<string, EntityId>();
    if (a['bind'] !== undefined && a['bind'] !== null) {
      for (const [name, value] of dictEntries(a['bind'], 'play(bind=)')) {
        const entity = handles.unwrap(value);
        if (entity === undefined) fail('PP7213', `play(bind=...): "${name}" must be an entity, got ${String(value)}`);
        bindings.set(name, entity);
      }
    }
    this.#engine.play(id, bindings);
    return null;
  }

  /** End the running cinematic at its end state (skippable or not). False when none plays. */
  skip(...args: unknown[]): boolean {
    bindArgs('skip', args, {});
    return this.#engine.skip();
  }

  get playing(): boolean {
    return this.#engine.playing;
  }

  /** The running cinematic (ContentRef), or None. */
  get current(): unknown {
    const id = this.#engine.current;
    return id === null ? null : refOf(this.#engine.kernel, id);
  }

  /** Seconds into the running cinematic (0 when none plays). */
  get time(): number {
    return this.#engine.time;
  }

  /** Move past the dialogue line playback is held on. False when nothing waits. */
  advance(...args: unknown[]): boolean {
    bindArgs('advance', args, {});
    return this.#engine.advance();
  }

  /** Playback is held on a dialogue line until advance(). */
  get awaiting(): boolean {
    return this.#engine.awaiting;
  }

  /** What the CinematicPanel draws now (engine-facing), or null when nothing is on screen. */
  __presentation__(): Presentation | null {
    const p = this.#engine.presentation();
    return p === null || (p.letterbox <= 0 && p.subtitle === null && p.dialogue === null) ? null : p;
  }
}

function apiOf(ctx: unknown): CinematicsApi | undefined {
  const api = (ctx as { cinematics?: unknown }).cinematics;
  return api instanceof CinematicsApi ? api : undefined;
}

/** Each bar's height at a full letterbox: a 16:9 screen framed to about 2.39:1. */
const BAR = 12.5;

/**
 * The cinematic panel (restylable: subclass it with your own markup): letterbox bars, the
 * subtitle and the dialogue line of the running cinematic. Open exactly while one of them
 * shows. State: {bar, bars, subtitle, has_subtitle, dialogue, speaker, has_speaker, text,
 * portrait, has_portrait, awaiting, skippable}; actions `advance` and `skip`.
 */
export class CinematicPanel extends Panel {
  static override actions: unknown = {
    advance: (ctx: unknown): null => { apiOf(ctx)?.advance(); return null; },
    skip: (ctx: unknown): null => { apiOf(ctx)?.skip(); return null; },
  };

  override state(ctx: unknown): unknown {
    const p = apiOf(ctx)?.__presentation__() ?? null;
    const line = p?.dialogue ?? null;
    return {
      bars: (p?.letterbox ?? 0) > 0,
      bar: `${((p?.letterbox ?? 0) * BAR).toFixed(3)}%`,
      has_subtitle: p?.subtitle != null,
      subtitle: p?.subtitle ?? '',
      dialogue: line !== null,
      has_speaker: line?.speaker != null,
      speaker: line?.speaker ?? '',
      text: line?.text ?? '',
      has_portrait: line?.portrait != null,
      portrait: line?.portrait ?? '',
      awaiting: line?.awaiting === true,
      skippable: p?.skippable === true,
    };
  }
}

ui('cinematic', kw({
  html: 'builtin:cinematic.html', layer: 'overlay',
  when: (ctx: unknown) => !registeredPanels().some((c) => c !== CinematicPanel && c.prototype instanceof CinematicPanel)
    && apiOf(ctx)?.__presentation__() != null,
}))(CinematicPanel);
builtinPanels(CinematicPanel);

function refOf(kernel: Kernel, id: string): unknown {
  return (kernel.context as Context).content(CinematicDef).get(id);
}

/** A one-shot effect through the game's renderer (`ctx.vfx.play`). */
function playVfx(kernel: Kernel, effect: string, at: Vec3, options: VfxOptions): void {
  const vfx = (kernel.context as { vfx?: { play(...a: unknown[]): void } }).vfx;
  if (vfx === undefined) {
    fail('PP7220', 'A cinematic vfx track plays effects, but this game draws none', { fix: 'Effects come from the renderers (createRuntime includes them).' });
  }
  const color: Color | null = options.color;
  vfx.play(new EffectRef(effect), kw({
    at, scale: options.scale, ...(color !== null && { color }), ...(options.direction !== null && { direction: options.direction }),
  }));
}

/**
 * `parallax.plugins.cinematics(*, skip=None, advance=None)`: `skip` is the button that skips
 * a skippable cinematic, `advance` the one that moves past a waiting dialogue line.
 */
export function cinematics(...args: unknown[]): KernelPlugin {
  const a = bindArgs('cinematics', args, { keyword: ['skip', 'advance'] }).args;
  const button = (key: 'skip' | 'advance'): unknown => {
    const value = a[key] ?? undefined;
    if (value !== undefined && value !== null && !(value instanceof Button)) {
      fail('PP7292', `cinematics(${key}=...) takes a button action (Controls.${key}), got ${String(value)}`);
    }
    return value ?? undefined;
  };
  const skip = button('skip');
  const advance = button('advance');
  return cinematicsPlugin({
    ...(skip !== undefined && { skip }),
    ...(advance !== undefined && { advance }),
    host: { ref: refOf, vfx: playVfx },
    namespace: (engine) => new CinematicsApi(engine),
  });
}
