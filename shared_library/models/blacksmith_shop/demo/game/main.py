"""Demo host for the blacksmith_shop model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="blacksmith_shop_demo", title="blacksmith_shop demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
