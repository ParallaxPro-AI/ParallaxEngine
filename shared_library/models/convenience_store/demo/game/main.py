"""Demo host for the convenience_store model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="convenience_store_demo", title="convenience_store demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
