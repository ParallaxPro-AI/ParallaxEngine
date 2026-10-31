"""Demo host for the watchtower_wood model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="watchtower_wood_demo", title="watchtower_wood demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
