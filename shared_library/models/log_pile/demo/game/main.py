"""Demo host for the log_pile model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="log_pile_demo", title="log_pile demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
