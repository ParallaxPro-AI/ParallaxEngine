/**
 * The HUD kit's built-in panel markup (`builtin:hud/<name>.html`): the default look of the
 * hud and interaction plugins' panels (api/hud.ts, api/interaction.ts). Plain panel
 * vocabulary — every position, size and colour comes bound from the panel's state — with
 * the styles inline, so the surface scopes them to the panel like any game panel's.
 *
 * Restyling: a game subclasses the panel with its own markup (the state keys are listed on
 * each panel class); `[data-code="south"]` on key glyphs and the `contrast` / `calm`
 * classes (high contrast, reduced motion) are there for its CSS too. Sizes are in `em`, so
 * the player's text-scale setting (bound to each root's font-size) scales a whole widget.
 */

const BASE = `
.root { position: absolute; inset: 0; pointer-events: none; font-size: 100%; }
.root.calm *, .root.calm *::before, .root.calm *::after { animation: none !important; transition: none !important; }
.panel { background: rgba(10, 12, 18, 0.62); border: 1px solid rgba(255, 255, 255, 0.22); border-radius: 0.5em; }
.contrast .panel { background: #000; border: 2px solid #fff; }
kbd {
  display: inline-block; min-width: 1.6em; padding: 0.05em 0.4em; border-radius: 0.3em; text-align: center;
  font: 700 0.8em/1.4 system-ui, sans-serif; color: #111; background: #f2f2f2; box-shadow: 0 0.12em 0 #999; text-shadow: none;
}
kbd.pad { border-radius: 50%; min-width: 1.5em; color: #fff; background: #555; box-shadow: none; }
kbd.pad[data-code="south"] { background: #3c9c3c; }
kbd.pad[data-code="east"] { background: #c43a3a; }
kbd.pad[data-code="west"] { background: #3a6cc4; }
kbd.pad[data-code="north"] { background: #c4a43a; }
kbd.touch { border-radius: 1em; background: rgba(255, 255, 255, 0.85); }
.contrast kbd { outline: 2px solid #fff; }
`;

function panel(css: string, body: string): string {
  return `<style>${BASE}${css}</style>${body}`;
}

const ROOT = 'class="root" data-class-contrast="a11y.contrast" data-class-calm="a11y.calm" data-style-font-size="a11y.font"';

