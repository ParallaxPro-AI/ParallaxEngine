"""Demo host for the shopping_basket model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="shopping_basket_demo", title="shopping_basket demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
