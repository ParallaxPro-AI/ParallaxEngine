"""Demo host for the cafeteria_table_bench model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="cafeteria_table_bench_demo", title="cafeteria_table_bench demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
