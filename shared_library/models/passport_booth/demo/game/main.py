"""Demo host for the passport_booth model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="passport_booth_demo", title="passport_booth demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
