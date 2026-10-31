"""Demo host for the gold_bar model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="gold_bar_demo", title="gold_bar demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
