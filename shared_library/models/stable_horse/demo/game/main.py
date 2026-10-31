"""Demo host for the stable_horse model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="stable_horse_demo", title="stable_horse demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
