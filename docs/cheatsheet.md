# Cheatsheet

The most-used APIs and file formats for a 3D game, on one page. Every snippet
below belongs to one small working game ("Coin Hunt"): a library knight walks a
field collecting library coins against a clock. Follow the links for depth;
exact signatures are in the [API reference](reference/README.md).

## Command-line loop

Run these from the engine checkout ([CLI reference](cli.md)):

```sh
pnpm parallax new ../coin_hunt --template blank-3d --name "Coin Hunt"
pnpm parallax library search gold coin               # find models and pieces by words
pnpm parallax library add knight humanoid_locomotion coin ../coin_hunt
pnpm parallax check ../coin_hunt                     # transpile + validate; fix every error
pnpm parallax test ../coin_hunt                      # headless playtests
pnpm parallax edit ../coin_hunt                      # browser editor; Play runs the game
```

`library add` copies prefabs, models and clips into the project and adds the
plugins they need to `game/main.py`. `pnpm parallax library list` prints all of
the roughly 2,300 pieces. Use them before building anything from primitive
shapes; see [Making a game look good](concepts/visuals.md).

## Project layout

```text
game/main.py                 Game(...) entry point     game/actions.py   input actions
game/behaviors/*.py          per-entity logic          game/systems/*.py game-wide logic
game/components.py           components and tags       game/resources.py shared state
game/events.py               events                    game/ui.py        panels
prefabs/<id>.prefab.json     reusable entities         scenes/<id>/scene.json  placements, sky, terrain
ui/<name>.html               panel markup              locale/en.json    interface text
assets/{models,clips,sfx,music,vfx,images}/            tests/test_*.py   playtests
```

`parallax check` generates the `project` module: `Prefabs.hero`, `Scenes.main`,
`Placed.player`, `Assets.sfx.hit`, `Text.score`. See [project layout](concepts/project-layout.md).

## Game and plugins

`game/main.py` exports `game`. A component type or `ctx` namespace exists only
when its plugin is listed ([plugin list](reference/parallax.plugins.md)).

```python
from parallax import Game, plugins
from project import Scenes

from game.systems.scoring import Scoring

game = Game(
    id="coin_hunt",
    title="Coin Hunt",
    sdk="1.0",
    mode="3d",
    plugins=[plugins.physics3d(), plugins.characters()],
    systems=[Scoring],
    start_scene=Scenes.main,
)
```

## Data: tags, resources and events

```python
# game/components.py
from parallax import tag

Player = tag("player")
Coin = tag("coin")
```

```python
# game/resources.py
from parallax import field, resource


@resource("run")
class Run:
    coins: int = field(0)
    time_left: float = field(60.0)


@resource("best", keep="profile")      # saved on the device
class Best:
    coins: int = field(0)


def run_over(ctx) -> bool:
    return ctx.get(Run).time_left <= 0
```

```python
# game/events.py
from parallax import event


@event("coin_collected")
class CoinCollected:
    points: int
```

Use `@component("id")` for per-entity data and `@config("id")` for tunables in
`config/<id>.json`. See [data](concepts/data.md).

## Input actions

```python
# game/actions.py
from parallax import Actions, axis2, button, gamepad, keys, mouse, touch


class Controls(Actions):
    move = axis2(keyboard=keys.WASD | keys.ARROWS, gamepad=gamepad.LEFT_STICK, touch=touch.joystick("left"))
    look = axis2(mouse=mouse.DELTA, gamepad=gamepad.RIGHT_STICK, touch=touch.LOOK)
    jump = button(keyboard="Space", gamepad=gamepad.SOUTH, touch=touch.button("Jump"))
```

Read with `ctx.input.axis(Controls.move)`, `pressed`, `held`, `released` or
`value`. A mouse-look axis turns `orbit` and `first_person` camera rigs. See
[input](concepts/input.md).

## Behavior

A behavior is per-entity logic, attached by id in a prefab's `behaviors` map.

```python
# game/behaviors/player.py
from parallax import Behavior, Effect, behavior, on, param
from parallax.characters import Character, Landed

from game.actions import Controls


@behavior("player", requires=[Character])
class PlayerControl(Behavior):
    sprint_speed: float = param(7.0, unit="m/s")   # set per prefab

    def update(self, ctx, dt):
        character = self.entity.get(Character)
        stick = ctx.input.axis(Controls.move)
        character.move(ctx.camera.main.relative(stick))  # camera-relative walking
        if ctx.input.pressed(Controls.jump):
            character.jump()

    @on(Landed)
    def landed(self, ctx, event: Landed):
        ctx.vfx.play(Effect.dust, at=self.entity)
```

