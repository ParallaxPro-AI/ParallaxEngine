"""Demo host for the signal_fire model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="signal_fire_demo", title="signal_fire demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
