"""Demo host for the scorpion_giant model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="scorpion_giant_demo", title="scorpion_giant demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
