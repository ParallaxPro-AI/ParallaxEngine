"""Demo host for the diver_scuba model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="diver_scuba_demo", title="diver_scuba demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
