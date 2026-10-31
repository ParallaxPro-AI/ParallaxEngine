"""Demo host for the water_purifier_diy model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="water_purifier_diy_demo", title="water_purifier_diy demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
