"""Demo host for the taiko_drum model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="taiko_drum_demo", title="taiko_drum demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
