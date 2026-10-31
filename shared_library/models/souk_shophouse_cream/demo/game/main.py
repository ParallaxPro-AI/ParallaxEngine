"""Demo host for the souk_shophouse_cream model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="souk_shophouse_cream_demo", title="souk_shophouse_cream demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
