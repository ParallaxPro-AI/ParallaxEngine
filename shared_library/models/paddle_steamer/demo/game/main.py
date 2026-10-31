"""Demo host for the paddle_steamer model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="paddle_steamer_demo", title="paddle_steamer demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
