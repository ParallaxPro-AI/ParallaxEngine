"""Demo host for the lean_to_shelter model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="lean_to_shelter_demo", title="lean_to_shelter demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
