"""Demo host for the car_jack_trolley model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="car_jack_trolley_demo", title="car_jack_trolley demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
