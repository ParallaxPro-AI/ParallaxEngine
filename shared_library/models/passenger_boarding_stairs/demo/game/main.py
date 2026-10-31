"""Demo host for the passenger_boarding_stairs model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="passenger_boarding_stairs_demo", title="passenger_boarding_stairs demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
