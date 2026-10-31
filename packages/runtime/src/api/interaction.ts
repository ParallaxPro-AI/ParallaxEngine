/**
 * `parallax.interaction` (sdk/parallax/interaction.pyi): the Interactable / Interactor
 * handles, the `Interacted` event, the built-in prompt panel and the `interaction(action=)`
 * factory `parallax.plugins` re-exports.
 *
 *     game = Game(..., plugins=[plugins.interaction(action=Controls.interact), ...])
 *     # prefabs: chest {"interactable": {"prompt": "Open"}}, player {"interactor": {}}
 *     @behavior("chest")
 *     class Chest(Behavior):
 *         @on(Interacted)
 *         def opened(self, ctx, e): ...
 */

import { fail } from '../core/index.js';
import type { KernelPlugin } from '../function/kernel/index.js';
import { pct, place, seatViews } from '../function/plugins/hud/index.js';
import {
  DOOR, DOOR_EVENTS, DOOR_SCHEMA, INTERACTABLE, INTERACTABLE_SCHEMA, interaction as interactionPlugin, INTERACTION_EVENTS,
  INTERACTOR, INTERACTOR_SCHEMA,
} from '../function/plugins/interaction/index.js';
import type { InteractionEngine } from '../function/plugins/interaction/index.js';
import { ACTIONS_SERVICE, engineText } from '../function/services/index.js';
import type { Context } from './context.js';
import { ItemDef } from './economy.js';
import { eventHandle } from './events.js';
import { componentHandle } from './handles.js';
import { accessibilityOf } from './hud.js';
import { Button } from './input.js';
import { bindArgs, kw } from './kwargs.js';
import { builtinPanels, PlayerPanel, registeredPanels, ui } from './ui.js';
import { seatViewer } from './viewers.js';

/** On what can be used: prompt, range, hold, enabled, once, offset. */
export const Interactable = componentHandle({ id: INTERACTABLE, schema: INTERACTABLE_SCHEMA }, 'Interactable');
/** On who uses things: mode ("proximity" | "look"), range, angle, line_of_sight; `focus` and `progress` are kept by the engine. */
export const Interactor = componentHandle({ id: INTERACTOR, schema: INTERACTOR_SCHEMA }, 'Interactor');
/** `@on(Interacted)`: entity (the interactable), source (the interactor). */
export const Interacted = eventHandle(INTERACTION_EVENTS.interacted, 'Interacted');

/** open / close / toggle / lock / unlock; is_open, is_closed. Keys are economy items. */
export const Door = componentHandle({ id: DOOR, schema: DOOR_SCHEMA }, 'Door');
export const DoorOpened = eventHandle(DOOR_EVENTS.doorOpened, 'DoorOpened');
export const DoorClosed = eventHandle(DOOR_EVENTS.doorClosed, 'DoorClosed');
export const DoorBlocked = eventHandle(DOOR_EVENTS.doorBlocked, 'DoorBlocked');

/** Engine-facing `ctx.interaction` (the prompt panel); games read `Interactor.focus` instead. */
export class InteractionApi {
  readonly #engine: InteractionEngine;

  constructor(engine: InteractionEngine) {
    this.#engine = engine;
  }

  __has__(): boolean {
    return this.#engine.anyFocus();
  }

  __prompt__(seat: number): Record<string, unknown> {
    const engine = this.#engine;
    const kernel = engine.kernel;
    const a11y = accessibilityOf(kernel);
    const style = { contrast: a11y.highContrast, calm: a11y.reducedMotion, font: `${Math.round(a11y.textScale * 100)}%` };
    const hidden = { shown: false, text: '', keys: [], hold: false, fill: '0%', x: '50%', y: '70%', anchored: false, a11y: style };
    const interactors = engine.interactors;
    if (interactors.length === 0) return hidden;
    const who = seatViewer(kernel, seat, interactors, 'Interactor');
    const record = who === null ? undefined : kernel.world.get(who);
    const focus = record?.components.get(INTERACTOR)?.['focus'];
    const target = focus === null || focus === undefined ? undefined : kernel.world.get(kernel.handles.unwrap(focus)!);
    if (record === undefined || target === undefined) return hidden;
    const it = target.components.get(INTERACTABLE)!;
    const actions = kernel.service(ACTIONS_SERVICE);
    const keys = actions.glyphs(engine.action, actions.device(seat)).map((g) => ({ text: g.text, code: g.code, device: g.device, pad: g.device === 'gamepad', touch: g.device === 'touch' }));
    const cameras = kernel.world.query(['camera']).map(([id]) => id);
    const view = seatViews(kernel, cameras).get(seat);
    const at = view === undefined ? undefined : place(view, engine.anchor(target));
    const anchored = at !== undefined && at.onScreen;
    return {
      shown: true, text: engineText(kernel, it['prompt'] as string), keys, hold: (it['hold'] as number) > 0,
      fill: pct(record.components.get(INTERACTOR)!['progress'] as number),
      x: anchored ? pct(at.x) : '50%', y: anchored ? pct(at.y) : '70%', anchored, a11y: style,
    };
  }
}

/** `parallax.plugins.interaction(*, action)`: `action` is the button that interacts (Controls.interact). */
export function interaction(...args: unknown[]): KernelPlugin {
  const a = bindArgs('interaction', args, { keyword: ['action'], required: ['action'] }).args;
  if (!(a['action'] instanceof Button)) {
    fail('PP4580', `interaction(action=...) takes a button action (Controls.interact), got ${String(a['action'])}`);
  }
  return interactionPlugin({
    action: a['action'],
    namespace: (engine) => new InteractionApi(engine),
    // DoorBlocked's `key` as a ContentRef (the item kind is declared by economy(); read only when a door has a key).
    itemRef: (kernel, id) => (kernel.context as Context).content(ItemDef).get(id),
  });
}

/**
 * The "[E] Open" prompt (one copy per seat), open while some interactor has a focus.
 * State: {shown, text, keys: [{text, code, device, pad, touch}], hold, fill, x, y, anchored, a11y};
 * anchored: at the interactable on screen, else at the bottom center.
 */
export class InteractPromptPanel extends PlayerPanel {
  override state(ctx: unknown, player?: unknown): unknown {
    const api = (ctx as { interaction?: InteractionApi }).interaction;
    if (api === undefined) {
      fail('PP3582', 'The interact prompt shows the interaction plugin\'s focus, and this game doesn\'t have it', {
        fix: 'Add interaction(action=Controls.interact) to Game(plugins=[...]).',
      });
    }
    const seat = (player as { index?: number } | null)?.index ?? 0;
    return api.__prompt__(seat);
  }
}

ui('interact_prompt', kw({
  html: 'builtin:hud/interact_prompt.html', layer: 'hud',
  when: (ctx: unknown) => {
    const api = (ctx as { interaction?: InteractionApi }).interaction;
    return api !== undefined && !registeredPanels().some((c) => c !== InteractPromptPanel && c.prototype instanceof InteractPromptPanel) && api.__has__();
  },
}))(InteractPromptPanel);
builtinPanels(InteractPromptPanel);
