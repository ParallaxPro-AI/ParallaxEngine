/**
 * The cinematic panel's markup (`builtin:cinematic.html`, api/cinematics.ts CinematicPanel):
 * letterbox bars that slide in from the top and bottom edges, the subtitle above the lower
 * bar, and the dialogue box (speaker, portrait, line, Continue while the line waits for
 * the player; Skip on a skippable cinematic). Panel vocabulary only, styles inline;
 * restyle by subclassing the panel with your own markup (state keys on the class).
 */

export const CINEMATIC_PANEL_MARKUP: Readonly<Record<string, string>> = {
  'builtin:cinematic.html': `<style>
.root { position: absolute; inset: 0; pointer-events: none; }
.bar { position: absolute; left: 0; right: 0; height: 0; background: #000; }
.bar.top { top: 0; }
.bar.bottom { bottom: 0; }
.subtitle { position: absolute; left: 50%; bottom: 16%; transform: translateX(-50%); max-width: 80%; padding: 0.3em 0.8em;
  border-radius: 0.3em; background: rgba(0, 0, 0, 0.55); font-size: 1.15em; text-align: center; }
.line { position: absolute; left: 50%; bottom: 15%; transform: translateX(-50%); width: min(46em, 90%); display: flex; gap: 0.9em;
  align-items: flex-start; padding: 0.9em 1.1em; border-radius: 0.6em; background: rgba(10, 12, 18, 0.82);
  border: 1px solid rgba(255, 255, 255, 0.2); pointer-events: auto; }
.portrait { width: 4.5em; height: 4.5em; border-radius: 0.4em; object-fit: cover; flex: none; }
.body { flex: 1; min-width: 0; }
.speaker { font-weight: 700; color: #ffd95a; margin-bottom: 0.2em; }
.text { margin: 0; font-size: 1.1em; }
.continue { float: right; margin-top: 0.5em; }
.skip { position: absolute; right: 1.2em; top: 1.2em; pointer-events: auto; opacity: 0.8; }
</style>
<div class="root">
  <div class="bar top" data-show="bars" data-style-height="bar"></div>
  <div class="bar bottom" data-show="bars" data-style-height="bar"></div>
  <div class="subtitle" data-show="has_subtitle" data-bind="subtitle"></div>
  <div class="line" data-show="dialogue">
    <img class="portrait" data-show="has_portrait" data-attr-src="portrait" alt="">
    <div class="body">
      <div class="speaker" data-show="has_speaker" data-bind="speaker"></div>
      <p class="text" data-bind="text"></p>
      <button class="continue" data-show="awaiting" data-action="advance">Continue</button>
    </div>
  </div>
  <button class="skip" data-show="skippable" data-action="skip">Skip</button>
</div>`,
};
