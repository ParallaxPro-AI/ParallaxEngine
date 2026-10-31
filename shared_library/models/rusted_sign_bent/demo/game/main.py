"""Demo host for the rusted_sign_bent model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="rusted_sign_bent_demo", title="rusted_sign_bent demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
