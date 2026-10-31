"""Demo host for the portable_toilet model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="portable_toilet_demo", title="portable_toilet demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
