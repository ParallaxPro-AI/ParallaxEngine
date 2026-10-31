"""Demo host for the runway_windsock model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="runway_windsock_demo", title="runway_windsock demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