export const HUD_PANEL_MARKUP: Readonly<Record<string, string>> = {
  'builtin:hud/screen.html': panel(`
.flash, .vignette { position: absolute; inset: 0; }
.flash { mix-blend-mode: screen; }
.vignette { background: radial-gradient(ellipse at center, transparent 52%, var(--pp-vignette, #d01818) 100%); }
`, `<div ${ROOT} data-show="shown">
  <div class="flash" data-style-opacity="flash" data-style-background-color="flash_color"></div>
  <div class="vignette" data-style-opacity="vignette" data-style---pp-vignette="vignette_color"></div>
</div>`),

  'builtin:hud/nameplates.html': panel(`
.plate { position: absolute; transform: translate(-50%, -100%); display: flex; flex-direction: column; align-items: center; gap: 0.15em; }
.name { font-size: 0.8em; font-weight: 600; white-space: nowrap; padding: 0 0.4em; border-radius: 0.3em; background: rgba(0, 0, 0, 0.4); }
.contrast .name { background: #000; }
.hp { width: 4.5em; height: 0.4em; background: rgba(0, 0, 0, 0.55); border: 1px solid rgba(255, 255, 255, 0.35); border-radius: 0.2em; overflow: hidden; }
.hp i { display: block; height: 100%; }
.low .hp { animation: pp-pulse 0.8s ease-in-out infinite alternate; }
@keyframes pp-pulse { to { border-color: #fff; } }
`, `<div ${ROOT} data-show="shown">
  <div data-each="plates"><template>
    <div class="plate" data-style-left="x" data-style-top="y" data-class-low="low">
      <div class="name" data-show="named" data-bind="text"></div>
      <div class="hp" data-show="health" data-style-width="bar_width" data-style-height="bar_height"
        data-style-background-color="bar_background" data-style-border-color="bar_border"><i data-style-width="fill" data-style-background-color="color"></i></div>
    </div>
  </template></div>
</div>`),

  'builtin:hud/awareness.html': panel(`
.meter { position: absolute; transform: translate(-50%, -100%); }
.mark { position: relative; display: block; width: 1.4em; height: 1.6em; }
.mark b { position: absolute; inset: 0; text-align: center; font: 900 1.4em/1.1 system-ui, sans-serif; }
.mark .q { color: rgba(255, 255, 255, 0.35); }
.mark .fill { position: absolute; left: 0; right: 0; bottom: 0; overflow: hidden; }
.mark .fill b { color: #ffd23f; top: auto; bottom: 0; height: 1.6em; }
.mark .x { display: none; color: #ff4040; }
.alerted .q, .alerted .fill { display: none; }
.alerted .x { display: block; animation: pp-pop 0.25s ease-out; }
.arrow { display: none; color: #ffd23f; font-size: 1.1em; }
.meter:not(.on) .mark { display: none; }
.meter:not(.on) .arrow { display: block; }
.meter.alerted .arrow { color: #ff4040; }
.arc { position: absolute; left: 50%; top: 50%; width: 9em; height: 9em; margin: -4.5em; border-radius: 50%;
  border: 0.35em solid transparent; border-top-color: rgba(255, 50, 40, 0.9); }
.sound { position: absolute; left: 50%; top: 50%; width: 11em; height: 11em; margin: -5.5em; border-radius: 50%;
  border: 0.25em dotted transparent; border-top-color: rgba(255, 255, 255, 0.85); }
@keyframes pp-pop { from { transform: scale(1.8); } }
`, `<div ${ROOT} data-show="shown">
  <div data-each="meters"><template>
    <div class="meter" data-style-left="x" data-style-top="y" data-class-alerted="alerted" data-class-on="on_screen">
      <span class="mark"><b class="q">?</b><span class="fill" data-style-height="fill"><b>?</b></span><b class="x">!</b></span>
      <span class="arrow" data-style-transform="turn">▲</span>
    </div>
  </template></div>
  <div data-each="hits"><template><div class="arc" data-style-transform="turn" data-style-opacity="opacity"></div></template></div>
  <div data-each="sounds"><template><div class="sound" data-attr-data-kind="kind" data-style-transform="turn" data-style-opacity="opacity"></div></template></div>
</div>`),

  'builtin:hud/markers.html': panel(`
.mk { position: absolute; transform: translate(-50%, -50%); display: flex; flex-direction: column; align-items: center; }
.glyph { font-size: 1.3em; text-shadow: 0 0 0.3em rgba(0, 0, 0, 0.9); }
.ping .glyph { animation: pp-ping 1s ease-out infinite; }
.arrow { display: none; font-size: 1em; }
.mk:not(.on) .arrow { display: block; }
.info { font-size: 0.72em; white-space: nowrap; color: #fff; text-shadow: 0 1px 2px #000; }
.contrast .info { background: #000; padding: 0 0.3em; }
@keyframes pp-ping { 0% { transform: scale(1.6); } 40% { transform: scale(1); } }
`, `<div ${ROOT} data-show="shown">
  <div data-each="markers"><template>
    <div class="mk" data-style-left="x" data-style-top="y" data-class-on="on_screen" data-class-ping="ping" data-style-color="color">
      <span class="glyph" data-bind="glyph"></span>
      <span class="arrow" data-style-transform="turn">▲</span>
      <span class="info"><span data-bind="label"></span> <span data-bind="distance"></span></span>
    </div>
  </template></div>
</div>`),

  'builtin:hud/crosshair.html': panel(`
.cross { position: absolute; left: 50%; top: 50%; width: 0; height: 0; --gap: 4px; }
.dot { position: absolute; width: 4px; height: 4px; margin: -2px; border-radius: 50%; background: currentColor; box-shadow: 0 0 2px #000; }
.lines i { position: absolute; background: currentColor; box-shadow: 0 0 2px #000; }
.lines .t, .lines .b { width: 2px; height: 0.6em; left: -1px; }
.lines .t { bottom: var(--gap); }
.lines .b { top: var(--gap); }
.lines .l, .lines .r { height: 2px; width: 0.6em; top: -1px; }
.lines .l { right: var(--gap); }
.lines .r { left: var(--gap); }
.ring { position: absolute; width: calc(var(--gap) * 2 + 0.8em); height: calc(var(--gap) * 2 + 0.8em); transform: translate(-50%, -50%);
  border: 2px solid currentColor; border-radius: 50%; }
.hit { position: absolute; }
.hit i { position: absolute; width: 0.7em; height: 2px; background: #fff; box-shadow: 0 0 2px #000; }
.hit i:nth-child(1) { transform: translate(0.35em, -0.6em) rotate(45deg); }
.hit i:nth-child(2) { transform: translate(-1.05em, -0.6em) rotate(-45deg); }
.hit i:nth-child(3) { transform: translate(0.35em, 0.6em) rotate(-45deg); }
.hit i:nth-child(4) { transform: translate(-1.05em, 0.6em) rotate(45deg); }
.hit.kill i { background: #ff3b30; }
.reload { position: absolute; top: 1.6em; left: -2em; width: 4em; height: 0.3em; background: rgba(0, 0, 0, 0.5); border-radius: 0.15em; overflow: hidden; }
.reload i { display: block; height: 100%; background: #fff; }
.scope { position: absolute; left: -100vmax; top: -100vmax; width: 200vmax; height: 200vmax;
  background: radial-gradient(circle at center, transparent 0, transparent 32vmin, #000 32.3vmin); }
.scope::before, .scope::after { content: ""; position: absolute; left: 50%; top: 50%; background: rgba(0, 0, 0, 0.85); }
.scope::before { width: 64vmin; height: 1px; transform: translate(-50%, -50%); }
.scope::after { width: 1px; height: 64vmin; transform: translate(-50%, -50%); }
`, `<div ${ROOT} data-show="shown">
  <div class="cross" data-style-color="color" data-style---gap="gap">
    <div class="scope" data-show="scope"></div>
    <div class="dot" data-show="dot"></div>
    <div class="lines" data-show="cross"><i class="t"></i><i class="b"></i><i class="l"></i><i class="r"></i></div>
    <div class="ring" data-show="circle"></div>
    <div class="hit" data-style-opacity="hit" data-class-kill="kill"><i></i><i></i><i></i><i></i></div>
    <div class="reload" data-show="reloading"><i data-style-width="reload"></i></div>
  </div>
</div>`),

  'builtin:hud/minimap.html': panel(`
.map { position: absolute; top: 1em; right: 1em; width: 11em; height: 11em; overflow: hidden;
  background: #22262e; border: 1px solid rgba(0, 0, 0, 0.85); border-radius: 0.3em;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.13), 0 4px 14px rgba(0, 0, 0, 0.55); }
.map.round { border-radius: 50%; }
.contrast .map { background: #000; border: 3px solid #fff; }
.turn { position: absolute; inset: 0; }
.base { position: absolute; max-width: none; image-rendering: auto; opacity: 0.95; }
.route { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.route polyline { fill: none; stroke: #ffd95a; stroke-width: 1.4; stroke-linejoin: round; stroke-dasharray: 3 2; vector-effect: non-scaling-stroke; }
.icon { position: absolute; transform: translate(-50%, -50%); font-size: 0.8em; line-height: 1; text-shadow: 0 0 2px #000, 0 0 2px #000; }
.icon i { display: inline-block; font-style: normal; }
.icon.edge { opacity: 0.85; }
.me { position: absolute; left: 50%; top: 50%; width: 0; height: 0; }
.me b { position: absolute; left: -0.5em; top: -0.62em; width: 1em; text-align: center; font-size: 1em; line-height: 1.2; color: #38e06a; text-shadow: 0 0 1px #000, 0 0 3px rgba(0, 0, 0, 0.8); }
`, `<div ${ROOT} data-show="shown">
  <div class="map panel" data-class-round="round">
    <div class="turn" data-style-transform="turn">
      <img class="base" alt="" data-show="base" data-attr-src="base" data-style-left="base_left" data-style-top="base_top" data-style-width="base_width" data-style-height="base_height">
      <svg class="route" viewBox="0 0 100 100" preserveAspectRatio="none" data-show="has_route"><polyline data-attr-points="route"></polyline></svg>
    </div>
    <div data-each="icons"><template>
      <span class="icon" data-class-edge="edge" data-style-left="x" data-style-top="y" data-style-color="color" data-style-font-size="size"><i data-style-transform="turn" data-bind="glyph"></i></span>
    </template></div>
    <span class="me"><b data-style-transform="player_turn">▲</b></span>
  </div>
</div>`),

  'builtin:hud/compass.html': panel(`
.compass { position: absolute; top: 0.8em; left: 50%; transform: translateX(-50%); width: 26em; height: 2.4em; overflow: hidden; }
.tick { position: absolute; bottom: 0.2em; width: 0; height: 0.5em; border-left: 1px solid rgba(255, 255, 255, 0.5); }
.tick.major { height: 0.8em; border-left-width: 2px; border-color: #fff; }
.tick b { position: absolute; bottom: 0.9em; left: 0; transform: translateX(-50%); font-size: 0.75em; }
.tick.major b { color: #ffd95a; font-size: 0.9em; }
.mark { position: absolute; top: 0.1em; transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; line-height: 1; }
.mark i { font-style: normal; font-size: 0.9em; text-shadow: 0 0 2px #000; }
.mark small { font-size: 0.6em; color: #fff; }
.needle { position: absolute; left: 50%; bottom: 0; width: 0; height: 0; border: 0.35em solid transparent; border-bottom-color: #ffd95a; transform: translateX(-50%); }
.deg { position: absolute; top: 3.4em; left: 50%; transform: translateX(-50%); opacity: 0.8; }
.deg small { font-size: 0.7em; }
`, `<div ${ROOT} data-show="shown">
  <div class="compass panel">
    <div data-each="ticks"><template><span class="tick" data-style-left="x" data-class-major="major"><b data-bind="label"></b></span></template></div>
    <div data-each="marks"><template><span class="mark" data-style-left="x" data-style-color="color"><i data-bind="glyph"></i><small data-bind="distance"></small></span></template></div>
    <span class="needle"></span>
  </div>
  <div class="deg"><small><span data-bind="heading"></span>°</small></div>
</div>`),

  'builtin:hud/stat_bars.html': panel(`
.stats { position: absolute; left: 1em; bottom: 1em; display: grid; gap: 0.35em; min-width: 14em; padding: 0.5em 0.7em; }
.stat { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 0.5em; }
.label { font-size: 0.75em; font-weight: 700; min-width: 2.5em; }
.bar { height: 0.7em; background: rgba(255, 255, 255, 0.15); border-radius: 0.35em; overflow: hidden; }
.bar i { display: block; height: 100%; border-radius: inherit; transition: width 0.15s ease-out; }
.num { font-size: 0.72em; font-variant-numeric: tabular-nums; opacity: 0.9; }
.low .bar { animation: pp-low 0.7s ease-in-out infinite alternate; }
@keyframes pp-low { to { background: rgba(255, 60, 60, 0.45); } }
`, `<div ${ROOT} data-show="shown">
  <div class="stats panel">
    <div data-each="bars"><template>
      <div class="stat" data-class-low="low">
        <span class="label" data-bind="label"></span>
        <span class="bar"><i data-style-width="fill" data-style-background-color="color"></i></span>
        <span class="num" data-show="numbers" data-bind="text"></span>
      </div>
    </template></div>
  </div>
</div>`),

  'builtin:hud/ability_bar.html': panel(`
.bar { position: absolute; left: 50%; bottom: 1em; transform: translateX(-50%); display: flex; gap: 0.5em; }
.slot { position: relative; width: 3.4em; height: 3.4em; display: grid; place-items: center; overflow: hidden; }
.icon { font-size: 1.5em; opacity: 0.55; }
.image { width: 80%; height: 80%; object-fit: contain; opacity: 0.55; }
.ready .icon, .ready .image { opacity: 1; }
.cool { position: absolute; left: 0; right: 0; bottom: 0; background: rgba(0, 0, 0, 0.6); }
.secs { position: absolute; inset: 0; display: grid; place-items: center; font-weight: 800; font-variant-numeric: tabular-nums; }
.charges { position: absolute; right: 0.25em; bottom: 0.1em; font-size: 0.7em; font-weight: 800; }
.keys { position: absolute; left: 0.15em; top: 0.15em; display: flex; gap: 0.15em; }
.keys kbd { font-size: 0.6em; }
.name { position: absolute; left: 0; right: 0; bottom: -1.3em; text-align: center; font-size: 0.6em; white-space: nowrap; }
.ready { border-color: rgba(255, 217, 90, 0.8); }
`, `<div ${ROOT} data-show="shown">
  <div class="bar">
    <div data-each="slots"><template>
      <div class="slot panel" data-class-ready="ready">
        <img class="image" alt="" data-show="image" data-attr-src="image">
        <span class="icon" data-hide="image" data-bind="icon"></span>
        <span class="cool" data-style-height="fill"></span>
        <span class="secs" data-bind="seconds"></span>
        <span class="charges" data-show="show_charges" data-bind="charges"></span>
        <span class="keys" data-each="keys"><template><kbd data-class-pad="pad" data-class-touch="touch" data-attr-data-code="code" data-bind="text"></kbd></template></span>
      </div>
    </template></div>
  </div>
</div>`),

  'builtin:hud/combo.html': panel(`
.combo { position: absolute; right: 1.2em; top: 42%; text-align: right; }
.count { font: 900 2.4em/1 system-ui, sans-serif; color: #ffd95a; text-shadow: 0 2px 6px #000; animation: pp-bump 0.18s ease-out; }
.count::before { content: "×"; font-size: 0.6em; margin-right: 0.08em; }
.window { margin-top: 0.3em; margin-left: auto; width: 6em; height: 0.3em; background: rgba(255, 255, 255, 0.2); border-radius: 0.15em; overflow: hidden; }
.window i { display: block; height: 100%; background: #ffd95a; }
.best { font-size: 0.65em; opacity: 0.75; margin-top: 0.2em; }
@keyframes pp-bump { from { transform: scale(1.25); } }
`, `<div ${ROOT} data-show="shown">
  <div class="combo">
    <div class="count" data-bind="count"></div>
    <div class="window"><i data-style-width="fill"></i></div>
    <div class="best">best <span data-bind="best"></span></div>
  </div>
</div>`),

  'builtin:hud/key_hints.html': panel(`
.hints { position: absolute; right: 1em; bottom: 1em; display: grid; gap: 0.3em; padding: 0.45em 0.7em; }
.hint { display: flex; align-items: center; justify-content: flex-end; gap: 0.5em; font-size: 0.85em; }
.keys { display: flex; gap: 0.2em; }
`, `<div ${ROOT} data-show="shown">
  <div class="hints panel">
    <div data-each="hints"><template>
      <div class="hint"><span class="keys" data-each="keys"><template><kbd data-class-pad="pad" data-class-touch="touch" data-attr-data-code="code" data-bind="text"></kbd></template></span><span data-bind="label"></span></div>
    </template></div>
  </div>
</div>`),

  'builtin:hud/interact_prompt.html': panel(`
.prompt { position: absolute; transform: translate(-50%, -120%); display: flex; align-items: center; gap: 0.5em; padding: 0.35em 0.7em;
  white-space: nowrap; animation: pp-in 0.15s ease-out; }
.prompt:not(.anchored) { transform: translate(-50%, 0); }
.keys { position: relative; display: flex; gap: 0.2em; }
.ring { position: absolute; left: -0.25em; top: -0.25em; right: -0.25em; bottom: -0.25em; border-radius: 0.4em; overflow: hidden; }
.ring i { position: absolute; left: 0; bottom: 0; height: 0.2em; background: #ffd95a; }
.text { font-weight: 600; }
@keyframes pp-in { from { opacity: 0; } }
`, `<div ${ROOT} data-show="shown">
  <div class="prompt panel" data-class-anchored="anchored" data-style-left="x" data-style-top="y">
    <span class="keys">
      <span class="ring" data-show="hold"><i data-style-width="fill"></i></span>
      <span data-each="keys"><template><kbd data-class-pad="pad" data-class-touch="touch" data-attr-data-code="code" data-bind="text"></kbd></template></span>
    </span>
    <span class="text" data-bind="text"></span>
  </div>
</div>`),
};
