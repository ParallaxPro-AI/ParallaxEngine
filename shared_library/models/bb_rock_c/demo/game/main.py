"""Demo host for the bb_rock_c model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="bb_rock_c_demo", title="bb_rock_c demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
