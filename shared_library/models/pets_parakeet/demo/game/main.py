"""Demo host for the pets_parakeet model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="pets_parakeet_demo", title="pets_parakeet demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
