"""Demo host for the house_roof_gable model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="house_roof_gable_demo", title="house_roof_gable demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
