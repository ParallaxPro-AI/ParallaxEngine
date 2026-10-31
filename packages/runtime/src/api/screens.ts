/**
 * `parallax.screens` (sdk/parallax/screens.pyi): the Screen handle and the `screens()`
 * factory `parallax.plugins` re-exports. The plugin runs each screen's panel; this module
 * gives it the game's `@ui` panels (the same declarations HUD panels use, each screen its
 * own instance with the screen as subject), the pointer as a camera ray, and the player's
 * language. Boot connects the platform's screen surface (`connectScreens`).
 */

import { bindArgs, fail } from '../core/index.js';
import type { ScreenSurface, Vec2, Vec3 } from '../core/index.js';
import type { Kernel, KernelPlugin } from '../function/kernel/index.js';
import { performAction, plain, requestSceneCommand } from '../function/plugins/ui/index.js';
import type { PanelDecl, PanelInstance } from '../function/plugins/ui/index.js';
import { SCREEN, SCREEN_SCHEMA, screens as screensPlugin } from '../function/plugins/screens/index.js';
import type { ScreenPanelHost, ScreensHost, ScreensPlugin } from '../function/plugins/screens/index.js';
import type { Context } from './context.js';
import { componentHandle } from './handles.js';
import { truthy } from './py.js';
import { str } from './pyrt/values.js';
import { TextRef } from './types.js';
import { panelDecl, registeredPanels } from './ui.js';

/** `entity.get(Screen)`: panel (a @ui id), size, resolution, fps, on, interactive, brightness; click / press. */
export const Screen = componentHandle({ id: SCREEN, schema: SCREEN_SCHEMA }, 'Screen');

class PanelOnScreens implements ScreenPanelHost {
  readonly #kernel: Kernel;
  readonly #decl: PanelDecl;

  constructor(kernel: Kernel, decl: PanelDecl) {
    this.#kernel = kernel;
    this.#decl = decl;
    if (decl.perPlayer) {
      fail('PP3339', `Panel "${decl.id}" is a PlayerPanel; a screen shows one state to everyone`, { fix: 'Show a Panel (not a PlayerPanel) on screens.' });
    }
  }

  get id(): string { return this.#decl.id; }
  get html(): string { return this.#decl.html; }

  create(subject: unknown): object {
    const instance = this.#decl.create();
    instance.subject = subject;
    return instance;
  }

  state(instance: object): Readonly<Record<string, unknown>> {
    const panel = instance as PanelInstance;
    if (typeof panel.state !== 'function') return {};
    const value = plain(panel.state(this.#kernel.context));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      fail('PP3424', `Panel "${this.#decl.id}": state() must return a dict, got ${JSON.stringify(value)}`);
    }
    return value as Record<string, unknown>;
  }

  enabled(): Readonly<Record<string, boolean>> {
    const out: Record<string, boolean> = {};
    for (const [name, action] of this.#decl.actions) {
      if (action.kind === 'call' && action.when !== undefined) out[name] = action.when(this.#kernel.context) === true;
    }
    return out;
  }

  perform(instance: object, name: string, data: Readonly<Record<string, unknown>>, seat: number): void {
    const decl = this.#decl;
    const action = decl.actions.get(name);
    if (action === undefined) {
      fail('PP2082', `Panel "${decl.id}" has no action "${name}"`, { fix: `Actions: ${[...decl.actions.keys()].join(', ') || '(none)'}.` });
    }
    const where = `screen panel "${decl.id}" action "${name}"`;
    const command = performAction(action, {
      ctx: this.#kernel.context, instance: instance as PanelInstance, data, seat, where,
      // A `screen` parameter the press doesn't carry is the screen pressed.
      implicit: { screen: (instance as PanelInstance).subject },
      fix: (param) => `Add data-${param.replace(/_/g, '-')} to the button.`,
    });
    if (command === undefined) return;
    if (command.kind === 'close') {
      fail('PP3336', `${where} is close_panel(), but a screen's panel isn't opened or closed`, { fix: 'Turn the screen off instead (screen.on = False), or open a HUD panel.' });
    }
    if (command.kind === 'open') {
      (this.#kernel.context as unknown as { ui: { open(p: unknown): void } }).ui.open(command.panel);
      return;
    }
    requestSceneCommand(this.#kernel, command);
  }
}

function hostFor(): ScreensHost {
  const panels = new WeakMap<Kernel, Map<string, PanelOnScreens>>();
  return {
    panel(kernel, id) {
      let byId = panels.get(kernel);
      if (byId === undefined) panels.set(kernel, byId = new Map());
      let panel = byId.get(id);
      if (panel === undefined) {
        const env = { content: (target: unknown, ref: string) => (kernel.context as Context).content(target).get(ref) };
        const decl = registeredPanels().map((cls) => panelDecl(cls, env)).find((d) => d.id === id);
        if (decl === undefined) fail('PP2080', `Screen panel "${id}" is not a declared @ui panel`, { fix: 'Name a panel id from @ui("<id>", html=...).' });
        panel = new PanelOnScreens(kernel, decl);
        byId.set(id, panel);
      }
      return panel;
    },
    press(kernel) {
      const ctx = kernel.context as unknown as {
        input: { pointer: { pressed: boolean; screen: Vec2; consume(): void } };
        camera?: { main: { ray(screen: Vec2): readonly [Vec3, Vec3] } | null };
      };
      const pointer = ctx.input.pointer;
      if (!pointer.pressed) return null;
      const camera = ctx.camera?.main ?? null;
      if (camera === null) return null;
      const [origin, direction] = camera.ray(pointer.screen);
      return { origin, direction, seat: 0, consume: () => pointer.consume() };
    },
    locale(kernel) {
      const language = (kernel.resource('settings') as { language: string }).language;
      return { language, strings: kernel.project.locales.get(language)?.strings ?? {} };
    },
    values: (kernel) => ({
      text: (value) => (value === null || value === undefined ? '' : value instanceof TextRef ? (kernel.context as Context).text(value) : str(value)),
      truthy,
    }),
  };
}

/** `parallax.plugins.screens()`. */
export function screens(...args: unknown[]): KernelPlugin {
  bindArgs('screens', args, {});
  return screensPlugin({ host: hostFor() });
}

/** Boot: give the game's screens plugin (if it lists one) the platform's screen surface. */
export function connectScreens(plugins: readonly KernelPlugin[], surface: ScreenSurface): void {
  for (const p of plugins) if (p.id === 'screens') (p as ScreensPlugin).connect(surface);
}
