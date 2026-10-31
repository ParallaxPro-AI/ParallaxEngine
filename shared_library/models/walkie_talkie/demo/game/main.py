"""Demo host for the walkie_talkie model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="walkie_talkie_demo", title="walkie_talkie demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
