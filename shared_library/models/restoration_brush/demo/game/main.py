"""Demo host for the restoration_brush model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="restoration_brush_demo", title="restoration_brush demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
