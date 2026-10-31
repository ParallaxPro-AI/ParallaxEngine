"""Demo host for the shoe_wall_display model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="shoe_wall_display_demo", title="shoe_wall_display demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
