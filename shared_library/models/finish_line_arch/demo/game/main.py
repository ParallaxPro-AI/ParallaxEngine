"""Demo host for the finish_line_arch model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="finish_line_arch_demo", title="finish_line_arch demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
