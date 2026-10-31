"""Demo host for the projector_screen model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="projector_screen_demo", title="projector_screen demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
