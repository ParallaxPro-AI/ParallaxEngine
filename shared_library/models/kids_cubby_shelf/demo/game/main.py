"""Demo host for the kids_cubby_shelf model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="kids_cubby_shelf_demo", title="kids_cubby_shelf demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
