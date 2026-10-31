"""Demo host for the viking_longship model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="viking_longship_demo", title="viking_longship demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
