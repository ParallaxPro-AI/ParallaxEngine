"""Demo host for the hot_dog_cart model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="hot_dog_cart_demo", title="hot_dog_cart demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
