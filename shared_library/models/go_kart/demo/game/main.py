"""Demo host for the go_kart model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="go_kart_demo", title="go_kart demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
