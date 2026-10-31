"""Demo host for the mine_track_curve model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="mine_track_curve_demo", title="mine_track_curve demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
