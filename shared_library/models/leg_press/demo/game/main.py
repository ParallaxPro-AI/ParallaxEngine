"""Demo host for the leg_press model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="leg_press_demo", title="leg_press demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
