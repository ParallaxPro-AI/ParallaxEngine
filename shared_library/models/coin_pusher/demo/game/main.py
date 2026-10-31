"""Demo host for the coin_pusher model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="coin_pusher_demo", title="coin_pusher demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
