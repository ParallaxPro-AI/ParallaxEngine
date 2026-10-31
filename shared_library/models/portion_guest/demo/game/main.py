"""Demo host for the portion_guest model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="portion_guest_demo", title="portion_guest demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
