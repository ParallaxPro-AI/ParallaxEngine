"""Demo host for the light_aircraft model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="light_aircraft_demo", title="light_aircraft demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
