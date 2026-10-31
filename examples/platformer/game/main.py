"""Sky Hopper: The Lost Sky. A 3D platformer across four floating-island worlds."""

from parallax import Game
from parallax.plugins import characters, physics3d
from project import Scenes

from game.systems.checkpoints import Checkpoints
from game.systems.crumbles import Crumbles
from game.systems.dangers import Dangers
from game.systems.level import LevelRules
from game.systems.pickups import Pickups
from game.systems.records import Records
from game.systems.vault import LanternVault

game = Game(
    id="sky_hopper",
    title="Sky Hopper: The Lost Sky",
    sdk="1.0",
    mode="3d",
    # Arcade gravity, stated where everyone can see it: a 13.5 m/s jump peaks at ~2.3 m.
    plugins=[physics3d(gravity=-40), characters()],
    systems=[LevelRules, Pickups, Dangers, Checkpoints, Crumbles, LanternVault, Records],
    start_scene=Scenes.hub,
)