The hooks are `start(ctx)`, `update(ctx, dt)`, `fixed_update(ctx, dt)`,
`late_update(ctx, dt)` and `end(ctx)`. Behaviors may only declare `param()` and
`state()` fields. See [logic](concepts/logic.md).

## System, events and spawning

A system is game-wide logic with no fields. It keeps state in resources.

```python
# game/systems/scoring.py
import random

from parallax import Effect, Synth, System, TriggerEntered, on, system, vec3
from project import Prefabs, Scenes

from game.components import Coin, Player
from game.events import CoinCollected
from game.resources import Best, Run, run_over


def touches_coin(event: TriggerEntered) -> bool:
    return event.entity.has(Coin) and event.target.has(Player)


@system("scoring", scenes=[Scenes.main], when=lambda ctx: not run_over(ctx))
class Scoring(System):
    def start(self, ctx):
        for _ in range(10):    # `random` is seeded by the engine
            spot = vec3(random.uniform(-9, 9), 0.5, random.uniform(-9, 9))
            ctx.world.spawn(Prefabs.gold_coin, at=spot)

    def update(self, ctx, dt):
        run = ctx.get(Run)
        run.time_left -= dt
        if run.time_left <= 0:
            best = ctx.get(Best)
            best.coins = max(best.coins, run.coins)

    @on(TriggerEntered, where=touches_coin)
    def picked(self, ctx, event: TriggerEntered):
        ctx.vfx.play(Effect.sparkle, at=event.entity)
        ctx.audio.play(Synth.pickup, at=event.entity)
        event.entity.destroy()
        ctx.emit(CoinCollected(points=1))

    @on(CoinCollected)
    def counted(self, ctx, event: CoinCollected):
        ctx.get(Run).coins += event.points
```

| Task | Call |
|---|---|
| Spawn | `ctx.world.spawn(Prefabs.x, at=pos, rotation=yaw, parent=e)` |
| Find a placed entity | `ctx.world.placed(Placed.player)` |
| Query | `ctx.world.query(Health, tagged=Enemy)` yields `(entity, health)`; `.nearest(p)`, `.near(p, r)` |
| Read or change a component | `entity.get(Rigidbody).impulse(v)`, `entity.has(Coin)`, `entity.add(...)` |
| Remove | `entity.destroy()` or `entity.destroy(after=0.5)` |
| Change scene | `ctx.scenes.load(Scenes.level2)`, `ctx.scenes.reload(new_run=True)` |
| Collisions | `@on(Collided)`, `@on(TriggerEntered)`; a trigger is a collider with `"trigger": true` |

## Prefabs

Library prefabs carry a model and a fitted collider. Extend one rather than
editing it, or reference its model from a prefab of your own.
`prefabs/gold_coin.prefab.json` makes a trigger version of the library coin:

```json
{
  "extends": "coin",
  "components": {
    "collider": { "shape": "sphere", "radius": 0.6, "trigger": true }
  },
  "tags": ["coin"]
}
```

`prefabs/hero.prefab.json` is the player, built on the library knight:

```json
{
  "components": {
    "model": { "model": "models/knight", "cast_shadows": true },
    "character": { "walk_speed": 4, "run_speed": 7, "jump_height": 1.2 },
    "animator": {}
  },
  "tags": ["player"],
  "behaviors": { "player": { "sprint_speed": 7 } }
}
```

