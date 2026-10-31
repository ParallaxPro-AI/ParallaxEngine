"""Demo host for the shelf model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="shelf_demo", title="shelf demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
