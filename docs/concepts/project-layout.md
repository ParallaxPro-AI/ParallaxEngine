# Project layout

A game is a folder of Python code, JSON data, HTML panels, and assets. Its entry point
is `game/main.py`, which exports a variable named `game`:

```python
from parallax import Game
from project import Scenes

game = Game(
    id="my_game",
    title="My Game",
    sdk="1.0",
    mode="2d",
    start_scene=Scenes.play,
)
```

`parallax new` creates a working project. Organize additional files as the game grows;
there is no need to create every folder below.

```text
my_game/
  game/
    main.py                    Game entry point
    components.py              Per-entity data
    resources.py               Shared runtime state
    config.py                  Config schemas
    content.py                 Content schemas
    actions.py                 Input actions
    ui.py                      Panel definitions
    behaviors/                 Entity logic
    systems/                   Game-wide logic
  prefabs/<id>.prefab.json      Reusable entities
  scenes/<id>/scene.json        Scene placements and settings
  config/<id>.json              Tunable values
  content/<kind>/<id>.json      Content entries
  ui/<name>.html               Panel markup and styles
  locale/en.json               Interface text
  assets/                      Images, models, audio, effects, clips
  tests/test_*.py              Playtests and rules tests
```

Python modules can be combined or split as needed. Subfolders may include
`__init__.py`; the transpiler also supports packages without it. Larger games can use
`features/<id>/` to group code and data, with dependencies declared through `Feature`.
See the [core API](../reference/parallax.md) for `Game` and `Feature`.

## Generated references

`parallax check <dir>` generates a `project` module from the files in the game.
Import its handles in Python instead of spelling references as strings:

| Python handle | Source |
|---|---|
| `Prefabs.player` | `prefabs/player.prefab.json` |
| `Scenes.play` | `scenes/play/scene.json` |
| `Placed.player` | A scene placement with `"id": "player"` |
| `Assets.sfx.hit` | A sound under `assets/sfx/` |
| `Content.enemy.scout` | `content/enemy/scout.json` |
| `Text.score` | The `score` key in `locale/en.json` |
| `Dialogue.intro` | `story/intro.yarn` |
| `WorldLayers.downtown` | A layer in a scene's `world.json` |

JSON references use ids or [asset handles](assets.md), according to the field. For example, a scene
placement uses `"prefab": "player"`; Python uses `Prefabs.player`. File ids use
`snake_case`. The checker reports missing references after a rename.

Config documents have no generated handle: read them with `ctx.config(ConfigClass)`.
The [project API](../reference/project.md) describes the generated module in full.

## Build output

By default, checking and building write generated files under `build/`, including
transpiled JavaScript and `project.pyi`. Edit the source files, and exclude `build/`
from version control. The [CLI reference](../cli.md) covers output options.

Next: [data](data.md), [logic](logic.md), [scenes and entities](world.md),
[assets](assets.md), and [testing](testing.md).
