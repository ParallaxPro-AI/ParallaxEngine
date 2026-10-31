"""Demo host for the mine_track model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="mine_track_demo", title="mine_track demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
