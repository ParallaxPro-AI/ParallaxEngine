"""Demo host for the civilian model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d, characters
from project import Scenes

game = Game(id="civilian_demo", title="civilian demo", sdk="1.0", mode="3d",
            plugins=[physics3d(), characters()], start_scene=Scenes.yard)
