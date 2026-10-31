"""Demo host for the snowboard_rail model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="snowboard_rail_demo", title="snowboard_rail demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
