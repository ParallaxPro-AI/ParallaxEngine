"""Demo host for the mouse_critter model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="mouse_critter_demo", title="mouse_critter demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
