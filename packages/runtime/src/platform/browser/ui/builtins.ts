/**
 * The markup of the engine's own panels (`@ui(html="builtin:...")`): the settings menu and
 * the story plugin's dialogue box. Plain HTML in the panel vocabulary, styled by the
 * default panel stylesheet; games restyle them through their own CSS variables.
 *
 * The settings menu's actions are SettingsPanel's (api/ui.ts): `adjust` (volumes,
 * sensitivities), `cycle` (quality, language), `toggle` (invert look), `rebind` (one
 * control row: the next key or gamepad button), `reset_controls`, `back`.
 */

import { UI_DISPLAY_FONT_STACK, UI_FONT_STACK } from './fonts.js';
import { CINEMATIC_PANEL_MARKUP } from './cinematic_panel.js';
import { HUD_PANEL_MARKUP } from './hud_panels.js';

export const BUILTIN_PANELS: Readonly<Record<string, string>> = {
  'builtin:settings.html': `
<div class="parallax-modal">
  <div class="parallax-card parallax-settings">
    <h2>Settings</h2>
    <div class="parallax-settings-grid">
      <span>Master volume</span>
      <span class="parallax-stepper">
        <button data-action="adjust" data-setting="master_volume" data-step="-0.1" aria-label="Less">−</button>
        <b data-bind="master_volume" data-format="percent"></b>
        <button data-action="adjust" data-setting="master_volume" data-step="0.1" aria-label="More">+</button>
      </span>
      <span>Music volume</span>
      <span class="parallax-stepper">
        <button data-action="adjust" data-setting="music_volume" data-step="-0.1" aria-label="Less">−</button>
        <b data-bind="music_volume" data-format="percent"></b>
        <button data-action="adjust" data-setting="music_volume" data-step="0.1" aria-label="More">+</button>
      </span>
      <span>Effects volume</span>
      <span class="parallax-stepper">
        <button data-action="adjust" data-setting="sfx_volume" data-step="-0.1" aria-label="Less">−</button>
        <b data-bind="sfx_volume" data-format="percent"></b>
        <button data-action="adjust" data-setting="sfx_volume" data-step="0.1" aria-label="More">+</button>
      </span>
      <span>Quality</span>
      <span class="parallax-stepper">
        <button data-action="cycle" data-setting="quality" data-step="-1" aria-label="Previous">‹</button>
        <b data-bind="quality"></b>
        <button data-action="cycle" data-setting="quality" data-step="1" aria-label="Next">›</button>
      </span>
      <span data-show="languages_many">Language</span>
      <span class="parallax-stepper" data-show="languages_many">
        <button data-action="cycle" data-setting="language" data-step="-1" aria-label="Previous">‹</button>
        <b data-bind="language"></b>
        <button data-action="cycle" data-setting="language" data-step="1" aria-label="Next">›</button>
      </span>
      <span>Mouse sensitivity</span>
      <span class="parallax-stepper">
        <button data-action="adjust" data-setting="mouse_sensitivity" data-step="-0.1" aria-label="Less">−</button>
        <b data-bind="mouse_sensitivity"></b>
        <button data-action="adjust" data-setting="mouse_sensitivity" data-step="0.1" aria-label="More">+</button>
      </span>
      <span>Stick sensitivity</span>
      <span class="parallax-stepper">
        <button data-action="adjust" data-setting="stick_sensitivity" data-step="-0.1" aria-label="Less">−</button>
        <b data-bind="stick_sensitivity"></b>
        <button data-action="adjust" data-setting="stick_sensitivity" data-step="0.1" aria-label="More">+</button>
      </span>
      <span>Invert look</span>
      <span class="parallax-stepper">
        <button data-action="toggle" data-setting="invert_look"><span data-show="invert_look">On</span><span data-hide="invert_look">Off</span></button>
      </span>
      <span>Text size</span>
      <span class="parallax-stepper">
        <button data-action="adjust" data-setting="text_scale" data-step="-0.25" aria-label="Smaller">−</button>
        <b data-bind="text_scale" data-format="percent"></b>
        <button data-action="adjust" data-setting="text_scale" data-step="0.25" aria-label="Larger">+</button>
      </span>
      <span>High contrast</span>
      <span class="parallax-stepper">
        <button data-action="toggle" data-setting="high_contrast"><span data-show="high_contrast">On</span><span data-hide="high_contrast">Off</span></button>
      </span>
      <span>Reduce motion</span>
      <span class="parallax-stepper">
        <button data-action="toggle" data-setting="reduced_motion"><span data-show="reduced_motion">On</span><span data-hide="reduced_motion">Off</span></button>
      </span>
      <span>Colour vision</span>
      <span class="parallax-stepper">
        <button data-action="cycle" data-setting="colorblind" data-step="-1" aria-label="Previous">‹</button>
        <b data-bind="colorblind"></b>
        <button data-action="cycle" data-setting="colorblind" data-step="1" aria-label="Next">›</button>
      </span>
    </div>
    <div class="parallax-controls-section" data-show="controls">
      <h3>Controls</h3>
      <p class="parallax-hint" data-show="capturing">Press the new key or button (Esc cancels)</p>
      <div class="parallax-controls" data-each="controls">
        <template>
          <span data-bind="label"></span>
          <span class="parallax-device" data-bind="device"></span>
          <button data-action="rebind" data-class-capturing="capturing" data-class-changed="changed">
            <span data-hide="capturing" data-bind="binding"></span><span data-show="capturing">…</span>
          </button>
        </template>
      </div>
      <button data-action="reset_controls" data-show="remapped">Reset controls</button>
    </div>
    <button class="parallax-back" data-action="back">Back</button>
  </div>
</div>`,
  'builtin:dialogue.html': `
<div class="parallax-dialogue">
  <div class="parallax-card">
    <div class="parallax-speaker" data-show="speaker" data-bind="speaker"></div>
    <p class="parallax-line" data-bind="text"></p>
    <div class="parallax-options" data-each="options">
      <template>
        <button class="parallax-option" data-action="choose" data-attr-data-option="index" data-class-enabled="enabled"
          data-key="Digit{index1}"><span data-bind="text"></span></button>
      </template>
    </div>
    <button class="parallax-next" data-hide="options" data-action="next">Continue</button>
  </div>
</div>`,
  // The HUD kit's panels (hud and interaction plugins).
  ...HUD_PANEL_MARKUP,
  // The cinematics plugin's letterbox, subtitles and dialogue lines.
  ...CINEMATIC_PANEL_MARKUP,
};