An empty `animator` on a `Character` plays idle, walk, run and jump clips on its
own. The rig needs clips, such as those from the `humanoid_locomotion` piece. A
moving physics body adds `"rigidbody": {"kind": "dynamic", "mass": 2}`; a static
wall needs only a `collider`. If the library has no fitting model, write an
`assets/models/<name>.model.json` document instead of stacking shapes; see
[authoring a model](concepts/visuals.md#authoring-a-model-the-library-lacks).
See [scenes and entities](concepts/world.md) and
[physics](reference/parallax.physics.md).

## Scene and camera

`scenes/main/scene.json` places the entities and sets the sky:

```json
{
  "ui": ["hud"],
  "environment": { "sky": "atmosphere", "time_of_day": 15 },
  "entities": [
    { "prefab": "camera", "components": { "camera": { "follow": "player" } } },
    { "prefab": "sun", "rotation": [50, 30, 0] },
    { "prefab": "ground" },
    { "id": "player", "prefab": "hero", "at": [0, 1, 0] },
    { "prefab": "coin", "at": [3, 0.5, 4] }
  ]
}
```

`prefabs/camera.prefab.json` is a third-person orbit camera:

```json
{
  "components": {
    "camera": { "rig": "orbit", "fov": 60, "offset": [0, 1.6, -4], "pitch": -20, "pitch_limits": [-60, 20] }
  }
}
```

Rigs are `fixed`, `follow` (trails at `offset`; add `look_ahead` for
side-scrollers), `orbit` and `first_person`. Camera pitch is positive looking
up. Shake with `ctx.camera.main.shake(0.2, 0.3)`. Outdoors, replace the flat
ground with terrain, foliage and weather; see [visuals](concepts/visuals.md).

## UI panel

```python
# game/ui.py
from parallax import Panel, reload_scene, ui

from game.resources import Best, Run, run_over


@ui("hud", html="ui/hud.html")
class Hud(Panel):
    def state(self, ctx):
        run = ctx.get(Run)
        return {"coins": run.coins, "time_left": run.time_left}


@ui("game_over", html="ui/game_over.html", modal=True, layer="menu", when=run_over)
class GameOver(Panel):
    actions = {"retry": reload_scene(new_run=True)}

    def state(self, ctx):
        return {"coins": ctx.get(Run).coins, "best": ctx.get(Best).coins}
```

```html
<!-- ui/hud.html -->
<div class="hud">
  <span data-text="coins_label"></span> <span data-bind="coins"></span>
  <span data-bind="time_left" data-format="time"></span>
</div>
```

`data-text` reads `locale/en.json` (`{"coins_label": "Coins", ...}`); `data-bind`
reads `state()`. Also: `data-show`, `data-each`, `data-action`, and `ctx.ui.toast`,
`ctx.ui.announce` and `ctx.ui.float_text`. See [UI](concepts/ui.md).

## Timers and tasks

| Need | Use |
|---|---|
| Gameplay deadline that survives saves | `self.ready_at = ctx.time.now + 2`, then `if ctx.time.now >= self.ready_at` |
| Cooldown ticked by its owner | `reload: Timer = state(Timer.cooldown(0.5))`, then `.tick(dt)`, `.done`, `.restart()` |
| A sequence of waits | `ctx.run(fn)` with `async def fn(ctx, task): await task.seconds(1)` |
| Cosmetic follow-up | `ctx.time.after(0.3, lambda: ...)`, `ctx.time.every(...)` |
| Juice | `ctx.time.hitstop(0.05)`, `ctx.time.ramp(0.3, 0.5)` for slow motion |

## Audio and effects

```python
ctx.audio.play(Synth.hit_metal, at=entity)       # built-in synthesized sound
ctx.audio.play(Assets.sfx.hit)                   # assets/sfx/hit.ogg or hit.synth.json
ctx.audio.music(Assets.music.theme)              # or "music": "music/theme" in scene.json
ctx.vfx.play(Effect.impact, at=pos, scale=0.6)   # built-in effect sized to the hit; or Assets.vfx.<name>
ctx.vfx.trail(entity, glow=True)                 # ribbon behind a moving entity
```

Built-in effects are `impact`, `dust`, `sparks`, `sparkle`, `smoke`, `fire`,
`embers`, `magic`, `muzzle_flash` and `explosion`. Match the effect to what
happens, at its size; `explosion` (light, shake, haze) is only for things that blow up. Continuous ones go on a prefab:
`"particles": {"effect": "effect/fire", "emitting": true}`. See
[visuals](concepts/visuals.md#particles-and-effects) and [assets](concepts/assets.md).

## Playtest

```python
# tests/test_player.py
from parallax import vec2
from parallax.test import GameHarness, playtest
from project import Placed, Scenes

from game.actions import Controls
from game.resources import Run
from game.ui import GameOver


@playtest("the stick walks the hero forward")
async def test_walks(h: GameHarness):
    await h.start(scene=Scenes.main, seed=1)
    hero = h.world.placed(Placed.player)
    start = hero.transform.position
    await h.move(Controls.move, vec2(0, 1), seconds=1)
    assert hero.transform.position.z > start.z + 1


@playtest("the game ends when time runs out")
async def test_time_up(h: GameHarness):
    await h.start(scene=Scenes.main, seed=1)
    h.get(Run).time_left = 0.1
    await h.advance(seconds=0.5)
    assert h.is_open(GameOver)
```

Harness commands include `press`, `hold`, `move`, `click(Panel, "action")`,
`advance`, `advance_until`, `until(Event)`, `is_open`, `panel_state` and
`emitted`. See [testing](concepts/testing.md).

## Before writing it yourself

The engine provides terrain, foliage, sky, weather, water, buildings from floor
plans, race tracks, characters, vehicles, AI, HUD widgets, inventories and more.
These features are data on a scene or prefab, not code to write. Scan the
[capability catalog](concepts/visuals.md#capability-catalog) before starting a
system, and look up error codes in the [error catalog](errors/README.md).
