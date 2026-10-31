"""Demo host for the overhead_crane_rail model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="overhead_crane_rail_demo", title="overhead_crane_rail demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
