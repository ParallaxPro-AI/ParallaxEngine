"""Demo host for the tandem_rotor_helicopter model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="tandem_rotor_helicopter_demo", title="tandem_rotor_helicopter demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
