"""Demo host for the watchtower_military model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="watchtower_military_demo", title="watchtower_military demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
