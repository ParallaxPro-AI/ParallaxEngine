"""Demo host for the oil_drum_fire model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="oil_drum_fire_demo", title="oil_drum_fire demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
