"""Demo host for the chicken_drumstick model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="chicken_drumstick_demo", title="chicken_drumstick demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
