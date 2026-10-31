"""Demo host for the hay_bale model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="hay_bale_demo", title="hay_bale demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
