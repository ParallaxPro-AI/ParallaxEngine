"""Demo host for the tuba model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="tuba_demo", title="tuba demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
