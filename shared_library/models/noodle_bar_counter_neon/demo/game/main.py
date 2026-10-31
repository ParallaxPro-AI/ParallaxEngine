"""Demo host for the noodle_bar_counter_neon model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="noodle_bar_counter_neon_demo", title="noodle_bar_counter_neon demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
