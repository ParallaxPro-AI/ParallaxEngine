"""Demo host for the kitchen_bin model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="kitchen_bin_demo", title="kitchen_bin demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
