"""Demo host for the neon_sign model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="neon_sign_demo", title="neon_sign demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
