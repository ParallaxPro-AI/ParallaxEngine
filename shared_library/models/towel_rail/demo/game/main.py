"""Demo host for the towel_rail model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="towel_rail_demo", title="towel_rail demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
