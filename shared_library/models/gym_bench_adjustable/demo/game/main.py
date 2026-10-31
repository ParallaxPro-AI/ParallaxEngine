"""Demo host for the gym_bench_adjustable model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="gym_bench_adjustable_demo", title="gym_bench_adjustable demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
