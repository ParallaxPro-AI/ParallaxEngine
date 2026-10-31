"""Demo host for the skate_rail_grind model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="skate_rail_grind_demo", title="skate_rail_grind demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
