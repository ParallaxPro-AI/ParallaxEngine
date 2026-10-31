"""Demo host for the keyboard_mouse_set model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="keyboard_mouse_set_demo", title="keyboard_mouse_set demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
