# User interface

A panel combines HTML/CSS with a Python `Panel` class. Python supplies state and
actions; HTML declares how to display that state and which action a control invokes.

## A panel and its markup

In `game/ui.py`:

```python
from parallax import Panel, SettingsPanel, open_panel, ui


@ui("hud", html="ui/hud.html")
class Hud(Panel):
    actions = {"settings": open_panel(SettingsPanel)}

    def state(self, ctx):
        return {"elapsed": ctx.time.scene_time}
```

In `ui/hud.html`:

```html
<div class="hud">
  <span data-bind="elapsed" data-format="time"></span>
  <button data-action="settings" data-text="settings_label"></button>
</div>
```

Add `"settings_label": "Settings"` to `locale/en.json`, and include `"hud"` in a
scene's `"ui"` list. Style the panel with CSS in its HTML or a linked stylesheet.
`data-text` reads localized text; `data-bind` reads the dictionary returned by
`state()`. Keep `state()` a read of game state rather than a place to advance play.

For dynamic text, import `Text` from `project` and use
`ctx.text(Text.key, **args)` to fill a locale string's named placeholders before
returning it from `state()` or passing it to an announcement.

## Bindings and actions

The common bindings are:

| Attribute | Purpose |
|---|---|
| `data-bind="player.hp"` | Display a value; dotted paths read nested values |
| `data-show="ready"` / `data-hide="ready"` | Show or hide according to a value |
| `data-class-active="selected"` | Toggle a CSS class |
| `data-attr-src="portrait"` | Set an HTML attribute |
| `data-style-width="width"` | Set a CSS property |
| `data-each="items"` | Repeat a child `<template>` for each item |
| `data-action="pick"` | Invoke a named panel action |
| `data-key="Digit1"` | Give that action a keyboard shortcut |

Inside `data-each`, bindings refer to the current item. An action receives the
item's fields, with `data-*` attributes supplying explicit values. Match these names
to the action function's typed parameters. Declare `@action(when=...)` when an
action must be disabled by game state; hiding its button alone does not enforce
that condition.

`Panel.actions` maps names to command values, functions or event classes. Use
`load_scene(...)` / `reload_scene(...)` as command values in that map. A function
action changes scenes by calling `ctx.scenes.load(...)` / `reload(...)`; it may
return `open_panel(...)` or `close_panel()`, but not a scene command.

Panel JavaScript is optional. For custom widgets, the bridge exposes
`parallax.on_state(fn)` and `parallax.action(name, payload)`; gameplay remains in
Python.

## Visibility and modals

Choose one opening rule for each panel:

- List a persistent HUD or menu in a scene's `"ui"` array.
- Use `when=` for a panel that follows state, such as game over. Change the state to
  dismiss it; `close_panel()` is invalid for this kind of panel.
- Use `toggle_with=` for pause or inventory, or `while_held=` for a scoreboard.
- Use `open_panel(...)` from another panel, or `ctx.ui.open(...)` from game code,
  for a panel opened by a particular interaction.

`scenes=` limits a panel and its toggle action to matching scenes. `modal=True`
mutes gameplay input while open; it also freezes simulation time in games without
the net plugin. Online matches keep simulating. In mouse-look games the default
modal cursor is virtual, so the pointer can remain locked while the menu is usable.

Scene loads close existing panels and open those listed by the new scene. Use
`PlayerPanel` for one instance per player's viewport, and `ctx.ui.open(P, subject=e)`
for a panel about a specific entity; it closes if that entity is destroyed.

Panel viewport units and media queries follow the game view. Check layouts in the
editor and on narrow screens; use logical CSS properties for localized layouts.
See the [UI API](../reference/parallax.md#ui) for scaling, layers and full binding
options, and [testing](testing.md) for checking panel state and actions.
