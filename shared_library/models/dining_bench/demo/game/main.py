"""Demo host for the dining_bench model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="dining_bench_demo", title="dining_bench demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
