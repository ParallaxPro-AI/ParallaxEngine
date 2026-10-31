/**
 * A headless stand-in for the panel renderer: click panel actions with a payload (what a
 * `data-action` button, a `data-each` item or a `data-key` shortcut sends) and read the
 * state a panel would render. The test harness builds `game.click` / `panel_state` on it.
 */

import { fail } from '../../../core/index.js';
import type { PanelKey } from './declarations.js';
import type { UiEngine } from './engine.js';

export class UiDriver {
  readonly #engine: UiEngine;

  constructor(engine: UiEngine) {
    this.#engine = engine;
  }

  /** Click `action` on an open panel; it runs in the next frame's `ui` hook. */
  click(panel: PanelKey, action: string, data: Readonly<Record<string, unknown>> = {}, seat = 0): void {
    const decl = this.#engine.panel(panel);
    if (!this.#engine.isOpen(decl)) {
      fail('PP3428', `Panel "${decl.id}" is not open, so "${action}" can't be clicked`, {
        fix: 'Advance until it opens (or assert why it is closed) before clicking.',
      });
    }
    const view = this.#engine.view(decl);
    if (view?.enabled[action] === false) {
      fail('PP3429', `Action "${action}" of panel "${decl.id}" is disabled (its @action(when=) is false)`);
    }
    this.#engine.click(decl, action, data, seat);
  }

  isOpen(panel: PanelKey): boolean {
    return this.#engine.isOpen(panel);
  }

  /** The state the panel last rendered (for a PlayerPanel, that seat's). */
  stateOf(panel: PanelKey, seat = 0): Readonly<Record<string, unknown>> {
    const decl = this.#engine.panel(panel);
    const view = this.#engine.view(decl);
    if (view === undefined) {
      fail('PP3428', `Panel "${decl.id}" is not open (or hasn't rendered a frame yet)`, { fix: 'Advance a frame after it opens.' });
    }
    const state = view.states[decl.perPlayer ? seat : 0];
    if (state === undefined) fail('PP3403', `Panel "${decl.id}" has no seat ${seat}`);
    return state;
  }

  /** Open panel ids, oldest first. */
  openPanels(): string[] {
    return this.#engine.openPanels.map((p) => p.decl.id);
  }
}
