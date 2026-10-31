"""Demo host for the dish_stack_dirty model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="dish_stack_dirty_demo", title="dish_stack_dirty demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