/**
 * Default panel styles, under the game's own (low specificity: any game rule wins). The
 * engine's fonts (fonts.ts) are tokens a game restyles from its CSS: `--parallax-font`
 * (Inter) for everything, `--parallax-font-display` (Cinzel) for titles that ask for it.
 */
export const DEFAULT_PANEL_CSS = `
:host {
  --parallax-font: ${UI_FONT_STACK};
  --parallax-font-display: ${UI_DISPLAY_FONT_STACK};
  color: #f4f4f6;
  font: 15px/1.4 var(--parallax-font);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6);
  -webkit-user-select: none;
  user-select: none;
}
:where(*, *::before, *::after) { box-sizing: border-box; }
:where(h1, h2, h3, p) { margin: 0.2em 0; }
:where(button) {
  font: inherit;
  color: inherit;
  background: rgba(20, 22, 30, 0.85);
  border: 1px solid rgba(255, 255, 255, 0.5);
  border-radius: 6px;
  padding: 8px 16px;
  cursor: pointer;
}
:where(button:hover, button[data-parallax-hover]) { border-color: #fff; }
:where(button:focus-visible, [data-action]:focus-visible) { outline: 3px solid #ffd95a; outline-offset: 2px; }
:where(button:disabled, .parallax-disabled) { opacity: 0.45; cursor: default; }
:where(.parallax-bar) {
  display: block;
  min-height: 6px;
  background: rgba(255, 255, 255, 0.18);
  overflow: hidden;
}
:where(.parallax-bar-fill) { display: block; height: 100%; min-height: inherit; width: 0; background: currentColor; }
:where(.parallax-modal) { position: fixed; inset: 0; display: grid; place-items: center; background: rgba(0, 0, 0, 0.55); }
:where(.parallax-card) {
  background: rgba(14, 16, 24, 0.94);
  border: 1px solid rgba(255, 255, 255, 0.35);
  border-radius: 10px;
  padding: 18px 22px;
  min-width: min(320px, 90%);
  max-width: min(640px, 94%);
}
:where(.parallax-settings) { max-height: 92%; overflow: auto; }
:where(.parallax-settings-grid) { display: grid; grid-template-columns: 1fr auto; gap: 6px 18px; align-items: center; margin: 12px 0 16px; }
:where(.parallax-stepper) { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
:where(.parallax-stepper b) { min-width: 4.5em; text-align: center; }
:where(.parallax-stepper button) { padding: 4px 12px; }
:where(.parallax-controls) { display: grid; grid-template-columns: 1fr auto auto; gap: 4px 12px; align-items: center; margin: 8px 0 12px; }
:where(.parallax-device) { opacity: 0.6; font-size: 0.85em; }
:where(.parallax-controls button) { min-width: 6em; padding: 4px 10px; }
:where(.parallax-controls button.changed) { border-color: #ffd95a; }
:where(.parallax-controls button.capturing) { background: #ffd95a; color: #111; text-shadow: none; }
:where(.parallax-hint) { color: #ffd95a; }
:where(.parallax-back) { margin-top: 8px; }
:where(.parallax-dialogue) { position: fixed; left: 0; right: 0; bottom: 4%; display: flex; justify-content: center; }
:where(.parallax-speaker) { font-weight: 700; color: #ffd95a; margin-bottom: 4px; }
:where(.parallax-options) { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; }
:where(.parallax-option) { text-align: left; }
:where(.parallax-option:not(.enabled)) { opacity: 0.45; pointer-events: none; }
:where(.parallax-next) { margin-top: 10px; }
:where(.parallax-icon) { display: inline-block; width: 1em; height: 1em; vertical-align: -0.125em; fill: currentColor; flex: none; overflow: visible; }
:where(.parallax-display) { font-family: var(--parallax-font-display); letter-spacing: 0.04em; }
`;

