"""The entry point: the one `Game(...)` the engine starts.

Systems (game-wide logic) are listed here; behaviors (per-entity logic, like
`game/behaviors/player.py`) are attached by id in prefab files instead."""

from parallax import Game, plugins
from project import Scenes

game = Game(
    id="{{id}}",
    title="{{title}}",
    sdk="1.0",
    mode="3d",
    # Physics is on from the start: library model prefabs carry colliders and rigidbodies.
    plugins=[plugins.physics3d()],
    systems=[],
    start_scene=Scenes.main,
)
