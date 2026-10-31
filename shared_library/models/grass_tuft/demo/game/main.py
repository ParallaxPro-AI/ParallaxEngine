"""Demo host for the grass_tuft model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="grass_tuft_demo", title="grass_tuft demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
