/**
 * The page structure a game runs in, built inside the element the host page gives boot:
 *
 *   stage    the game's area: pointer input, pointer lock, the overlay host
 *     surface  where renderers attach their canvas
 *     touch    the on-screen touch controls (under the panels)
 *     ui       the panels layer (pass-through except on panels themselves)
 *     input    a hidden text field focused when the game reads typed text
 */

export interface Stage {
  readonly stage: HTMLElement;
  readonly surface: HTMLElement;
  readonly touch: HTMLElement;
  readonly ui: HTMLElement;
  readonly textInput: HTMLInputElement;
  /** Remove everything this created from the mount. */
  remove(): void;
}

export function createStage(mount: HTMLElement): Stage {
  const doc = mount.ownerDocument;
  const stage = doc.createElement('div');
  stage.className = 'parallax-stage';
  Object.assign(stage.style, {
    position: 'relative', width: '100%', height: '100%', overflow: 'hidden',
    touchAction: 'none', userSelect: 'none', webkitUserSelect: 'none', outline: 'none',
  });
  stage.tabIndex = 0;

  const surface = doc.createElement('div');
  surface.className = 'parallax-surface';
  Object.assign(surface.style, { position: 'absolute', inset: '0' });

  const touch = doc.createElement('div');
  touch.className = 'parallax-touch';
  Object.assign(touch.style, { position: 'absolute', inset: '0', pointerEvents: 'none' });

  const ui = doc.createElement('div');
  ui.className = 'parallax-ui';
  Object.assign(ui.style, { position: 'absolute', inset: '0', pointerEvents: 'none' });

  const textInput = doc.createElement('input');
  textInput.type = 'text';
  textInput.autocomplete = 'off';
  textInput.setAttribute('aria-hidden', 'true');
  Object.assign(textInput.style, { position: 'absolute', left: '-9999px', top: '0', width: '1px', height: '1px', opacity: '0' });

  stage.append(surface, touch, ui, textInput);
  mount.append(stage);
  return { stage, surface, touch, ui, textInput, remove: () => stage.remove() };
}
