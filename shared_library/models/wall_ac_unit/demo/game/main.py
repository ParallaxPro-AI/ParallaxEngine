"""Demo host for the wall_ac_unit model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="wall_ac_unit_demo", title="wall_ac_unit demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
