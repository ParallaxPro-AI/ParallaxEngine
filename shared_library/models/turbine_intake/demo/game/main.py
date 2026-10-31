"""Demo host for the turbine_intake model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="turbine_intake_demo", title="turbine_intake demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
