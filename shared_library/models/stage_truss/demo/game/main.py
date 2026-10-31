"""Demo host for the stage_truss model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="stage_truss_demo", title="stage_truss demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
