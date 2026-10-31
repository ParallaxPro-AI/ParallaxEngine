# Input

Declare what the player can do as actions, then bind devices to those actions.
Gameplay reads `Controls.move` or `Controls.jump` rather than keyboard codes.
This keeps keyboard, gamepad, touch and remapped controls on the same path.

## Declare and read actions

In `game/actions.py`:

```python
from parallax import Actions, axis2, button, gamepad, keys, touch


class Controls(Actions):
    move = axis2(
        keyboard=keys.WASD | keys.ARROWS,
        gamepad=gamepad.LEFT_STICK,
        touch=touch.joystick("left"),
    )
    jump = button(
        keyboard="Space",
        gamepad=gamepad.SOUTH,
        touch=touch.button("Jump"),
    )
```

Read these from a behavior or system through `ctx.input`:

| Declaration | Read | Result |
|---|---|---|
| `button(...)` | `pressed`, `held`, `released` | Button state |
| `axis1(...)` | `value` | Number from −1 to 1 |
| `axis2(...)` | `axis` | `Vec2` |
| `button_group(...)` | `pressed_index` | Zero-based slot, or `None` |

For example, `ctx.input.axis(Controls.move)` reads movement and
`ctx.input.pressed(Controls.jump)` detects a press. A press remains visible for the
frame; reading it does not consume it. `repeat=` adds repeated presses while held.
For a grid cursor, use `pressed_direction` or `pressed_step` instead of moving once
on every frame an axis is nonzero.

Keyboard bindings use browser codes such as `KeyE`, `Space` and `ArrowUp`.
Reserve Escape for releasing the pointer; use another key for pause or inventory.

## When controls are active

An action set can declare `scenes` and `active_when(ctx, owner)` to limit when it is
live. Use this for menus, vehicles or changing player modes. When live sets share
a physical input, a strictly higher `priority` claims it from lower-priority sets.

In a behavior attached to a player-owned entity, reads use that player's input.
System reads use the first seat; per-player controls belong on the owned entity.
See [local multiplayer](../reference/parallax.plugins.md#local_players) and
[networking](../reference/parallax.net.md) for seat and ownership setup.

Touch bindings create controls while their action set is live. A `touch_preset`
such as `"fps"` or `"platformer"` fills in bindings left unspecified; explicit
`touch=` wins, and `touch.NONE` opts an action out. Modal panels mute gameplay
actions and hide these controls; see [UI](ui.md).

## Pointer, text and menus

`ctx.input.pointer` exposes screen/world position, button state and the entity
under the pointer. Panel clicks do not reach the world. Reading `pointer.over` on
a pressed frame consumes a hit on an entity so a mouse-bound action does not also
fire; `pointer.consume()` handles other world-click cases.

Use `ctx.input.text` for typed characters. Use HTML `data-key` for shortcuts on a
panel's buttons; use a `button_group` for hotkeys that also exist without a panel.
The built-in `SettingsPanel` provides control remapping.

See the [input API](../reference/parallax.md#input-actions) for bindings, pointer
queries and touch options, and [testing](testing.md) for simulated input.
