"""Demo host for the can_set_food model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="can_set_food_demo", title="can_set_food demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
