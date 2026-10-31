"""Demo host for the hesco_barrier model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="hesco_barrier_demo", title="hesco_barrier demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
