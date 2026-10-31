"""Lawn Defenders: hold a back garden against five lanes of husks."""

from parallax import Game
from parallax.plugins import combat, grid, hud, physics3d
from project import Scenes

from game.layers import Layers
from game.systems.checkpoints import Checkpoints
from game.systems.economy import Economy
from game.systems.outcome import Outcome
from game.systems.placement import Placement
from game.systems.tools import Tools
from game.systems.waves import Waves

game = Game(
    id="lane_defense",
    title="Lawn Defenders",
    sdk="1.0",
    mode="3d",
    start_scene=Scenes.title,
    plugins=[physics3d(layers=Layers), combat(), grid(), hud()],
    systems=[Tools, Placement, Economy, Waves, Outcome, Checkpoints],
)
