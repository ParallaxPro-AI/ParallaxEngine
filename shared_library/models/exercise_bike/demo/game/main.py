"""Demo host for the exercise_bike model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="exercise_bike_demo", title="exercise_bike demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
