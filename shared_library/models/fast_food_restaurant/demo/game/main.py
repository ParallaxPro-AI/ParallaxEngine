"""Demo host for the fast_food_restaurant model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="fast_food_restaurant_demo", title="fast_food_restaurant demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
