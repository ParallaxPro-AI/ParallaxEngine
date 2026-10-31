"""Demo host for the lunar_new_year_dragon_head model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="lunar_new_year_dragon_head_demo", title="lunar_new_year_dragon_head demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
