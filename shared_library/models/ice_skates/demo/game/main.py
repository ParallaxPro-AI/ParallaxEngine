"""Demo host for the ice_skates model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="ice_skates_demo", title="ice_skates demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
