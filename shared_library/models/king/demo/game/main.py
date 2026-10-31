"""Demo host for the king model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="king_demo", title="king demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
