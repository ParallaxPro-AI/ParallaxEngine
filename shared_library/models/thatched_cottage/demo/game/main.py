"""Demo host for the thatched_cottage model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="thatched_cottage_demo", title="thatched_cottage demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