/** Pointer rules: a non-modal host passes presses through (its inline style), except on its controls. */
export const PASS_THROUGH_CSS = `
:host { pointer-events: none; }
:where([data-action], button, input, select, textarea, label, a, summary, details) { pointer-events: auto; }
`;

/** HUD feedback: toasts, announcements, floating text and labels. */
export const FEEDBACK_CSS = `
:host {
  color: #fff;
  font: 600 16px/1.3 ${UI_FONT_STACK};
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.8);
  pointer-events: none;
}
.area { position: absolute; overflow: hidden; }
.toasts {
  position: absolute; left: 0; right: 0; bottom: 12%;
  display: flex; flex-direction: column-reverse; align-items: center; gap: 6px;
}
.toast {
  background: rgba(10, 12, 18, 0.85); border: 1px solid rgba(255, 255, 255, 0.3); border-radius: 8px;
  padding: 6px 14px; animation: pp-in 0.18s ease-out;
}
.announce, .announce-themed { position: absolute; left: 0; right: 0; top: 28%; text-align: center; animation: pp-pop 0.3s ease-out; }
.toast-themed { animation: pp-in 0.18s ease-out; }
.announce .title { font-size: 42px; font-weight: 800; letter-spacing: 0.02em; }
.announce .subtitle { font-size: 18px; opacity: 0.85; margin-top: 4px; }
.float { position: absolute; transform: translate(-50%, -50%); white-space: nowrap; animation: pp-rise 1s ease-out forwards; }
.float.styled { animation-name: pp-float; animation-timing-function: linear; }
.label {
  position: absolute; transform: translate(-50%, -100%); white-space: nowrap; font-size: 13px;
  background: rgba(0, 0, 0, 0.45); padding: 1px 6px; border-radius: 4px;
}
.leaving { opacity: 0; transition: opacity 0.25s; }
@keyframes pp-in { from { opacity: 0; transform: translateY(8px); } }
@keyframes pp-pop { from { opacity: 0; transform: scale(0.85); } }
@keyframes pp-rise { from { opacity: 1; } to { opacity: 0; transform: translate(-50%, -150%); } }
@keyframes pp-float {
  0% { opacity: 1; transform: translate(-50%, -50%) scale(var(--pp-pop, 1)); animation-timing-function: ease-out; }
  20% { opacity: 1; transform: translate(-50%, calc(-50% + var(--pp-rise, -40px) * 0.35)) scale(1); animation-timing-function: ease-in; }
  100% { opacity: 0; transform: translate(-50%, calc(-50% + var(--pp-rise, -40px))) scale(var(--pp-end, 1)); }
}
`;
