"""Demo host for the ramen_bowl model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="ramen_bowl_demo", title="ramen_bowl demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
