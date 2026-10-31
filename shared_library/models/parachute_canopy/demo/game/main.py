"""Demo host for the parachute_canopy model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="parachute_canopy_demo", title="parachute_canopy demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
