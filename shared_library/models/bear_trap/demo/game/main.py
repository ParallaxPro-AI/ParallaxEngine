"""Demo host for the bear_trap model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="bear_trap_demo", title="bear_trap demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
